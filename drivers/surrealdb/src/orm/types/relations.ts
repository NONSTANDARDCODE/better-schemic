/**
 * Type-level relation discovery — the same rules `SchemaIndex` enforces at runtime:
 * a record-link FIELD wins over a same-named edge, edges are matched by schema KEY or physical
 * NAME, and a table's adjacent edges are those whose declared endpoints include it.
 *
 * Everything here reads the authored schema `S`; nothing is code-generated.
 */
import type { RecordId } from "surrealdb";
import type { App } from "../../pure";
import type {
  AnyRelationDef,
  AnyTableDef,
  DefName,
  DefsAtNames,
  ElementOf,
  EntriesOf,
} from "./schema";

type NonNullish<T> = T extends null | undefined ? never : T;

/** The table-name type a record value carries (`RecordId<"user">` -> `"user"`). */
type RecordIdName<T> = T extends RecordId<infer N, infer _V> ? N : never;

// --- links (record-id FIELDS) --------------------------------------------------------------------

/** The target table NAMES a link field points to (single value or array element). */
export type LinkTargetNames<TD extends AnyTableDef, K extends keyof App<TD>> = [
  RecordIdName<NonNullish<App<TD>[K]>>,
] extends [never]
  ? RecordIdName<ElementOf<NonNullish<App<TD>[K]>>>
  : RecordIdName<NonNullish<App<TD>[K]>>;

/**
 * The keys of `TD` that are record links. `id` is EXCLUDED — it is a RecordId on every table, but
 * it is the record identity, not a relation (the runtime rejects `include: { id: true }`).
 */
export type LinkKeys<TD extends AnyTableDef> = Exclude<
  {
    [K in keyof App<TD>]: [LinkTargetNames<TD, K>] extends [never] ? never : K;
  }[keyof App<TD>] &
    string,
  "id"
>;

/** The link keys whose decoded value is an array/set. */
export type ManyLinkKeys<TD extends AnyTableDef> = {
  [K in LinkKeys<TD>]: NonNullish<App<TD>[K]> extends readonly unknown[]
    ? K
    : never;
}[LinkKeys<TD>] &
  string;

/** The link keys whose decoded value is a single record (or null). */
export type SingleLinkKeys<TD extends AnyTableDef> = Exclude<
  LinkKeys<TD>,
  ManyLinkKeys<TD>
>;

/** The defs a link field targets (union over its target names; distributes). */
export type LinkTargetDefs<
  TD extends AnyTableDef,
  S,
  K extends keyof App<TD>,
> = DefsAtNames<S, LinkTargetNames<TD, K>>;

// --- edges ---------------------------------------------------------------------------------------

/** A union of defs, resolved through `App` (endpoint fields live in the shape, not the class). */
type DefsOnly<E> = E extends AnyTableDef ? E : never;

/** The `in` endpoint names of an edge def. */
type InNames<E> = "in" extends keyof App<DefsOnly<E>>
  ?
      | RecordIdName<NonNullish<App<DefsOnly<E>>["in"]>>
      | RecordIdName<ElementOf<NonNullish<App<DefsOnly<E>>["in"]>>>
  : never;

/** The `out` endpoint names of an edge def. */
type OutNames<E> = "out" extends keyof App<DefsOnly<E>>
  ?
      | RecordIdName<NonNullish<App<DefsOnly<E>>["out"]>>
      | RecordIdName<ElementOf<NonNullish<App<DefsOnly<E>>["out"]>>>
  : never;

/** Every endpoint name an edge def declares (`in` ∪ `out`). */
export type EndpointNames<E> = InNames<E> | OutNames<E>;

/** Adjacent-edge aliases: the schema KEY and the physical NAME of every relation in `S`. */
export type EdgeAliases<S> = {
  [K in keyof EntriesOf<S> as EntriesOf<S>[K] extends AnyRelationDef
    ? K | DefName<EntriesOf<S>[K]>
    : never]: EntriesOf<S>[K];
};
export type EdgeAliasKeys<S> = keyof EdgeAliases<S> & string;

/** The relation def behind an alias (schema key OR physical name). */
export type EdgeDefAt<S, K extends string> = K extends keyof EdgeAliases<S>
  ? Extract<EdgeAliases<S>[K], AnyRelationDef>
  : never;

/**
 * The edge aliases adjacent to `TD` (its physical name is one of the endpoints). A BROAD schema
 * (`SchemaInput`, the default when `S` isn't threaded) has no literal keys — resolving to `never`
 * keeps the default `Where<TD>`/`IncludeArg<TD>` from growing a `string` index signature.
 */
export type AdjacentEdgeAliases<S, TD extends AnyTableDef> =
  string extends EdgeAliasKeys<S>
    ? never
    : {
        [K in EdgeAliasKeys<S>]: DefName<TD> extends EndpointNames<
          EdgeDefAt<S, K>
        >
          ? K
          : never;
      }[EdgeAliasKeys<S>] &
        string;

/** The target table NAMES an edge reaches from `TD`'s side (both ends when the table is both). */
export type EdgeTargetNames<E, TDName extends string> =
  TDName extends InNames<E>
    ? TDName extends OutNames<E>
      ? InNames<E> | OutNames<E>
      : OutNames<E>
    : InNames<E>;

/** The defs an edge reaches from `TD`'s side. */
export type EdgeTargetDefs<S, E, TDName extends string> = DefsAtNames<
  S,
  EdgeTargetNames<E, TDName>
>;
