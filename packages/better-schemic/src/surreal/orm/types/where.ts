/**
 * The type-level `where` — a filter object mapped over the table's DECODED shape (`App<TD>`), with
 * the operator set narrowed by the field's TS family. The family inferrs it from the value type
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
 *     'address.city': 'Sao Paulo',               // dotted path (any family)
 *     OR: [{ role: 'admin' }, { role: 'owner' }],
 *   },
 * });
 * ```
 */
import type { BoundQuery, Decimal, Duration, Geometry, RecordId } from "surrealdb"

import type { App, ParamRef, Range } from "../../pure"

import type {
  AdjacentEdgeAliases,
  EdgeDefAt,
  EdgeTargetDefs,
  LinkKeys,
  LinkTargetDefs,
  ManyLinkKeys,
  RecordIdName,
  SingleLinkKeys,
} from "./relations"
import type { AnyTableDef, ElementOf, SchemaInput } from "./schema"

/** The traversal direction of an edge relation filter/include. */
export type EdgeDirection = "both" | "in" | "out"

/** Any fragment (`surql` tag / catalog call) usable in a value position. */
export type Fragment = BoundQuery

/**
 * The input type a field accepts: the decoded value, plus record-id STRING/`RecordId` forms for
 * record links (string-id mode's bare strings included — a bare string is assignable to `BareId`).
 */
export type FamilyInput<T> = [RecordIdName<NonNullish<T>>] extends [never]
  ? T
  : RecordId | string | T

/** A value a filter operator accepts: the app value, a fragment, or a `$param` ref. */
export type FilterInput<T> = FamilyInput<T> | Fragment | ParamRef<FamilyInput<T>>

/** Equality / comparison / presence — valid on every family. */
export type UniversalFilter<T> = {
  /** `f *< $p` … — every element satisfies the comparison. */
  all?: ComparisonFilter<T>
  /** `f ?< $p` … — some element satisfies the comparison. */
  any?: ComparisonFilter<T>
  equals?: FilterInput<T>
  /** `==` — no type coercion (stricter than `equals`' `=`). */
  exact?: FilterInput<T>
  in?: Fragment | Range<T> | readonly FamilyInput<T>[]
  isNone?: boolean
  isNotNone?: boolean
  isNotNull?: boolean
  isNull?: boolean
  /** Negates the nested filter: `NOT (…)`. */
  not?: FieldFilter<T>
  notEquals?: FilterInput<T>
  notIn?: Fragment | Range<T> | readonly FamilyInput<T>[]
}

/** `lt`/`lte`/`gt`/`gte`/`equals` — the shared comparison core. */
export type ComparisonFilter<T> = {
  equals?: FilterInput<T>
  gt?: FilterInput<T>
  gte?: FilterInput<T>
  lt?: FilterInput<T>
  lte?: FilterInput<T>
}

/** Ordered families (number/date/duration/string) also get interval operators. */
export type OrderedFilter<T> = {
  between?: readonly [T, T]
  inRange?: readonly [T, T]
  outside?: readonly T[]
} & ComparisonFilter<T>

/** String-operators (`startsWith`/`matches`/… are functions, not operators, in SurrealQL). */
export type StringFilter<T> = {
  contains?: FilterInput<T>
  containsInsensitive?: FilterInput<T>
  endsWith?: FilterInput<T>
  eqInsensitive?: FilterInput<T>
  length?: number
  matches?: RegExp
  matchesFullText?: FilterInput<T> | FullTextFilter
  startsWith?: FilterInput<T>
} & OrderedFilter<T>

/** Full-text search: all indexes (`@@`) or specific ones (`@n@`). */
export type FullTextFilter = {
  index?: number
  indexes?: readonly number[]
  operator?: "AND" | "OR"
  query: string
}

/** Array/set operators (element type `E`). */
export type ArrayFilter<A> = {
  allEquals?: FilterInput<ElementOf<A>>
  allInside?: Fragment | readonly ElementOf<A>[]
  anyEquals?: FilterInput<ElementOf<A>>
  anyInside?: Fragment | readonly ElementOf<A>[]
  contains?: FilterInput<ElementOf<A>>
  containsAll?: Fragment | readonly ElementOf<A>[]
  containsAny?: Fragment | readonly ElementOf<A>[]
  containsNone?: Fragment | readonly ElementOf<A>[]
  containsNot?: FilterInput<ElementOf<A>>
  inside?: Fragment | readonly ElementOf<A>[]
  intersects?: Fragment | readonly ElementOf<A>[]
  length?: number
  noneInside?: Fragment | readonly ElementOf<A>[]
  notInside?: Fragment | readonly ElementOf<A>[]
  outside?: Fragment | readonly ElementOf<A>[]
}

/** Geometry operators. */
export type GeometryFilter<T> = {
  inside?: FilterInput<T>
  intersects?: FilterInput<T>
  /** KNN (`vector`) or a geo radius (`point`). */
  near?:
    { distance: number; point: T } | { distance?: string; k: number; vector: readonly number[] }
}

/** Record-link operators. */
export type RecordFilter<T> = {
  in?: Fragment | readonly FamilyInput<T>[]
  inRange?: readonly [FamilyInput<T>, FamilyInput<T>]
  notIn?: Fragment | readonly FamilyInput<T>[]
}

/** Every operator, for `any`/unknown fields. */
export type AnyFilter<T> = StringFilter<T> & ArrayFilter<T> & RecordFilter<T> & GeometryFilter<T>

/** The filter object a field's TS family selects. */
export type FieldFilter<T> = FieldFilterObject<T> | ValueShorthand<T>

/** The operator-form (no shorthand). */
export type FieldFilterObject<T> = UniversalFilter<T> & FamilyFilter<T>

/**
 * The shorthand form: `{ active: true }` === `{ active: { equals: true } }`. A PLAIN object value is
 * excluded on purpose — the runtime reads plain objects as operator filters, so object equality must
 * be explicit (`equals`). Class values (Date/RecordId/Decimal/…), arrays and scalars pass.
 */
export type ValueShorthand<T> =
  | (NonNullish<T> extends readonly unknown[]
      ? NonNullish<T>
      : NonNullish<T> extends RecordId
        ? NonNullish<T> | string
        : [RecordIdName<NonNullish<T>>] extends [never]
          ? NonNullish<T> extends Date | Decimal | Duration | Geometry | Uint8Array
            ? NonNullish<T>
            : NonNullish<T> extends bigint | boolean | number | string
              ? NonNullish<T>
              : never
          : NonNullish<T> | RecordId)
  | null
  | undefined

/** A scalar value usable as a path shorthand (the path's family is unknown at authoring time). */
export type ScalarShorthand =
  bigint | boolean | Date | Decimal | Duration | Geometry | number | RecordId | string | Uint8Array

/** What a dotted/bracketed path accepts: the operator object or a scalar shorthand. */
export type PathFilter =
  FieldFilterObject<unknown> | null | readonly unknown[] | ScalarShorthand | undefined

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
                  : AnyFilter<T>

type NonNullish<T> = T extends null | undefined ? never : T

/** The TS family of a decoded value — the type-level mirror of `FieldFamily`. */
export type FamilyOf<T> = [NonNullish<T>] extends [never]
  ? "any"
  : [RecordIdName<NonNullish<T>>] extends [never]
    ? [NonNullish<T>] extends [string]
      ? "string"
      : [NonNullish<T>] extends [bigint | Decimal | number]
        ? "number"
        : [NonNullish<T>] extends [boolean]
          ? "bool"
          : [NonNullish<T>] extends [Date]
            ? "date"
            : [NonNullish<T>] extends [Duration]
              ? "duration"
              : [NonNullish<T>] extends [Geometry]
                ? "geometry"
                : [NonNullish<T>] extends [readonly unknown[]]
                  ? "array"
                  : [NonNullish<T>] extends [Uint8Array]
                    ? "bytes"
                    : IsObjectLike<NonNullish<T>> extends true
                      ? "object"
                      : "any"
    : "record"

/** True for object-like types, without the banned `object` keyword. */
type IsObjectLike<V> = [V] extends [bigint | boolean | null | number | string | symbol | undefined]
  ? false
  : unknown extends V
    ? false
    : true

/** Dotted paths (`address.city`) and bracketed paths (`contacts[*].type`) are always accepted. */
export type WherePaths = Record<
  `${string}.${string}` | `${string}[${string}]${string}`,
  PathFilter | undefined
>

/** The logical combinators, depth-guarded so recursive `Where` can't blow up instantiation. */
type LogicalWhere<TD extends AnyTableDef, S, D extends number> = D extends 0
  ? unknown
  : {
      AND?: readonly Where<TD, S, Step<D>>[]
      NOT?: readonly Where<TD, S, Step<D>>[] | Where<TD, S, Step<D>>
      OR?: readonly Where<TD, S, Step<D>>[]
    }

type Zero = 0
type One = 1
type Two = 2
type Three = 3

/** Depth literals are part of this recursive public type contract. */
export type MaxDepth = Three
export type Step<D extends number> = D extends Three ? Two : D extends Two ? One : Zero

/** A `where` for an unresolved target (bare `record`, union not in the schema) stays loose. */
export type TargetWhere<Targets, S, D extends number> = [Targets] extends [never]
  ? unknown
  : Where<Targets extends AnyTableDef ? Targets : never, S, D>

/** `is`/`isNot` on a single record link — a filter over the TARGET table. */
export type SingleRelationFilter<Targets, S, D extends number> = {
  is?: TargetWhere<Targets, S, Step<D>>
  isNot?: TargetWhere<Targets, S, Step<D>>
}

/** `some`/`every`/`none` on an array link — the elements are the target records. */
export type CollectionRelationFilter<Targets, S, D extends number> = {
  every?: TargetWhere<Targets, S, Step<D>>
  none?: TargetWhere<Targets, S, Step<D>>
  some?: TargetWhere<Targets, S, Step<D>>
}

/** The operand of a graph edge relation filter: edge fields AND target fields (split at runtime). */
export type EdgeOperand<E, Targets, S, D extends number> = [E] extends [never]
  ? TargetWhere<Targets, S, Step<D>>
  : Where<E extends AnyTableDef ? E : never, S, Step<D>> & TargetWhere<Targets, S, Step<D>>

/** `some`/`every`/`none` on a graph edge, with an optional direction override. */
export type EdgeRelationFilter<E, Targets, S, D extends number> = {
  direction?: EdgeDirection
  every?: EdgeOperand<E, Targets, S, D>
  none?: EdgeOperand<E, Targets, S, D>
  some?: EdgeOperand<E, Targets, S, D>
}

/** The relation filter a decoded FIELD key accepts (links — edges have their own map). */
type RelationFilterFor<TD extends AnyTableDef, S, K extends keyof App<TD>, D extends number> =
  K extends LinkKeys<TD>
    ? K extends ManyLinkKeys<TD>
      ? CollectionRelationFilter<LinkTargetDefs<TD, S, K>, S, D>
      : K extends SingleLinkKeys<TD>
        ? SingleRelationFilter<LinkTargetDefs<TD, S, K>, S, D>
        : never
    : never

/** The relation filters an adjacent EDGE alias accepts. */
type EdgeRelationFilters<TD extends AnyTableDef, S, D extends number> = {
  [K in AdjacentEdgeAliases<S, TD>]?:
    | EdgeRelationFilter<
        EdgeDefAt<S, K>,
        EdgeTargetDefs<S, EdgeDefAt<S, K>, RecordIdName<App<TD>["id"]>>,
        S,
        D
      >
    | undefined
}

/**
 * A typed filter for `TD`: one optional entry per decoded field (with its family operators and,
 * for links, the relational `is`/`isNot`/`some`/`every`/`none`), one entry per adjacent edge (the
 * same relational operators + `direction`), dotted/bracketed paths and the `AND`/`OR`/`NOT`
 * combinators (recursed up to `D` levels).
 */

export type Where<TD extends AnyTableDef, S = SchemaInput, D extends number = MaxDepth> = {
  [K in keyof App<TD>]?: FieldFilter<App<TD>[K]> | RelationFilterFor<TD, S, K, D> | undefined
} & EdgeRelationFilters<TD, S, D> &
  WherePaths &
  LogicalWhere<TD, S, D>

/** What a read operation accepts as `where`: the filter object or a whole-clause fragment. */
export type WhereInput<TD extends AnyTableDef, S = SchemaInput> =
  Fragment | ParamRef<boolean> | Where<TD, S>
