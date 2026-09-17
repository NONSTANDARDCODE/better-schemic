/**
 * The type-level half of `defineSchema` — the schema artifact the whole `/orm` surface is derived
 * from. A schema is a plain record of authored defs (`TableDef`/`RelationDef`/`FunctionDef`) plus
 * `string` entries declaring SCHEMALESS tables by physical name:
 *
 * ```ts
 * export const schema = defineSchema({
 *   users: User,                 // TableDef      -> client.users
 *   likes: Likes,                // RelationDef   -> client.likes (an edge delegate)
 *   sendMail,                    // FunctionDef   -> client.fn.sendMail
 *   audit: "audit_log",          // schemaless    -> client.audit (Record<string, unknown> rows)
 * });
 * ```
 *
 * Everything the delegates expose (keys, row types, link/edge metadata, function signatures) is
 * extracted from this one object at the type level — there is no parallel schema and no codegen.
 */
import type { App, FunctionDef, RelationDef, TableDef } from "../../pure";

/** A typed table/edge def with its shape erased — the structural upper bound for schema entries. */
// biome-ignore lint/suspicious/noExplicitAny: TableDef's Shape varies per call site.
export type AnyTableDef = TableDef<string, any>;

/** A relation (edge) def with shape + endpoint captures erased. */
export type AnyRelationDef = RelationDef<
  string,
  // biome-ignore lint/suspicious/noExplicitAny: RelationDef's Shape varies per call site.
  any,
  string,
  string,
  unknown,
  unknown
>;

/** A user-defined DB function def with its arg shape/return erased. */
// biome-ignore lint/suspicious/noExplicitAny: FunctionDef's arg shape/return vary per call site.
export type AnyFunctionDef = FunctionDef<any, any>;

/** One `defineSchema` entry: a table, an edge, a function, or a schemaless table's physical name. */
export type SchemaEntry = AnyTableDef | AnyFunctionDef | string;

/** The authored schema object shape. */
export type SchemaInput = Record<string, SchemaEntry>;

declare const SCHEMA_BRAND: unique symbol;

/**
 * A branded schema artifact (the return of `defineSchema`) — carries its entries for inference.
 * `S` is UNCONSTRAINED on purpose: an inferred const-generic entries object has no string index
 * signature, so `S extends SchemaInput` would make `SchemaDef<typeof entries>` unusable (the
 * constraint is enforced at {@link SchemaInput} consumers instead, e.g. `defineSchema`).
 */
export interface SchemaDef<S = SchemaInput> {
  readonly [SCHEMA_BRAND]: S;
  readonly entries: S;
}

/** The authored entries of a schema artifact (`typeof schema` -> the input object). */
export type SchemaOf<D extends SchemaDef> = D["entries"];

/**
 * The entries of EITHER a branded schema artifact (`typeof schema`) or a plain input object — every
 * key/lookup helper below is written over this, so `Client<typeof schema>` and `Client<literal>`
 * both work.
 */
export type EntriesOf<S> = S extends SchemaDef<infer E> ? E : S;

/** Keys whose entry is a typed table/edge (`client.<key>` typed; `RelationDef` included). */
export type TableKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyTableDef ? K : never;
}[keyof EntriesOf<S>] &
  string;

/** Keys whose entry is a relation (edge) def. */
export type RelationKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyRelationDef ? K : never;
}[keyof EntriesOf<S>] &
  string;

/** Keys whose entry declares a SCHEMALESS table by physical name. */
export type SchemalessKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends string ? K : never;
}[keyof EntriesOf<S>] &
  string;

/** Keys whose entry is a user-defined function. */
export type FunctionKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyFunctionDef ? K : never;
}[keyof EntriesOf<S>] &
  string;

/** Every key that becomes a client delegate (typed tables + schemaless names). */
export type ModelKeys<S> = TableKeys<S> | SchemalessKeys<S>;

/** The table/edge def at `K` (`never` for non-table keys). */
export type TableAt<S, K extends PropertyKey> = Extract<
  EntriesOf<S>[K & keyof EntriesOf<S>],
  AnyTableDef
>;

/** The DECODED row type of the table at `K` (`App<TD>`) — what reads resolve to. */
export type AppAt<S, K extends PropertyKey> = App<TableAt<S, K>>;

/** The relation def at `K` (`never` for non-relation keys). */
export type RelationAt<S, K extends PropertyKey> = Extract<
  EntriesOf<S>[K & keyof EntriesOf<S>],
  AnyRelationDef
>;

/** The function def at `K` (`never` for non-function keys). */
export type FunctionAt<S, K extends PropertyKey> = Extract<
  EntriesOf<S>[K & keyof EntriesOf<S>],
  AnyFunctionDef
>;
