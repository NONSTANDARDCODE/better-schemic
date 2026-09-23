/**
 * The runtime metadata shapes a built {@link SchemaIndex} exposes — pure types, so the query
 * layer's compiler/executor can import them without touching the walker or the schema builder.
 * (`FieldFamily` lives with the field walker that computes it: `../wire`.)
 */

import type { FieldFamily } from "../wire";
import type {
  AnyFunctionDef,
  AnyRelationDef,
  AnyTableDef,
} from "./types/schema";

export type { FieldFamily };

/** Record-link metadata of a column (itself, or its array/set element). */
export interface RecordLinkMeta {
  /** Target table names (`undefined` = a bare `record`, i.e. any table). */
  readonly targets?: readonly string[];
  /** True when the link lives inside an `array<…>`/`set<…>`. */
  readonly list: boolean;
  readonly optional: boolean;
}

/** One public column of a table/edge — wire type + family + link metadata, no Zod leaking out. */
export interface ColumnMeta {
  readonly name: string;
  /** The SurrealQL wire type, exactly as `inferField` (the DDL emitter) reports it. */
  readonly type: string;
  readonly family: FieldFamily;
  readonly optional: boolean;
  /** Array/set element family (only for `array`/`set`). */
  readonly element?: FieldFamily;
  /** Present when the column is (or contains) a record link. */
  readonly record?: RecordLinkMeta;
}

/** A record-link column, ready for `include`/`where` relational lowering. */
export interface LinkMeta {
  readonly field: string;
  /** Target table names (`undefined` = any table). */
  readonly targets?: readonly string[];
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
}

/** A graph edge adjacent to a table, as seen from that table. */
export interface EdgeRef {
  readonly key: string;
  readonly name: string;
  readonly def: AnyRelationDef;
}

/** A relation's declared endpoints (physical names) + whether RELATE enforces them. */
export interface RelationEndpoints {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly enforced: boolean;
}

/** Runtime metadata for one typed table/edge. */
export interface TableMeta {
  /** The schema key (`client.<key>`). */
  readonly key: string;
  /** The physical table name. */
  readonly name: string;
  readonly kind: "table" | "relation";
  readonly def: AnyTableDef;
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string;
  /** Public columns (internal `$internal()` fields are excluded). */
  readonly columns: ReadonlyMap<string, ColumnMeta>;
  /** The subset of `columns` that are record links (single or array). */
  readonly links: ReadonlyMap<string, LinkMeta>;
  /** Edges whose `FROM` includes this table. */
  readonly outgoing: readonly EdgeRef[];
  /** Edges whose `TO` includes this table. */
  readonly incoming: readonly EdgeRef[];
  /** Only for `kind: "relation"`. */
  readonly endpoints?: RelationEndpoints;
}

/** Runtime metadata for a `string` schema entry (a schemaless table). */
export interface SchemalessMeta {
  readonly key: string;
  readonly name: string;
  readonly schemaless: true;
}

/** Runtime metadata for a `FunctionDef` schema entry. */
/** A model entry: a typed table/edge OR a schemaless name. */
export type ModelMeta = TableMeta | SchemalessMeta;

export interface FunctionMeta {
  readonly key: string;
  /** The bare function name (`fn::<name>` when called). */
  readonly name: string;
  readonly def: AnyFunctionDef;
  readonly args: ReadonlyMap<string, ColumnMeta>;
  readonly returns?: ColumnMeta;
}

/** The complete, validated metadata pass over a schema. */
export interface SchemaIndex {
  /** Typed tables/edges by schema key. */
  readonly tables: ReadonlyMap<string, TableMeta>;
  /** Schemaless entries by schema key. */
  readonly schemaless: ReadonlyMap<string, SchemalessMeta>;
  /** Typed + schemaless entries by PHYSICAL name (for `repository(name)` / endpoint checks). */
  readonly byName: ReadonlyMap<string, ModelMeta>;
  /** User-defined functions by schema key. */
  readonly functions: ReadonlyMap<string, FunctionMeta>;
}

/**
 * Resolve a schema key OR physical table name to its model metadata (`undefined` = unknown). The ONE
 * resolver shared by `repository`, the changefeed and `live` — a pure lookup, no walker/builder.
 */
export function resolveModel(
  index: SchemaIndex,
  name: string,
): ModelMeta | undefined {
  return (
    index.tables.get(name) ??
    index.schemaless.get(name) ??
    index.byName.get(name)
  );
}
