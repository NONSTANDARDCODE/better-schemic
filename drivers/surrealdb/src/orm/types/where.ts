/**
 * The type-level `where` — a filter object mapped over the table's DECODED shape (`App<TD>`), with
 * the operator set narrowed by the field's TS family. The family is inferred from the value type
 * (string/number/date/array/record/geometry), mirroring the runtime classification in `wire.ts`:
 * a string field gets `contains`/`startsWith`/…, an array field gets `containsAll`/`anyInside`/…,
 * and an unknown/`any` field gets everything.
 *
 * ```ts
 * client.users.findMany({
 *   where: {
 *     active: true,                              // equals (pure value)
 *     age: { gte: 18, lt: 65 },                  // number family
 *     name: { startsWith: 'A' },                 // string family
 *     tags: { containsAny: ['db', 'graph'] },    // array family
 *     'address.city': 'São Paulo',               // dotted path (any family)
 *     OR: [{ role: 'admin' }, { role: 'owner' }],
 *   },
 * });
 * ```
 */
import type {
  BoundQuery,
  Decimal,
  Duration,
  Geometry,
  RecordId,
} from "surrealdb";
import type { App, ParamRef, Range } from "../../pure";
import type {
  AdjacentEdgeAliases,
  EdgeDefAt,
  EdgeTargetDefs,
  LinkKeys,
  LinkTargetDefs,
  ManyLinkKeys,
  SingleLinkKeys,
} from "./relations";
import type { AnyTableDef, ElementOf, SchemaInput } from "./schema";

/** The traversal direction of an edge relation filter/include. */
export type EdgeDirection = "out" | "in" | "both";

/** Any fragment (`surql` tag / catalog call) usable in a value position. */
export type Fragment = BoundQuery<unknown[]>;

/**
 * The input type a field accepts: the decoded value, plus a record-id STRING for link fields
 * (`where: { author: 'user:aeon' }` — the server coerces the string to a record id).
 */
export type FamilyInput<T> = T extends RecordId ? T | string : T;

/** A value a filter operator accepts: the app value, a fragment, or a `$param` ref. */
export type FilterInput<T> =
  | FamilyInput<T>
  | Fragment
  | ParamRef<FamilyInput<T>>;

/** Equality / comparison / presence — valid on every family. */
export interface UniversalFilter<T> {
  equals?: FilterInput<T>;
  notEquals?: FilterInput<T>;
  /** `==` — no type coercion (stricter than `equals`' `=`). */
  exact?: FilterInput<T>;
  isNull?: boolean;
  isNotNull?: boolean;
  isNone?: boolean;
  isNotNone?: boolean;
  in?: readonly FamilyInput<T>[] | Range<T> | Fragment;
  notIn?: readonly FamilyInput<T>[] | Range<T> | Fragment;
  /** `f ?< $p` … — some element satisfies the comparison. */
  any?: ComparisonFilter<T>;
  /** `f *< $p` … — every element satisfies the comparison. */
  all?: ComparisonFilter<T>;
  /** Negates the nested filter: `NOT (…)`. */
  not?: FieldFilter<T>;
}

/** `lt`/`lte`/`gt`/`gte`/`equals` — the shared comparison core. */
export interface ComparisonFilter<T> {
  equals?: FilterInput<T>;
  lt?: FilterInput<T>;
  lte?: FilterInput<T>;
  gt?: FilterInput<T>;
  gte?: FilterInput<T>;
}

/** Ordered families (number/date/duration/string) also get interval operators. */
export interface OrderedFilter<T> extends ComparisonFilter<T> {
  between?: readonly [T, T];
  outside?: readonly T[];
  inRange?: readonly [T, T];
}

/** String-only operators (`startsWith`/`matches`/… are functions, not operators, in SurrealQL). */
export interface StringFilter<T> extends OrderedFilter<T> {
  contains?: FilterInput<T>;
  startsWith?: FilterInput<T>;
  endsWith?: FilterInput<T>;
  matches?: RegExp;
  eqInsensitive?: FilterInput<T>;
  containsInsensitive?: FilterInput<T>;
  matchesFullText?: FilterInput<T> | FullTextFilter;
  length?: number;
}

/** Full-text search: all indexes (`@@`) or specific ones (`@n@`). */
export interface FullTextFilter {
  query: string;
  index?: number;
  indexes?: readonly number[];
  operator?: "AND" | "OR";
}

/** Array/set operators (element type `E`). */
export interface ArrayFilter<A> {
  contains?: FilterInput<ElementOf<A>>;
  containsNot?: FilterInput<ElementOf<A>>;
  containsAll?: readonly ElementOf<A>[] | Fragment;
  containsAny?: readonly ElementOf<A>[] | Fragment;
  containsNone?: readonly ElementOf<A>[] | Fragment;
  inside?: readonly ElementOf<A>[] | Fragment;
  notInside?: readonly ElementOf<A>[] | Fragment;
  allInside?: readonly ElementOf<A>[] | Fragment;
  anyInside?: readonly ElementOf<A>[] | Fragment;
  noneInside?: readonly ElementOf<A>[] | Fragment;
  outside?: readonly ElementOf<A>[] | Fragment;
  intersects?: readonly ElementOf<A>[] | Fragment;
  anyEquals?: FilterInput<ElementOf<A>>;
  allEquals?: FilterInput<ElementOf<A>>;
  length?: number;
}

/** Geometry operators. */
export interface GeometryFilter<T> {
  intersects?: FilterInput<T>;
  inside?: FilterInput<T>;
  /** KNN (`vector`) or a geo radius (`point`). */
  near?:
    | { vector: readonly number[]; k: number; distance?: string }
    | { point: T; distance: number };
}

/** Record-link operators. */
export interface RecordFilter<T> {
  in?: readonly FamilyInput<T>[] | Fragment;
  notIn?: readonly FamilyInput<T>[] | Fragment;
  inRange?: readonly [FamilyInput<T>, FamilyInput<T>];
}

/** Every operator, for `any`/unknown fields. */
export type AnyFilter<T> = StringFilter<T> &
  ArrayFilter<T> &
  RecordFilter<T> &
  GeometryFilter<T>;

/** The filter object a field's TS family selects. */
export type FieldFilter<T> = ValueShorthand<T> | FieldFilterObject<T>;

/** The operator-only form (no shorthand). */
export type FieldFilterObject<T> = UniversalFilter<T> & FamilyFilter<T>;

/**
 * The shorthand form: `{ active: true }` === `{ active: { equals: true } }`. A PLAIN object value is
 * excluded on purpose — the runtime reads plain objects as operator filters, so object equality must
 * be explicit (`equals`). Class values (Date/RecordId/Decimal/…), arrays and scalars pass.
 */
export type ValueShorthand<T> =
  | null
  | undefined
  | (NonNullish<T> extends readonly unknown[]
      ? NonNullish<T>
      : NonNullish<T> extends RecordId
        ? NonNullish<T> | string
        : NonNullish<T> extends
              | Date
              | Uint8Array
              | Decimal
              | Duration
              | Geometry
          ? NonNullish<T>
          : NonNullish<T> extends string | number | bigint | boolean
            ? NonNullish<T>
            : never);

/** A scalar value usable as a path shorthand (the path's family is unknown at authoring time). */
export type ScalarShorthand =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | Decimal
  | Duration
  | Geometry
  | RecordId;

/** What a dotted/bracketed path accepts: the operator object or a scalar shorthand. */
export type PathFilter =
  | FieldFilterObject<unknown>
  | ScalarShorthand
  | readonly unknown[]
  | null
  | undefined;

type FamilyFilter<T> =
  FamilyOf<T> extends "string"
    ? StringFilter<Extract<T, string>>
    : FamilyOf<T> extends "number"
      ? OrderedFilter<T>
      : FamilyOf<T> extends "date"
        ? OrderedFilter<T>
        : FamilyOf<T> extends "duration"
          ? OrderedFilter<T>
          : FamilyOf<T> extends "array"
            ? ArrayFilter<T>
            : FamilyOf<T> extends "record"
              ? RecordFilter<T>
              : FamilyOf<T> extends "geometry"
                ? GeometryFilter<T>
                : FamilyOf<T> extends "object"
                  ? unknown
                  : AnyFilter<T>;

type NonNullish<T> = T extends null | undefined ? never : T;

/** The TS family of a decoded value — the type-level mirror of `FieldFamily`. */
export type FamilyOf<T> = [NonNullish<T>] extends [never]
  ? "any"
  : [NonNullish<T>] extends [string]
    ? "string"
    : [NonNullish<T>] extends [number | bigint | Decimal]
      ? "number"
      : [NonNullish<T>] extends [boolean]
        ? "bool"
        : [NonNullish<T>] extends [Date]
          ? "date"
          : [NonNullish<T>] extends [Duration]
            ? "duration"
            : [NonNullish<T>] extends [RecordId]
              ? "record"
              : [NonNullish<T>] extends [Geometry]
                ? "geometry"
                : [NonNullish<T>] extends [readonly unknown[]]
                  ? "array"
                  : [NonNullish<T>] extends [Uint8Array]
                    ? "bytes"
                    : [NonNullish<T>] extends [object]
                      ? "object"
                      : "any";

/** Dotted paths (`address.city`) and bracketed paths (`contacts[*].type`) are always accepted. */
export type WherePaths = {
  [path: `${string}.${string}` | `${string}[${string}]${string}`]:
    | PathFilter
    | undefined;
};

/** The logical combinators, depth-guarded so recursive `Where` can't blow up instantiation. */
type LogicalWhere<TD extends AnyTableDef, S, D extends number> = D extends 0
  ? unknown
  : {
      AND?: readonly Where<TD, S, Step<D>>[];
      OR?: readonly Where<TD, S, Step<D>>[];
      NOT?: Where<TD, S, Step<D>> | readonly Where<TD, S, Step<D>>[];
    };

type DepthStep = { 3: 2; 2: 1; 1: 0; 0: 0 };
export type Step<D extends number> = D extends keyof DepthStep
  ? DepthStep[D]
  : 0;

/** A `where` for an unresolved target (bare `record`, union not in the schema) stays loose. */
export type TargetWhere<Targets, S, D extends number> = [Targets] extends [
  never,
]
  ? unknown
  : Where<Targets extends AnyTableDef ? Targets : never, S, D>;

/** `is`/`isNot` on a single record link — a filter over the TARGET table. */
export interface SingleRelationFilter<Targets, S, D extends number> {
  is?: TargetWhere<Targets, S, Step<D>>;
  isNot?: TargetWhere<Targets, S, Step<D>>;
}

/** `some`/`every`/`none` on an array link — the elements are the target records. */
export interface CollectionRelationFilter<Targets, S, D extends number> {
  some?: TargetWhere<Targets, S, Step<D>>;
  every?: TargetWhere<Targets, S, Step<D>>;
  none?: TargetWhere<Targets, S, Step<D>>;
}

/** The operand of a graph edge relation filter: edge fields AND target fields (split at runtime). */
export type EdgeOperand<E, Targets, S, D extends number> = [E] extends [never]
  ? TargetWhere<Targets, S, Step<D>>
  : Where<E extends AnyTableDef ? E : never, S, Step<D>> &
      TargetWhere<Targets, S, Step<D>>;

/** `some`/`every`/`none` on a graph edge, with an optional direction override. */
export interface EdgeRelationFilter<E, Targets, S, D extends number> {
  some?: EdgeOperand<E, Targets, S, D>;
  every?: EdgeOperand<E, Targets, S, D>;
  none?: EdgeOperand<E, Targets, S, D>;
  direction?: EdgeDirection;
}

/** The relation filter a decoded FIELD key accepts (links only — edges have their own map). */
type RelationFilterFor<
  TD extends AnyTableDef,
  S,
  K extends keyof App<TD>,
  D extends number,
> =
  K extends LinkKeys<TD>
    ? K extends ManyLinkKeys<TD>
      ? CollectionRelationFilter<LinkTargetDefs<TD, S, K>, S, D>
      : K extends SingleLinkKeys<TD>
        ? SingleRelationFilter<LinkTargetDefs<TD, S, K>, S, D>
        : never
    : never;

/** The relation filters an adjacent EDGE alias accepts. */
type EdgeRelationFilters<TD extends AnyTableDef, S, D extends number> = {
  [K in AdjacentEdgeAliases<S, TD>]?:
    | EdgeRelationFilter<
        EdgeDefAt<S, K>,
        EdgeTargetDefs<
          S,
          EdgeDefAt<S, K>,
          App<TD>["id"] extends RecordId<infer N, infer _V> ? N : never
        >,
        S,
        D
      >
    | undefined;
};

/**
 * A typed filter for `TD`: one optional entry per decoded field (with its family operators and,
 * for links, the relational `is`/`isNot`/`some`/`every`/`none`), one entry per adjacent edge (the
 * same relational operators + `direction`), dotted/bracketed paths and the `AND`/`OR`/`NOT`
 * combinators (recursed up to `D` levels).
 */
export type Where<
  TD extends AnyTableDef,
  S = SchemaInput,
  D extends number = 3,
> = {
  [K in keyof App<TD>]?:
    | FieldFilter<App<TD>[K]>
    | RelationFilterFor<TD, S, K, D>
    | undefined;
} & EdgeRelationFilters<TD, S, D> &
  WherePaths &
  LogicalWhere<TD, S, D>;

/** What a read operation accepts as `where`: the filter object or a whole-clause fragment. */
export type WhereInput<TD extends AnyTableDef, S = SchemaInput> =
  | Where<TD, S>
  | Fragment
  | ParamRef<boolean>;
