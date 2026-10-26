// The SurrealDB KIND REGISTRY (core-v2, docs/kind-registry-contract.md): the per-driver registry +
// The `table`/`index`/`event`/`function`/`access` engines. Core orchestrates generically over this registry
// (lower -> diff -> order -> emit); each engine delegates to the EXISTING fixed-slot primitives, so the
// Generic path is byte-exact with `surrealDriver.diff`:
//   - table.overwrite  -> `diffSnapshots` (the whole field + table-head ALTER engine, scoped to one table)
//   - index            -> recreate (the spine's remove+emit default == legacy `changeUp` for an index)
//   - event.overwrite  -> `overwriteStatement` (DEFINE EVENT OVERWRITE == legacy `changeUp` for an event)
//
// Registration ORDER is each kind's ordinal (the tie-break among independent objects): table (0) before
// Index (1) before event (2). index/event point `deps`+`owner` at their table, so the graph emits them
// AFTER and clusters them next to it. Fields are NESTED in the table object (substrate, not a kind).
//
// The registry IS the production path (Option-A flip): core orchestrates `lower`/`diff`/`emit`/order
// Generically over it, while the Struct-IR (`DbStructured`) + `diffSnapshots` stay the driver's
// INTERNAL clause-level engine the kinds delegate to.

import { KindRegistry, lowerSchema } from "../../core"
import { formatSurql } from "../cli/format"
import { EMPTY_SNAPSHOT } from "../cli/structure"
import { diffSnapshots } from "../cli/surreal-diff"
import { overwriteStatement, removeStatement } from "../ddl"

import { explodeSchema } from "./explode"

import type {
  PAccess,
  PAnalyzer,
  PEvent,
  PFunction,
  PIndex,
  PParam,
  PSequence,
  PTable,
} from "./portable"
import type { AnyTable, AuthoredDef, DiffItem, KindEngine, PortableObject, Ref } from "../../core"
import type { Snapshot } from "../cli/structure"
import type { DefineStatement } from "../ddl"

/** Statement key matching the legacy engine's `keyOf` (`kind:table:name`). */
const keyOf = (s: Pick<DefineStatement, "kind" | "name" | "table">) =>
  `${s.kind}:${s.table ?? ""}:${s.name}`

/** A one-table {@link Snapshot} (head + its fields) for the legacy `diffSnapshots` to diff. */
function snapOf(head: DefineStatement, fields: DefineStatement[]): Snapshot {
  const statements: Snapshot["statements"] = {}
  for (const s of [head, ...fields]) statements[keyOf(s)] = s
  return { version: 1, statements }
}

// --- table: structured, field-level diff inside `overwrite` -------------------------------------

const tableEngine: KindEngine<PTable, PTable> = {
    lower: (t) => t,
    emit: (t) => [t.head.ddl, ...t.fields.map((f) => f.ddl)],
    // REMOVE TABLE covers its fields (no orphan REMOVE FIELDs) — matches the legacy drop.
    remove: (t) => [removeStatement(t.head)],
    // The field + table-head delta IS the legacy engine: build both sides as one-table snapshots and
    // Take the up. The spine calls `overwrite(next, prev)` for the down, so this stays symmetric.
    overwrite: (prev, next) =>
      diffSnapshots(snapOf(prev.head, prev.fields), snapOf(next.head, next.fields)).up,
    deps: (t) => t.deps,
    // PER-FIELD display (Manuel's call): the table's diff items are its head + per-field statements
    // (each carrying its `table` so the display groups under it) — exactly `diffSnapshots().items`.
    // `full` uses displayItems(undefined, next) -> the per-field add items.
    displayItems: (prev, next): DiffItem[] =>
      diffSnapshots(
        prev ? snapOf(prev.head, prev.fields) : EMPTY_SNAPSHOT,
        next ? snapOf(next.head, next.fields) : EMPTY_SNAPSHOT,
      ).items ?? [],
  },
  // --- index: own kind, owned by its table, recreated on change -----------------------------------

  indexEngine: KindEngine<PIndex, PIndex> = {
    lower: (i) => i,
    emit: (i) => [i.stmt.ddl],
    remove: (i) => [removeStatement(i.stmt)],
    // No `overwrite` -> the spine recreates (remove + emit): `REMOVE INDEX … ; DEFINE INDEX …`,
    // Exactly the legacy `changeUp` for an index (ALTER INDEX can't change fields/kind).
    // -> its table (owner) + a FULLTEXT index's analyzer (so the analyzer emits first).
    deps: (i) => i.deps,
    owner: (i) => ({ kind: "table", name: i.table }),
  },
  // --- event: own kind, owned by its table, OVERWRITE on change -----------------------------------

  eventEngine: KindEngine<PEvent, PEvent> = {
    lower: (e) => e,
    emit: (e) => [formatSurql(e.stmt.ddl)],
    remove: (e) => [removeStatement(e.stmt)],
    // DEFINE EVENT OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for an event.
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    // -> its table (owner) + any `fn::` the WHEN/THEN call (so the function emits first).
    deps: (e) => e.deps,
    owner: (e) => ({ kind: "table", name: e.table }),
  },
  // --- function / access: db-level OPAQUE kinds, OVERWRITE on change -------------------------------

  functionEngine: KindEngine<PFunction, PFunction> = {
    lower: (f) => f,
    // Emit/overwrite outputs are PRETTY-PRINTED (display + migrations); comparisons run on the
    // Portable objects' canonical text upstream, and the legacy diff formats identically (parity).
    emit: (f) => [formatSurql(f.stmt.ddl)],
    remove: (f) => [removeStatement(f.stmt)],
    // DEFINE FUNCTION OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for a function.
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    // Other `fn::` its body calls (db-level, no owner cluster).
    deps: (f) => f.deps,
  }

/**
 * Whether an access can be MIGRATION-MANAGED. The canonical `DEFINE ACCESS` omits the signing KEY
 * (SurrealDB redacts it on read), so a key-bearing `TYPE JWT` can't round-trip a committed migration —
 * re-applying would rotate the key — and stays out-of-band via `sc access push/diff/rotate`. Key-free
 * access round-trips and rides migrations (still gated by `--access`):
 *   - `TYPE RECORD` — its session JWT is auto-generated by SurrealDB (no authored key);
 *   - `TYPE JWT` via a JWKS `URL` — no key material;
 *   - `TYPE BEARER` — the grant secret is server-generated.
 * (`TYPE RECORD … WITH JWT KEY` is canonicalized key-free on both sides — the canonical form drops
 * the clause — so it's treated as managed; faithful WITH JWT round-tripping is a tracked gap.)
 */
function isManagedAccess(a: PAccess): boolean {
  const k = a.native.kind
  if (k.kind === "JWT") return Boolean(k.jwt?.verify?.url)
  return true
}

const accessEngine: KindEngine<PAccess, PAccess> = {
    lower: (a) => a,
    emit: (a) => [formatSurql(a.stmt.ddl)],
    remove: (a) => [removeStatement(a.stmt)],
    // DEFINE ACCESS OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for an access.
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    // Any `fn::` the SIGNUP/SIGNIN/AUTHENTICATE call (db-level, no owner cluster).
    deps: (a) => a.deps,
    // Managed PER OBJECT: key-free access enters snapshots/migrations; key-bearing TYPE JWT is excluded
    // From snapshot/diff/gen (never phantom-diffs a redacted key) and managed out-of-band via the
    // `sc access push/diff/rotate/check` driver commands instead.
    excludeFromMigrations: (p) => !isManagedAccess(p as PAccess),
  },
  // --- param: db-level OPAQUE kind (functions/events may reference $param) -------------------------

  paramEngine: KindEngine<PParam, PParam> = {
    lower: (p) => p,
    emit: (p) => [formatSurql(p.stmt.ddl)],
    remove: (p) => [removeStatement(p.stmt)],
    // DEFINE PARAM OVERWRITE in place.
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    deps: (p) => p.deps,
  },
  // --- analyzer: db-level OPAQUE kind (a FULLTEXT index depends on it) -----------------------------

  analyzerEngine: KindEngine<PAnalyzer, PAnalyzer> = {
    lower: (a) => a,
    emit: (a) => [formatSurql(a.stmt.ddl)],
    remove: (a) => [removeStatement(a.stmt)],
    // DEFINE ANALYZER OVERWRITE in place.
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    deps: (a) => a.deps,
  },
  // --- sequence: db-level OPAQUE kind (read via `sequence::nextval`) -------------------------------

  sequenceEngine: KindEngine<PSequence, PSequence> = {
    lower: (s) => s,
    emit: (s) => [formatSurql(s.stmt.ddl)],
    remove: (s) => [removeStatement(s.stmt)],
    // DEFINE SEQUENCE OVERWRITE in place (changing BATCH/START/TIMEOUT re-declares it).
    overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
    deps: (s) => s.deps,
  }

/**
 * The SurrealDB driver's kind registry. Registration order == kind ordinal (the tie-break among
 * objects with no dependency relation): table < index < event < function < access. Correctness is the
 * dependency GRAPH (deps), not the ordinal — a `fn::`-called function still emits before its caller via
 * the function `deps` regardless of its ordinal.
 */
export const surrealKinds = new KindRegistry()

// `build` is the kind's authoring entry. At the wholesale flip these route the `s.*` authoring through
// The registry; for the facade-test phase the explode produces portable objects directly, so the builds
// Are the identity (the registry only needs the engine behavior registered here).
surrealKinds.define({ name: "table", build: (t: PTable) => t, ...tableEngine })
surrealKinds.define({ name: "index", build: (i: PIndex) => i, ...indexEngine })
surrealKinds.define({ name: "event", build: (e: PEvent) => e, ...eventEngine })
surrealKinds.define({
  name: "function",
  build: (f: PFunction) => f,
  ...functionEngine,
})
surrealKinds.define({
  name: "access",
  build: (a: PAccess) => a,
  // The generic pluralizer would make "access" -> "Accesses"/"accesses"; SurrealQL's noun is
  // Invariant ("Access") and the dir is `access/`, so pin both.
  display: { plural: "Access", folder: "access" },
  ...accessEngine,
})
surrealKinds.define({
  name: "analyzer",
  build: (a: PAnalyzer) => a,
  ...analyzerEngine,
})
surrealKinds.define({
  name: "param",
  build: (p: PParam) => p,
  ...paramEngine,
})
surrealKinds.define({
  name: "sequence",
  build: (s: PSequence) => s,
  ...sequenceEngine,
})

/** Author -> portable via the registry: explode tables/defs into per-kind objects, then lower each. */
export function lowerAll(tables: AnyTable[], defs: AuthoredDef[] = []): PortableObject[] {
  return lowerSchema(surrealKinds, explodeSchema(tables, defs))
}

export type { Ref }
