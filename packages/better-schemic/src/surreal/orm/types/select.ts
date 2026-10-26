/**
 * The type-level read surface: the `select`/`orderBy`/clause args and the result they produce.
 *
 * The result is inferred from the ARGS LITERAL (`const A extends FindManyArgs<TD>`), like
 * better-drizzle's `PayloadForArgs`: `select` -> projected shape, `omit` -> the row minus keys,
 * `value` -> the single expression's type, `only` -> a single object instead of an array, and
 * `split` -> the split field becomes its ELEMENT type (the statement unfolds the array).
 *
 * ```ts
 * const rows = await client.users.findMany({
 *   select: { id: true, name: true, upper: surql`string::uppercase(name)`.as<string>() },
 *   where: { age: { gte: 18 } },
 * });
 * // rows: { id: RecordId; name: string; upper: string }[]
 * ```
 */
import type { Surql } from "../../frag"
import type { ExplainResult, ThrowingResult } from "../results"
import type { CallContext } from "./context"
import type { IncludeArg, WithIncludes } from "./include"
import type { AnyTableDef, ElementOf, SchemaInput } from "./schema"
import type { WhereInput } from "./where"
import type { App, TableDef } from "../../pure"

/** Any fragment usable as a projection expression. */
export type SelectExpr = Surql

/** The result type a projection fragment carries (`unknown` for an untyped tag output). */
export type FragmentResult<F> =
  F extends Surql<infer R> ? (R extends [infer T] ? T : unknown) : unknown

type NonNullish<T> = T extends null | undefined ? never : T

/** Flatten intersections for readable hovers. */
export type Simplify<T> = { [K in keyof T]: T[K] } & unknown

/** Resolve a dotted/bracketed path against a decoded type (`address.city`, `contacts[*].type`). */
export type PathValue<T, P extends string> = P extends `${infer H}[*].${infer R}`
  ? H extends keyof NonNullish<T>
    ? PathValue<ElementOf<NonNullish<T>[H]>, R>[]
    : unknown
  : P extends `${infer H}[${string}].${infer R}`
    ? H extends keyof NonNullish<T>
      ? PathValue<ElementOf<NonNullish<T>[H]>, R>
      : unknown
    : P extends `${infer H}.${infer R}`
      ? H extends keyof NonNullish<T>
        ? Descend<NonNullish<T>[H], R>
        : unknown
      : P extends `${infer H}[*]`
        ? H extends keyof NonNullish<T>
          ? ElementOf<NonNullish<T>[H]>[]
          : unknown
        : P extends `${infer H}[${string}]`
          ? H extends keyof NonNullish<T>
            ? ElementOf<NonNullish<T>[H]>
            : unknown
          : P extends keyof NonNullish<T>
            ? NonNullish<T>[P]
            : unknown

/** Descend into a value: through arrays the projected leaf becomes an array of leaves. */
type Descend<T, R extends string> =
  NonNullish<T> extends readonly unknown[]
    ? PathValue<ElementOf<NonNullish<T>>, R>[]
    : PathValue<NonNullish<T>, R>

/** The nested output shape a path key produces (`address.city` -> `{ address: { city: V } }`). */
export type PathShape<P extends string, V> = P extends `${infer H}.${infer R}`
  ? { [K in StripBrackets<H>]: PathShape<R, V> }
  : { [K in StripBrackets<P>]: V }

/** Strip the trailing `[n]`/`[*]` from a path segment (`contacts[*]` -> `contacts`). */
type StripBrackets<S extends string> = S extends `${infer H}[${string}]` ? StripBrackets<H> : S

/** A nested select over a value shape (`{ address: { city: true } }`). */
export type ShapeSelect<T> =
  NonNullish<T> extends readonly unknown[]
    ? ShapeSelect<ElementOf<NonNullish<T>>>
    : {
        [K in keyof NonNullish<T>]?: SelectEntry<NonNullish<T>[K]>
      }

/** The value a `select` entry accepts. */
export type SelectEntry<T = unknown> = true | string | SelectExpr | ShapeSelect<T> | undefined

/**
 * A projection object — ONE object type so known fields, dotted/bracketed paths, aliases and
 * expressions can MIX in the same literal (a union of per-form members would reject mixed usage).
 * Known keys keep their precise entry types; unknown keys are aliases (checked by the runtime).
 */
export type SelectObject<TD extends AnyTableDef> = {
  [K in keyof App<TD>]?: SelectEntry<App<TD>[K]>
} & Record<`${string}.${string}` | `${string}[${string}]${string}`, SelectEntry | undefined> &
  Record<string, SelectEntry> & {
    "*"?: true
  }

/** The `select` argument: an array of field names or a projection object. */
export type SelectArg<TD extends AnyTableDef> =
  readonly (keyof App<TD> & string)[] | SelectObject<TD>

/** `orderBy` entries: `{ field: 'asc' | 'desc' }`, an alias, or a fragment. */
export type OrderByArg<TD extends AnyTableDef> = readonly (
  | SelectExpr
  | ({
      [K in keyof App<TD>]?: "asc" | "desc" | SelectExpr
    } & Record<string, "asc" | "desc" | SelectExpr>)
)[]

/** `with: { index }` / `with: { noIndex: true }`. */
export interface WithArg {
  index?: string | readonly string[]
  noIndex?: boolean
}

/** `range: { start, end, inclusive? }` — record-id bounds (`users:1..=100`). */
export interface RangeArg {
  start: string | { toString: () => string }
  end: string | { toString: () => string }
  /** Include the end bound (`..=` instead of `..`). Default `false`. */
  inclusive?: boolean
}

/** A `groupBy` key: a known field (autocompleted) or any dotted/bracketed path. */
export type GroupByKey<TD extends AnyTableDef> = (keyof App<TD> & string) | (string & {})

/** Every read clause (what `findMany`/`findFirst`/`findOne` accept). */
export interface ReadArgs<TD extends AnyTableDef, S = SchemaInput> {
  where?: WhereInput<TD, S>
  select?: SelectArg<TD>
  omit?: readonly (keyof App<TD> & string)[]
  orderBy?: OrderByArg<TD>
  limit?: number
  start?: number
  range?: RangeArg
  split?: keyof App<TD> & string
  groupBy?: readonly GroupByKey<TD>[]
  groupAll?: boolean
  only?: boolean
  value?: boolean
  with?: WithArg
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string
  version?: Date | string
  /** Relation hydration (`FETCH`/traversal/`_count`) — M3. */
  include?: IncludeArg<TD, S>
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>
  /** Per-call namespace/database override (`context: { database: "analytics" }`). */
  context?: CallContext
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean
}

/** `findMany` args. */
export type FindManyArgs<TD extends AnyTableDef, S = SchemaInput> = ReadArgs<TD, S>

/** `findFirst`/`findOne` args. */
export type FindOneArgs<TD extends AnyTableDef, S = SchemaInput> = ReadArgs<TD, S>

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export interface CountArgs<TD extends AnyTableDef, S = SchemaInput> {
  where?: WhereInput<TD, S>
  range?: RangeArg
  with?: WithArg
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string
  version?: Date | string
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>
  /** Per-call namespace/database override. */
  context?: CallContext
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean
}

/** A read result: a lazy thenable with `.explain()`, or the plan itself with `explain: true`. */
export type ReadResult<T, A> = Explainable<Promise<T>, A>

/** A throwing read result (may miss) with the same `.explain()` augmentation. */
export type ThrowingReadResult<T, A> = Explainable<ThrowingResult<T>, A>

/** The `.explain()` dispatch shared by every read result. */
type Explainable<Base, A> = A extends { explain: true }
  ? Promise<ExplainResult>
  : Base & { explain: () => Promise<ExplainResult> }

/**
 * `findUnique` args — a `where` is REQUIRED and must target the `id` or a single-field UNIQUE
 * index. Which fields are unique is runtime schema metadata (`TableDef.config.indexes`), so the
 * type can only require the `where`; the runtime rejects other fields with `UniqueTargetRequired`.
 */
export interface FindUniqueArgs<TD extends AnyTableDef, S = SchemaInput> extends Omit<
  ReadArgs<TD, S>,
  "orderBy" | "limit" | "start" | "range" | "split" | "groupBy" | "groupAll" | "only"
> {
  where: WhereInput<TD, S>
}

/** The shape of a nested select over a value type. */
type ShapeResult<T, Sel> = Simplify<
  {
    [
      K in keyof Sel as Exclude<Sel[K], undefined> extends true ? K : never
    ]: K extends keyof NonNullish<T> ? NonNullish<T>[K] : unknown
  } & {
    [K in keyof Sel as Exclude<Sel[K], undefined> extends string ? K : never]: Exclude<
      Sel[K],
      undefined
    > extends string
      ? PathValue<NonNullish<T>, Exclude<Sel[K], undefined>>
      : never
  } & {
    [K in keyof Sel as Exclude<Sel[K], undefined> extends SelectExpr ? K : never]: FragmentResult<
      Exclude<Sel[K], undefined>
    >
  } & {
    [
      K in keyof Sel as IsSubSelect<Exclude<Sel[K], undefined>> extends true ? K : never
    ]: K extends keyof NonNullish<T>
      ? ShapeResult<NonNullish<T>[K], Exclude<Sel[K], undefined>>
      : unknown
  }
>

/** A projection entry's value is a nested select when it is a plain object (not a fragment). */
type IsSubSelect<V> = V extends true
  ? false
  : V extends string
    ? false
    : V extends SelectExpr
      ? false
      : V extends object
        ? true
        : false

/** The shape one projection entry contributes. */
type EntryShape<TD extends AnyTableDef, K extends PropertyKey, V> = V extends true
  ? K extends keyof App<TD>
    ? { [P in K]: App<TD>[P] }
    : K extends string
      ? PathShape<K, PathValue<App<TD>, K>>
      : unknown
  : V extends string
    ? Record<K, PathValue<App<TD>, V>>
    : V extends SelectExpr
      ? Record<K, FragmentResult<V>>
      : IsSubSelect<V> extends true
        ? K extends keyof App<TD>
          ? { [P in K]: ShapeResult<App<TD>[P], V> }
          : unknown
        : unknown

/** `UnionToIntersection` — merges the per-entry shapes into one object type. */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never

/** The shape of a projection object over a table. */
export type SelectedShape<TD extends AnyTableDef, Sel> = Simplify<
  Sel extends readonly (infer K extends string)[]
    ? { [P in K]: P extends keyof App<TD> ? App<TD>[P] : unknown }
    : UnionToIntersection<
        {
          [K in keyof Sel]-?: K extends "*" ? never : EntryShape<TD, K, Exclude<Sel[K], undefined>>
        }[keyof Sel]
      > &
        (Sel extends { "*": true } ? App<TD> : unknown)
>

/** Apply the `split` cardinality change to a result shape. */
type ApplySplit<TD extends AnyTableDef, A, R> = A extends { split: infer S }
  ? A extends { value: true }
    ? R extends readonly unknown[]
      ? ElementOf<R>
      : R
    : S extends keyof App<TD>
      ? Simplify<Omit<R, S> & Record<S, ElementOf<App<TD>[S]>>>
      : R
  : R

/** The row type a read resolves to, dispatched by the args literal (`include` overlays keys). */
export type ResultOf<TD extends AnyTableDef, A, S = SchemaInput> = ApplySplit<
  TD,
  A,
  WithIncludes<
    TD,
    A extends { value: true }
      ? A extends { select: infer Sel }
        ? SingleValue<SelectedShape<TD, Sel>>
        : unknown
      : A extends { select: infer Sel }
        ? SelectedShape<TD, Sel>
        : A extends { omit: infer O }
          ? Simplify<Omit<App<TD>, O extends readonly (infer K extends PropertyKey)[] ? K : never>>
          : App<TD>,
    S,
    A extends { include: infer I } ? I : undefined,
    3
  >
>

/** The value of a single-entry projection (`value: true`). */
type SingleValue<S> = S extends Record<string, infer V> ? V : unknown

/** What `findMany` resolves to (`only` unwraps the single object). */
export type FindManyResult<TD extends AnyTableDef, A, S = SchemaInput> = ReadResult<
  A extends { only: true } ? ResultOf<TD, A, S> | null : ResultOf<TD, A, S>[],
  A
>

/** What `findFirst`/`findOne` resolve to (a thenable that may miss). */
export type FindOneResult<TD extends AnyTableDef, A, S = SchemaInput> = ThrowingReadResult<
  ResultOf<TD, A, S>,
  A
>

/** The envelope of an offset page (`paginate`). */
export interface PaginationInfo {
  readonly type: "offset"
  readonly page: number
  readonly perPage: number
  /** Present when `count` is enabled (the default). */
  readonly total?: number
  readonly pageCount?: number
  readonly hasNext: boolean
  readonly hasPrevious: boolean
}

/** What `paginate` resolves to. */
export interface PaginationResult<T> {
  readonly data: T[]
  readonly pagination: PaginationInfo
}

/** A cursor value: a record id (single-id ordering) or a tuple object. */
export type CursorInput = string | { toString: () => string } | Record<string, unknown>

/** The envelope of a keyset page (`cursor`). */
export interface CursorInfo {
  readonly type: "cursor"
  readonly hasNext: boolean
  readonly hasPrevious: boolean
  /** Feed back as `after`; `null` when there is no next page. */
  readonly nextCursor: CursorInput | null
  /** Feed back as `before`; `null` when there is no previous page. */
  readonly previousCursor: CursorInput | null
}

/** What `cursor` resolves to. */
export interface CursorResult<T> {
  readonly data: T[]
  readonly pagination: CursorInfo
}

/** `paginate` args: a read with a required `limit` (the page size). */
export interface PaginateArgs<TD extends AnyTableDef, S = SchemaInput> extends Omit<
  ReadArgs<TD, S>,
  "limit"
> {
  limit: number
  start?: number
  /** `false` skips the count statement and probes `LIMIT n+1`. Default `true`. */
  count?: boolean
}

/**
 * `cursor` args: a read with a required `limit` and the keyset cursors.
 *
 * `select` does NOT need to include the `orderBy` fields: the compiler appends reserved
 * `_keyset_<n>` aliases for the missing keyset columns and reads the cursors from them (stripping
 * them afterwards), so `data` is exactly the selection. Cursor values carry the **raw stored
 * value** (`DateTime` for `s.datetime()`, `RecordId` for `id` — a BARE string when the column is in
 * string-id mode) — not the codec-decoded app value — so `after`/`before` round-trip without
 * precision loss (a `Date` would truncate ns to ms and the keyset predicate would skip rows created
 * in the same millisecond). `after`/`before` also accept the app forms: a bare/`table:id` string or
 * a `Date`/ISO string, coerced to the column's wire type before the bind.
 */
export interface CursorArgs<TD extends AnyTableDef, S = SchemaInput> extends Omit<
  ReadArgs<TD, S>,
  "limit" | "groupBy" | "groupAll" | "split" | "value" | "only" | "start" | "orderBy"
> {
  limit: number
  /**
   * The ordering, whose LAST field must be unique — a keyset page needs a tiebreaker, and the
   * table's `id` is the only one that is unique by construction.
   *
   * Typed from the schema: `.index(name, [field], { unique: true })` records the field in the
   * table's `U` parameter, so the compiler rejects an ordering that ends on a non-unique field
   * (`{ createdAt }, { id }` is the portable fix) instead of failing at runtime. A table with NO
   * declared unique index keeps the broad form, and a composite UNIQUE index does not count — its
   * fields are unique only together, which a single tiebreaker field cannot express.
   */
  orderBy?: CursorOrderBy<TD, S>
  /** Rows after this cursor. */
  after?: CursorInput
  /** Rows before this cursor. */
  before?: CursorInput
}

/** One `orderBy` entry of a cursor: a field plus its direction. */
export type CursorOrderEntry<F extends string = string> = Partial<Record<F, "asc" | "desc">>

/**
 * The `orderBy` of a `cursor`, restricted to orderings whose LAST field is unique.
 *
 * `U` is the table's single-field-UNIQUE union (`""` when none was declared, so a table without a
 * unique index keeps accepting any ordering and the runtime guard stays the backstop).
 */
export type CursorOrderBy<TD extends AnyTableDef, S = SchemaInput> =
  | readonly [
      order: ReadArgs<TD, S>["orderBy"] extends infer O ? CursorOrderEntries<O> : never,
      tiebreaker: CursorOrderEntry<UniqueTiebreaker<TD>>,
    ]
  | readonly [tiebreaker: CursorOrderEntry<UniqueTiebreaker<TD>>]

/** Normalize a read's `orderBy` into single-field entries (a fragment list widens to `{ [k] }`). */
type CursorOrderEntries<O> = O extends readonly (infer E)[]
  ? E extends Record<string, unknown>
    ? E
    : CursorOrderEntry
  : O extends Record<string, unknown>
    ? O
    : CursorOrderEntry

/** `id` plus every field declared with a single-field UNIQUE index. */
export type UniqueTiebreaker<TD extends AnyTableDef> =
  "id" | (TD extends TableDef<string, infer _S, infer U> ? U & string : never)

/** What `findUnique` resolves to (a thenable that may miss). */
export type FindUniqueResult<TD extends AnyTableDef, A, S = SchemaInput> = ThrowingReadResult<
  ResultOf<TD, A, S>,
  A
>

/** The field an `aggregate({ split })` unfolds: an array/set column of the table. */
export type SplitPath<TD extends AnyTableDef> = ArrayFieldNames<App<TD>>

/** The array/set column names of a table's app shape. */
type ArrayFieldNames<A> = {
  [K in keyof A]-?: NonNullable<A[K]> extends readonly unknown[] ? K & string : never
}[keyof A] &
  string

/** A field usable by an aggregator: a known column or a dotted/bracketed path. */
export type AggField<TD extends AnyTableDef> = (keyof App<TD> & string) | `${string}.${string}`

/** The value type of an aggregator operand. */
type AggValue<TD extends AnyTableDef, F> = F extends keyof App<TD>
  ? App<TD>[F]
  : F extends string
    ? // With `split`, an operand names a field of the split ELEMENT (`lines[*].label`): the
      // Bracketed segment indexes the array, so the value is the element's field — resolvable
      // From this table's own app shape, and `unknown` when the element is a bare record link.
      SplitElementValue<App<TD>, F>
    : unknown

/** The value of a split operand path (`lines[*].label`) against the table's app shape. */
type SplitElementValue<A, F extends string> = F extends `${infer Head}[*].${infer Rest}`
  ? Head extends keyof A
    ? ElementOf<NonNullable<A[Head]>> extends infer Elem
      ? Elem extends Record<Rest, infer V>
        ? V
        : unknown
      : unknown
    : unknown
  : PathValue<A, F>

/** One aggregator object (`{ sum: 'age' }`, `{ collect: 'email' }`). */
export interface Aggregator<TD extends AnyTableDef> {
  sum?: AggField<TD>
  avg?: AggField<TD>
  min?: AggField<TD>
  max?: AggField<TD>
  median?: AggField<TD>
  stddev?: AggField<TD>
  variance?: AggField<TD>
  collect?: AggField<TD>
  distinct?: AggField<TD>
}

/** An aggregate select entry: `_count: true`, a path alias, an aggregator, or a fragment. */
export type AggregateEntry<TD extends AnyTableDef> =
  true | (keyof App<TD> & string) | (string & {}) | SelectExpr | Aggregator<TD>

/** The aggregate `select` — keyed by output name. */
export type AggregateSelect<TD extends AnyTableDef> = Record<string, AggregateEntry<TD> | undefined>

/** The clauses `aggregate` accepts (`having` does not exist in SurrealQL — runtime rejects it). */
export interface AggregateArgs<TD extends AnyTableDef, S = SchemaInput> {
  where?: WhereInput<TD, S>
  select: AggregateSelect<TD>
  /**
   * UNWIND the rows by this array/set field before grouping (UNWIND + GROUP). SurrealDB evaluates
   * `SPLIT` before `GROUP`, so the split runs in an inner subquery and the grouping happens over its
   * rows; an aggregator operand then names a field of the split **ELEMENT**
   * (`{ sum: "lines[*].quantity" }`). `where` filters the PARENT rows — filtering ELEMENTS is a
   * `surql` recipe (`array::flatten`), because `SPLIT <expr>` is evaluated per element.
   */
  split?: SplitPath<TD>
  groupBy?: readonly GroupByKey<TD>[]
  groupAll?: boolean
  orderBy?: OrderByArg<TD>
  limit?: number
  start?: number
  with?: WithArg
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string
  version?: Date | string
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>
  /** Per-call namespace/database override. */
  context?: CallContext
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean
}

/** The shape one aggregate entry contributes. */
type AggEntryShape<TD extends AnyTableDef, K extends PropertyKey, V> = V extends true
  ? Record<K, K extends "_count" ? number : unknown>
  : V extends string
    ? Record<K, PathValue<App<TD>, V>>
    : V extends SelectExpr
      ? Record<K, FragmentResult<V>>
      : V extends Record<infer Op, infer F>
        ? Record<K, AggOpResult<TD, Op & string, F>>
        : Record<K, unknown>

/** The result type of one aggregator operator (`sum/avg/…` -> number, `collect` -> array, …). */
type AggOpResult<TD extends AnyTableDef, Op extends string, F> = [Op] extends [never]
  ? unknown
  : Op extends "sum" | "avg" | "median" | "stddev" | "variance"
    ? number
    : Op extends "min" | "max"
      ? AggValue<TD, F>
      : Op extends "collect" | "distinct"
        ? AggValue<TD, F>[]
        : unknown

/** The row shape `aggregate` resolves to (per select entry). */
export type AggregateShape<TD extends AnyTableDef, Sel> = Simplify<
  UnionToIntersection<
    {
      [K in keyof Sel]-?: AggEntryShape<TD, K, Exclude<Sel[K], undefined>>
    }[keyof Sel]
  >
>
