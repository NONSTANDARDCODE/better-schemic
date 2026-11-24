// The PORTABLE objects for the SurrealDB kind registry (core-v2, docs/kind-registry-contract.md
// slice 2). Each is a {@link PortableObject} (tagged `kind`/`name` for the generic spine) wrapping
// the canonical {@link DefineStatement}(s) the legacy diff engine already produces — so a kind's
// `emit`/`overwrite` reuse the SAME renderer + clause maps the fixed-slot `surrealDriver.diff` uses,
// and parity is byte-exact by construction (see ./registry.ts).
//
// SurrealDB authors index/event INLINE on the table, but the contract models them as their OWN kinds
// (deps/owner -> table). The driver-side EXPLODE (./explode.ts) fans a `TableDef` into one table object
// + N index + M event objects BEFORE lowering, so `KindEngine.lower` stays a clean 1:1. Fields stay
// NESTED in the table object (a table HAS fields — they are the shared substrate, not a kind), and the
// table kind owns field-level diff inside its `overwrite`.

import type { PortableObject, Ref } from "../../core"
import type {
  StructAccess,
  StructAnalyzer,
  StructFunction,
  StructParam,
  StructSequence,
  StructTable,
} from "../cli/structure"
import type { DefineStatement } from "../ddl"

/**
 * A table's portable form: its `DEFINE TABLE` head + its `DEFINE FIELD` statements (nested). Indexes
 * and events exclud them — they are their own kinds. `deps` carries the table's cross-kind edges
 * (a RELATION's in/out endpoint tables), computed at explode time.
 */
export type PTable = {
  /** Objects this table must emitts it AFTER — a RELATION's in/out tables. */
  readonly deps: Ref[]
  /** The nested `DEFINE FIELD` statements (each carries its clause map for `ALTER FIELD`). */
  readonly fields: DefineStatement[]
  /** The `DEFINE TABLE` head statement (carries the table-level clause map for `ALTER TABLE`). */
  readonly head: DefineStatement
  readonly kind: "table"
  readonly name: string
  /**
   * The NORMALIZED structured table (fields/indexes/events nested) — carried so `renderSchema` can
   * reconstruct `DbStructured` for TS codegen WITHOUT re-parsing rendered DDL (the robust read of
   * flip-plan §6b's "derive structured from your portable objects"; emit/diff still use head/fields).
   */
  readonly struct: StructTable
} & PortableObject

/** An index's portable form: the `DEFINE INDEX` statement + its owning table. `deps` carries the table
 * and, for a FULLTEXT index, its analyzer (so the analyzer emits BEFORE the index). */
export type PIndex = {
  readonly deps: Ref[]
  readonly kind: "index"
  readonly name: string
  readonly stmt: DefineStatement
  readonly table: string
} & PortableObject

/** An event's portable form: the `DEFINE EVENT` statement + its owning table. `deps` carries any
 * `fn::` functions the WHEN/THEN call (so a called function emits BEFORE the event). */
export type PEvent = {
  readonly deps: Ref[]
  readonly kind: "event"
  readonly name: string
  readonly stmt: DefineStatement
  readonly table: string
} & PortableObject

/**
 * A db-level function's portable form — OPAQUE (a neutral identity + its canonical `DEFINE FUNCTION`
 * statement, round-tripped verbatim). `deps` carries any OTHER `fn::` functions its body calls.
 */
export type PFunction = {
  readonly deps: Ref[]
  readonly kind: "function"
  readonly name: string
  /** The structured function (the opaque kind's `native` payload) — for `renderSchema` TS codegen. */
  readonly native: StructFunction
  readonly stmt: DefineStatement
} & PortableObject

/**
 * A db-level access/auth definition's portable form — OPAQUE. `deps` carries any `fn::` functions its
 * SIGNUP/SIGNIN/AUTHENTICATE call (so those functions emit BEFORE the access).
 */
export type PAccess = {
  readonly deps: Ref[]
  readonly kind: "access"
  readonly name: string
  /** The structured access (the opaque kind's `native` payload) — for `renderSchema` TS codegen. */
  readonly native: StructAccess
  readonly stmt: DefineStatement
} & PortableObject

/**
 * A db-level text-search analyzer's portable form — OPAQUE. A FULLTEXT index `deps` on it.
 */
export type PAnalyzer = {
  readonly deps: Ref[]
  readonly kind: "analyzer"
  readonly name: string
  /** The structured analyzer (the opaque kind's `native` payload) — for `renderSchema` TS codegen. */
  readonly native: StructAnalyzer
  readonly stmt: DefineStatement
} & PortableObject

/** A MANAGED `DEFINE PARAM` (inline literal value; secret/declared params never lower). */
export type PParam = {
  readonly deps: Ref[]
  readonly kind: "param"
  readonly name: string
  /** The structured param (the opaque kind's `native` payload). */
  readonly native: StructParam
  readonly stmt: DefineStatement
} & PortableObject

/** A db-level `DEFINE SEQUENCE` portable object — OPAQUE (a neutral identity + its canonical
 * `DEFINE SEQUENCE` statement, round-tripped verbatim). */
export type PSequence = {
  readonly deps: Ref[]
  readonly kind: "sequence"
  readonly name: string
  /** The structured sequence (the opaque kind's `native` payload) — for `renderSchema` TS codegen. */
  readonly native: StructSequence
  readonly stmt: DefineStatement
} & PortableObject

/** Every portable object a SurrealDB schema lowers to. */
export type SurrealPortable =
  PAccess | PAnalyzer | PEvent | PFunction | PIndex | PParam | PSequence | PTable
