/**
 * The type-level half of `schema` — the schema artifact the whole `/orm` surface derivs it
 * from. A schema is a plain record of authored defs (`TableDef`/`RelationDef`/`FunctionDef`) plus
 * `string` entries declaring SCHEMALESS tables by physical name:
 *
 * ```ts
 * export const schemaDef = schema({
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
import type { App, FunctionDef, RecordIdMode, RelationDef, Shape, TableDef } from "../../pure"

/** A typed table/edge def with its shape erased — the structural upper bound for schema entries. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bivariant erasure of the shape: `Shape` narrows filter/write inference and breaks the ORM's type gates.
export type AnyTableDef = TableDef<string, any>

/** A relation (edge) def with shape + endpoint captures erased. The endpoint ID MODES stay broad
 *  (`RecordIdMode`), so a string-id relation is still an `AnyRelationDef`. */
export type AnyRelationDef = RelationDef<
  string,
  Shape,
  string,
  string,
  unknown,
  unknown,
  RecordIdMode,
  RecordIdMode
>

/** A user-defined DB function def with its arg shape/return erased. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- bivariant erasure of the function def's args/return generics.
export type AnyFunctionDef = FunctionDef<any, any>

/** One `schema` entry: a table, an edge, a function, or a schemaless table's physical name. */
export type SchemaEntry = AnyFunctionDef | AnyTableDef | string

/** The authored schema object shape. */
export type SchemaInput = Record<string, SchemaEntry>

/** Runtime brand distinguishing a `schema` artifact from a plain `{ key: def }` literal. */
export const SCHEMA_DEF: unique symbol = Symbol.for("better-schemic.schema")

/**
 * A branded schema artifact (the return of `schema`) — carries its entries for inference.
 * `S` unconstrains it on purpose: an inferred const-generic entries object has no string index
 * signature, so `S extends SchemaInput` would make `SchemaDef<entries>` unusable (the
 * constraint enforcs it at {@link SchemaInput} consumers instead, e.g. `schema`).
 */
export type SchemaDef<S = SchemaInput> = {
  readonly entries: S
  readonly [SCHEMA_DEF]: true
}

/** The authored entries of a schema artifact (`schemaDef` -> the input object). */
export type SchemaOf<D extends SchemaDef> = D["entries"]

/**
 * The entries of EITHER a branded schema artifact (`schemaDef` type) or a plain input object — every
 * key/lookup helper below writes it over this, so `Client<Schema>` and `Client<literal>`
 * both work.
 */
export type EntriesOf<S> = S extends SchemaDef<infer E> ? E : S

/** Keys whose entry is a typed table/edge (`client.<key>` typed; `RelationDef` included). */
export type TableKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyTableDef ? K : never
}[keyof EntriesOf<S>] &
  string

/** Keys whose entry is a relation (edge) def. */
export type RelationKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyRelationDef ? K : never
}[keyof EntriesOf<S>] &
  string

/** Keys whose entry declares a SCHEMALESS table by physical name. */
export type SchemalessKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends string ? K : never
}[keyof EntriesOf<S>] &
  string

/** Keys whose entry is a user-defined function. */
export type FunctionKeys<S> = {
  [K in keyof EntriesOf<S>]: EntriesOf<S>[K] extends AnyFunctionDef ? K : never
}[keyof EntriesOf<S>] &
  string

/** Every key that becomes a client delegate (typed tables + schemaless names). */
export type ModelKeys<S> = SchemalessKeys<S> | TableKeys<S>

/** The table/edge def at `K` (`never` for non-table keys). */
export type TableAt<S, K extends keyof EntriesOf<S>> = Extract<EntriesOf<S>[K], AnyTableDef>

/** The DECODED row the table at `K` (`App<TD>`) — what reads resolve to. */
export type AppAt<S, K extends keyof EntriesOf<S>> = App<TableAt<S, K>>

/** The relation def at `K` (`never` for non-relation keys). */
export type RelationAt<S, K extends keyof EntriesOf<S>> = Extract<EntriesOf<S>[K], AnyRelationDef>

/** The function def at `K` (`never` for non-function keys). */
export type FunctionAt<S, K extends keyof EntriesOf<S>> = Extract<EntriesOf<S>[K], AnyFunctionDef>

/** The element an array/set/`readonly` array (`never` for anything else). */
export type ElementOf<A> = A extends readonly (infer E)[] ? E : never

/** The PHYSICAL name a table/edge def declares (`never` for entries without one). */
export type DefName<T> = T extends { readonly name: infer N extends string } ? N : never

/** Map every table/edge of a schema by its PHYSICAL name (what SQL/relations use). */
export type DefsByName<S> = {
  [
    K in keyof EntriesOf<S> as EntriesOf<S>[K] extends AnyTableDef
      ? DefName<EntriesOf<S>[K]>
      : never
  ]: EntriesOf<S>[K] extends AnyTableDef ? EntriesOf<S>[K] : never
}

/** The table/edge def declared at a physical name (`never` when the schema doesn't declare it). */
export type DefAtName<S, N extends string> = N extends keyof DefsByName<S>
  ? DefsByName<S>[N]
  : never

/** The union of defs at a union of physical names (distributes; preserves the union). */
export type DefsAtNames<S, N extends string> = N extends string ? DefAtName<S, N> : never
