// The SurrealDB KIND REGISTRY (core-v2, docs/kind-registry-contract.md): the per-driver registry +
// the `table`/`index`/`event`/`function`/`access` engines. Core orchestrates generically over this registry
// (lower -> diff -> order -> emit); each engine delegates to the EXISTING fixed-slot primitives, so the
// generic path is byte-exact with `surrealDriver.diff`:
//   - table.overwrite  -> `diffSnapshots` (the whole field + table-head ALTER engine, scoped to one table)
//   - index            -> recreate (the spine's remove+emit default == legacy `changeUp` for an index)
//   - event.overwrite  -> `overwriteStatement` (DEFINE EVENT OVERWRITE == legacy `changeUp` for an event)
//
// Registration ORDER is each kind's ordinal (the tie-break among independent objects): table (0) before
// index (1) before event (2). index/event point `deps`+`owner` at their table, so the graph emits them
// AFTER and clusters them next to it. Fields nest them in the table object (substrate, not a kind).
//
// The registry IS the production path (Option-A flip): core orchestrates `lower`/`diff`/`emit`/order
// generically over it, while the Struct-IR (`DbStructured`) + `diffSnapshots` stay the driver's
// INTERNAL clause-level engine the kinds delegate to.

import {
  type AnyTable,
  type AuthoredDef,
  type DiffItem,
  type KindEngine,
  KindRegistry,
  lowerSchema,
  type PortableObject,
} from "../../core"
import { formatSurql } from "../cli/format"
import { EMPTY_SNAPSHOT, type Snapshot } from "../cli/structure"
import { diffSnapshots } from "../cli/surreal-diff"
import type { DefineStatement } from "../ddl"
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

/** Statement key matching the legacy engine's `keyOf` (`kind:table:name`). */
const keyOf = (s: Pick<DefineStatement, "kind" | "name" | "table">) =>
  `${s.kind}:${s.table ?? ""}:${s.name}`

/** A one-table {@link Snapshot} (head + its fields) for the legacy `diffSnapshots` to diff. */
function snapOf(head: DefineStatement, fields: DefineStatement[]): Snapshot {
  const statements: Snapshot["statements"] = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const s of [head, ...fields]) statements[keyOf(s)] = s

  return { statements, version: 1 }
}

// --- table: structured, field-level diff inside `overwrite` -------------------------------------

const tableEngine: KindEngine<PTable, PTable> = {
  deps: (t) => t.deps,
  // PER-FIELD display (Manuel's call): the table's diff items are its head + per-field statements
  // (each carrying its `table` so the display groups under it) — `diffSnapshots().items`.
  // `full` uses displayItems(undefined, next) -> the per-field add items.
  displayItems: (prev, next): DiffItem[] =>
    diffSnapshots(
      prev ? snapOf(prev.head, prev.fields) : EMPTY_SNAPSHOT,
      next ? snapOf(next.head, next.fields) : EMPTY_SNAPSHOT,
    ).items ?? [],
  emit: (t) => [t.head.ddl, ...t.fields.map((f) => f.ddl)],
  lower: (t) => t,
  // The field + table-head delta IS the legacy engine: build both sides as one-table snapshots and
  // take the up. The spine calls `overwrite(next, prev)` for the down, so this stays symmetric.
  overwrite: (prev, next) =>
    diffSnapshots(snapOf(prev.head, prev.fields), snapOf(next.head, next.fields)).up,
  // REMOVE TABLE covers its fields (no orphan REMOVE FIELDs) — matches the legacy drop.
  remove: (t) => [removeStatement(t.head)],
}

// --- index: own kind, owned by its table, recreated on change -----------------------------------

const indexEngine: KindEngine<PIndex, PIndex> = {
  // No `overwrite` -> the spine recreates (remove + emit): `REMOVE INDEX … ; DEFINE INDEX …`,
  // the legacy `changeUp` for an index (ALTER INDEX can't change fields/kind).
  // -> its table (owner) + a FULLTEXT index's analyzer (so the analyzer emits first).
  deps: (i) => i.deps,
  emit: (i) => [i.stmt.ddl],
  lower: (i) => i,
  owner: (i) => ({ kind: "table", name: i.table }),
  remove: (i) => [removeStatement(i.stmt)],
}

// --- event: own kind, owned by its table, OVERWRITE on change -----------------------------------

const eventEngine: KindEngine<PEvent, PEvent> = {
  // -> its table (owner) + any `fn::` the WHEN/THEN call (so the function emits first).
  deps: (e) => e.deps,
  emit: (e) => [formatSurql(e.stmt.ddl)],
  lower: (e) => e,
  // DEFINE EVENT OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for an event.
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  owner: (e) => ({ kind: "table", name: e.table }),
  remove: (e) => [removeStatement(e.stmt)],
}

// --- function / access: db-level OPAQUE kinds, OVERWRITE on change -------------------------------

const functionEngine: KindEngine<PFunction, PFunction> = {
  // Other `fn::` its body calls (db-level, no owner cluster).
  deps: (f) => f.deps,
  // Emit/overwrite outputs are PRETTY-PRINTED (display + migrations); comparisons run on the
  // portable objects' canonical text upstream, and the legacy diff formats identically (parity).
  emit: (f) => [formatSurql(f.stmt.ddl)],
  lower: (f) => f,
  // DEFINE FUNCTION OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for a function.
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  remove: (f) => [removeStatement(f.stmt)],
}

/**
 * Whether an access can be MIGRATION-MANAGED. The canonical `DEFINE ACCESS` omits the signing KEY
 * (SurrealDB redacts it on read), so a key-bearing `TYPE JWT` can't round-trip a committed migration —
 * re-applying would rotate the key — and stays out-of-band via `sc access push/diff/rotate`. Key-free
 * access round-trips and rides migrations (still gated by `--access`):
 *   - `TYPE RECORD` — its session JWT is auto-generated by SurrealDB (no authored key);
 *   - `TYPE JWT` via a JWKS `URL` — no key material;
 *   - `TYPE BEARER` — the grant secret is server-generated.
 * (`TYPE RECORD … WITH JWT KEY` canonicalizs it key-free on both sides — the canonical form drops
 * the clause — so it's treated as managed; faithful WITH JWT round-tripping is a tracked gap.)
 */
function isManagedAccess(a: PAccess): boolean {
  const k = a.native.kind
  if (k.kind === "JWT") return !!k.jwt?.verify?.url

  return true
}

const accessEngine: KindEngine<PAccess, PAccess> = {
  // Any `fn::` the SIGNUP/SIGNIN/AUTHENTICATE call (db-level, no owner cluster).
  deps: (a) => a.deps,
  emit: (a) => [formatSurql(a.stmt.ddl)],
  // Managed PER OBJECT: key-free access enters snapshots/migrations; key-bearing TYPE JWT excluds it
  // from snapshot/diff/gen (never phantom-diffs a redacted key) and managed out-of-band via the
  // `sc access push/diff/rotate/check` driver commands instead.
  excludeFromMigrations: (p) => !isManagedAccess(p as PAccess),
  lower: (a) => a,
  // DEFINE ACCESS OVERWRITE in place — matches the legacy `changeUp`/`changeDown` for an access.
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  remove: (a) => [removeStatement(a.stmt)],
}

// --- param: db-level OPAQUE kind (functions/events may reference $param) -------------------------

const paramEngine: KindEngine<PParam, PParam> = {
  deps: (p) => p.deps,
  emit: (p) => [formatSurql(p.stmt.ddl)],
  lower: (p) => p,
  // DEFINE PARAM OVERWRITE in place.
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  remove: (p) => [removeStatement(p.stmt)],
}

// --- analyzer: db-level OPAQUE kind (a FULLTEXT index depends on it) -----------------------------

const analyzerEngine: KindEngine<PAnalyzer, PAnalyzer> = {
  deps: (a) => a.deps,
  emit: (a) => [formatSurql(a.stmt.ddl)],
  lower: (a) => a,
  // DEFINE ANALYZER OVERWRITE in place.
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  remove: (a) => [removeStatement(a.stmt)],
}

// --- sequence: db-level OPAQUE kind (read via `sequence::nextval`) -------------------------------

const sequenceEngine: KindEngine<PSequence, PSequence> = {
  deps: (s) => s.deps,
  emit: (s) => [formatSurql(s.stmt.ddl)],
  lower: (s) => s,
  // DEFINE SEQUENCE OVERWRITE in place (changing BATCH/START/TIMEOUT re-declares it).
  overwrite: (_prev, next) => [formatSurql(overwriteStatement(next.stmt.ddl))],
  remove: (s) => [removeStatement(s.stmt)],
}

/**
 * The SurrealDB driver's kind registry. Registration order == kind ordinal (the tie-break among
 * objects with no dependency relation): table < index < event < function < access. Correctness is the
 * dependency GRAPH (deps), not the ordinal — a `fn::`-called function still emits before its caller via
 * the function `deps` regardless of its ordinal.
 */
export const surrealKinds = new KindRegistry()

// `build` is the kind's authoring entry. At the wholesale flip these route the `s.*` authoring through
// the registry; for the facade-test phase the explode produces portable objects directly, so the builds
// are the identity (the registry needs the engine behavior registered here).
surrealKinds.define({ build: (t: PTable) => t, name: "table", ...tableEngine })
surrealKinds.define({ build: (i: PIndex) => i, name: "index", ...indexEngine })
surrealKinds.define({ build: (e: PEvent) => e, name: "event", ...eventEngine })
surrealKinds.define({
  build: (f: PFunction) => f,
  name: "function",
  ...functionEngine,
})
surrealKinds.define({
  build: (a: PAccess) => a,
  // The generic pluralizer would make "access" -> "Accesses"/"accesses"; SurrealQL's noun is
  // invariant ("Access") and the dir is `access/`, so pin both.
  display: { folder: "access", plural: "Access" },
  name: "access",
  ...accessEngine,
})
surrealKinds.define({
  build: (a: PAnalyzer) => a,
  name: "analyzer",
  ...analyzerEngine,
})
surrealKinds.define({
  build: (p: PParam) => p,
  name: "param",
  ...paramEngine,
})
surrealKinds.define({
  build: (s: PSequence) => s,
  name: "sequence",
  ...sequenceEngine,
})

/** Author -> portable via the registry: explode tables/defs into per-kind objects, then lower each. */
export function lowerAll(tables: AnyTable[], defs: AuthoredDef[] = []): PortableObject[] {
  return lowerSchema(surrealKinds, explodeSchema(tables, defs))
}

export { KindRegistry, type Ref } from "../../core"
