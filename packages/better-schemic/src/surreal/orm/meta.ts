/**
 * The runtime metadata shapes a built {@link SchemaIndex} exposes — pure types, so the query
 * layer's compiler/executor can import them without touching the walker or the schema builder.
 * (`FieldFamily` lives with the field walker that computes it: `../wire`.)
 */

import type { IdStrategy } from "../pure"
// eslint-disable-next-line unicorn/prefer-export-from -- re-export público preserva API; o tipo é usado aqui também
import type { FieldFamily } from "../wire"

import type { AnyFunctionDef, AnyRelationDef, AnyTableDef } from "./types/schema"

export type { FieldFamily }

/**
 * The ORM create-id strategy RESOLVED for a table at index build: a generation strategy, or
 * `"none"` when the declared id field's codec can't producs it (uuid v4/v6) — writes must carry
 * an explicit id (`.idStrategy(...)` stays the authoring-facing `IdStrategy`).
 */
export type ResolvedIdStrategy = "none" | IdStrategy

/** Record-link metadata of a column (itself, or its array/set element). */
export type RecordLinkMeta = {
  /** True when the link lives inside an `array<…>`/`set<…>`. */
  readonly list: boolean
  readonly optional: boolean
  /** True when the field is in string-id mode: the APP value is a bare string (`01M…`). */
  readonly stringIds?: boolean
  /** Target table names (`undefined` = a bare `record`, i.e. any table). */
  readonly targets?: readonly string[]
}

/** One public column of a table/edge — wire type + family + link metadata, no Zod leaking out. */
export type ColumnMeta = {
  /** Array/set element family (for `array`/`set`). */
  readonly element?: FieldFamily
  readonly family: FieldFamily
  readonly name: string
  readonly optional: boolean
  /** Present when the column is (or contains) a record link. */
  readonly record?: RecordLinkMeta
  /** The SurrealQL wire type, as `inferField` (the DDL emitter) reports it. */
  readonly type: string
}

/** A record-link column, ready for `include`/`where` relational lowering. */
export type LinkMeta = {
  readonly cardinality: "many" | "one"
  readonly field: string
  readonly optional: boolean
  /** Target table names (`undefined` = any table). */
  readonly targets?: readonly string[]
}

/** A graph edge a table, as seen from that table. */
export type EdgeRef = {
  readonly def: AnyRelationDef
  readonly key: string
  readonly name: string
}

/** A relation's declared endpoints (physical names) + whether RELATE enforces them. */
export type RelationEndpoints = {
  readonly enforced: boolean
  readonly from: readonly string[]
  readonly to: readonly string[]
}

/** Runtime metadata for one typed table/edge. */
export type TableMeta = {
  /** Public columns (internal `$internal()` fields exclud them). */
  readonly columns: ReadonlyMap<string, ColumnMeta>
  readonly def: AnyTableDef
  /**
   * `outgoing` + `incoming`, deduped by physical name (outgoing wins) — precomputed once at index
   * build so relation lookups (`findEdge`/`edgesOf`) never build per query.
   */
  readonly edges: readonly EdgeRef[]
  /** for `kind: "relation"`. */
  readonly endpoints?: RelationEndpoints
  /** The ORM create-id strategy, resolved at index build: the declared `.idStrategy(...)`, the
   *  explicit id field's type (`s.uuid()`/`s.ulid()`), or the `"ulid"` default; `"none"` when the
   *  id field's codec is ungeneratable (uuid v4/v6 — requires explicit ids). */
  readonly idStrategy: ResolvedIdStrategy
  /** Edges whose `TO` includes this table. */
  readonly incoming: readonly EdgeRef[]
  /** The schema key (`client.<key>`). */
  readonly key: string
  readonly kind: "relation" | "table"
  /** The subset of `columns` that are record links (single or array). */
  readonly links: ReadonlyMap<string, LinkMeta>
  /** The physical table name. */
  readonly name: string
  /** Edges whose `FROM` includes this table. */
  readonly outgoing: readonly EdgeRef[]
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string
  /**
   * The table's single-field `UNIQUE` index fields, precomputed once at index build (read by
   * `findUnique`/`upsert`/`cursor` keyset compilation).
   */
  readonly uniqueFields: readonly string[]
  /**
   * The table's MULTI-field (`UNIQUE`) index field groups, precomputed once at index build. A
   * composite index is  as unique as a single-field one — a `where` covering every one of its fields
   * resolves to  one record, which is what a unique TARGET needs (`[tenant_id, name]`
   * is unique-within-tenant, the shape every multi-tenant schema uses).
   */
  readonly uniqueGroups: readonly (readonly string[])[]
}

/** Runtime metadata for a `string` schema entry (a schemaless table). */
export type SchemalessMeta = {
  readonly key: string
  readonly name: string
  readonly schemaless: true
}

/** Runtime metadata for a `FunctionDef` schema entry. */
/** A model entry: a typed table/edge OR a schemaless name. */
export type ModelMeta = SchemalessMeta | TableMeta

export type FunctionMeta = {
  readonly args: ReadonlyMap<string, ColumnMeta>
  readonly def: AnyFunctionDef
  readonly key: string
  /** The bare function name (`fn::<name>` when called). */
  readonly name: string
  readonly returns?: ColumnMeta
}

/** The complete, validated metadata pass over a schema. */
export type SchemaIndex = {
  /** Typed + schemaless entries by PHYSICAL name (for `repository(name)` / endpoint checks). */
  readonly byName: ReadonlyMap<string, ModelMeta>
  /** User-defined functions by schema key. */
  readonly functions: ReadonlyMap<string, FunctionMeta>
  /** Schemaless entries by schema key. */
  readonly schemaless: ReadonlyMap<string, SchemalessMeta>
  /** Typed tables/edges by schema key. */
  readonly tables: ReadonlyMap<string, TableMeta>
}

/**
 * Resolve a schema key OR physical table name to its model metadata (`undefined` = unknown). The ONE
 * resolver shared by `repository` — a pure lookup, no walker/builder.
 */
export function resolveModel(index: SchemaIndex, name: string): ModelMeta | undefined {
  return index.tables.get(name) ?? index.schemaless.get(name) ?? index.byName.get(name)
}
