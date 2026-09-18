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
import type { Surql } from "../../frag";
import type { App } from "../../pure";
import type { ExplainResult, ThrowingResult } from "../results";
import type { AnyTableDef } from "./schema";
import type { WhereInput } from "./where";

/** Any fragment usable as a projection expression. */
export type SelectExpr = Surql<unknown[]>;

/** The result type a projection fragment carries (`unknown` for an untyped tag output). */
export type FragmentResult<F> =
  F extends Surql<infer R> ? (R extends [infer T] ? T : unknown) : unknown;

type NonNullish<T> = T extends null | undefined ? never : T;

/** The element type of an array/set/`readonly` array. */
export type ElementOf<A> = A extends readonly (infer E)[] ? E : never;

/** Flatten intersections for readable hovers. */
export type Simplify<T> = { [K in keyof T]: T[K] } & unknown;

/** Resolve a dotted/bracketed path against a decoded type (`address.city`, `contacts[*].type`). */
export type PathValue<
  T,
  P extends string,
> = P extends `${infer H}[*].${infer R}`
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
            : unknown;

/** Descend into a value: through arrays the projected leaf becomes an array of leaves. */
type Descend<T, R extends string> =
  NonNullish<T> extends readonly unknown[]
    ? PathValue<ElementOf<NonNullish<T>>, R>[]
    : PathValue<NonNullish<T>, R>;

/** The nested output shape a path key produces (`address.city` -> `{ address: { city: V } }`). */
export type PathShape<P extends string, V> = P extends `${infer H}.${infer R}`
  ? { [K in StripBrackets<H>]: PathShape<R, V> }
  : { [K in StripBrackets<P>]: V };

/** Strip the trailing `[n]`/`[*]` from a path segment (`contacts[*]` -> `contacts`). */
type StripBrackets<S extends string> = S extends `${infer H}[${string}]`
  ? StripBrackets<H>
  : S;

/** A nested select over a value shape (`{ address: { city: true } }`). */
export type ShapeSelect<T> =
  NonNullish<T> extends readonly unknown[]
    ? ShapeSelect<ElementOf<NonNullish<T>>>
    : {
        [K in keyof NonNullish<T>]?: SelectEntry<NonNullish<T>[K]>;
      };

/** The value a `select` entry accepts. */
export type SelectEntry<T = unknown> =
  | true
  | string
  | SelectExpr
  | ShapeSelect<T>
  | undefined;

/**
 * A projection object — ONE object type so known fields, dotted/bracketed paths, aliases and
 * expressions can MIX in the same literal (a union of per-form members would reject mixed usage).
 * Known keys keep their precise entry types; unknown keys are aliases (checked by the runtime).
 */
export type SelectObject<TD extends AnyTableDef> = {
  [K in keyof App<TD>]?: SelectEntry<App<TD>[K]>;
} & {
  [path: `${string}.${string}` | `${string}[${string}]${string}`]:
    | SelectEntry<unknown>
    | undefined;
} & {
  [alias: string]: SelectEntry<unknown>;
} & {
  "*"?: true;
};

/** The `select` argument: an array of field names or a projection object. */
export type SelectArg<TD extends AnyTableDef> =
  | readonly (keyof App<TD> & string)[]
  | SelectObject<TD>;

/** `orderBy` entries: `{ field: 'asc' | 'desc' }`, an alias, or a fragment. */
export type OrderByArg<TD extends AnyTableDef> = readonly (
  | SelectExpr
  | ({
      [K in keyof App<TD>]?: "asc" | "desc" | SelectExpr;
    } & { [alias: string]: "asc" | "desc" | SelectExpr })
)[];

/** `with: { index }` / `with: { noIndex: true }`. */
export interface WithArg {
  index?: string | readonly string[];
  noIndex?: boolean;
}

/** `range: { start, end, inclusive? }` — record-id bounds (`users:1..=100`). */
export interface RangeArg {
  start: string | { toString(): string };
  end: string | { toString(): string };
  /** Include the end bound (`..=` instead of `..`). Default `false`. */
  inclusive?: boolean;
}

/** A `groupBy` key: a known field (autocompleted) or any dotted/bracketed path. */
export type GroupByKey<TD extends AnyTableDef> =
  | (keyof App<TD> & string)
  | (string & {});

/** Every read clause (what `findMany`/`findFirst`/`findOne` accept). */
export interface ReadArgs<TD extends AnyTableDef> {
  where?: WhereInput<TD>;
  select?: SelectArg<TD>;
  omit?: readonly (keyof App<TD> & string)[];
  orderBy?: OrderByArg<TD>;
  limit?: number;
  start?: number;
  range?: RangeArg;
  split?: keyof App<TD> & string;
  groupBy?: readonly GroupByKey<TD>[];
  groupAll?: boolean;
  only?: boolean;
  value?: boolean;
  with?: WithArg;
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string;
  version?: Date | string;
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean;
}

/** `findMany` args (today identical to {@link ReadArgs}; `include` joins later). */
export type FindManyArgs<TD extends AnyTableDef> = ReadArgs<TD>;

/** `findFirst`/`findOne` args. */
export type FindOneArgs<TD extends AnyTableDef> = ReadArgs<TD>;

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export interface CountArgs<TD extends AnyTableDef> {
  where?: WhereInput<TD>;
  range?: RangeArg;
  with?: WithArg;
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string;
  version?: Date | string;
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean;
}

/** A read result: a lazy thenable with `.explain()`, or the plan itself with `explain: true`. */
export type ReadResult<T, A> = Explainable<Promise<T>, A>;

/** A throwing read result (may miss) with the same `.explain()` augmentation. */
export type ThrowingReadResult<T, A> = Explainable<ThrowingResult<T>, A>;

/** The `.explain()` dispatch shared by every read result. */
type Explainable<Base, A> = A extends { explain: true }
  ? Promise<ExplainResult>
  : Base & { explain(): Promise<ExplainResult> };

/**
 * `findUnique` args — a `where` is REQUIRED and must target the `id` or a single-field UNIQUE
 * index. Which fields are unique is runtime schema metadata (`TableDef.config.indexes`), so the
 * type can only require the `where`; the runtime rejects other fields with `UniqueTargetRequired`.
 */
export interface FindUniqueArgs<TD extends AnyTableDef>
  extends Omit<
    ReadArgs<TD>,
    | "orderBy"
    | "limit"
    | "start"
    | "range"
    | "split"
    | "groupBy"
    | "groupAll"
    | "only"
  > {
  where: WhereInput<TD>;
}

/** The shape of a nested select over a value type. */
type ShapeResult<T, Sel> = Simplify<
  {
    [K in keyof Sel as Exclude<Sel[K], undefined> extends true
      ? K
      : never]: K extends keyof NonNullish<T> ? NonNullish<T>[K] : unknown;
  } & {
    [K in keyof Sel as Exclude<Sel[K], undefined> extends string
      ? K
      : never]: Exclude<Sel[K], undefined> extends string
      ? PathValue<NonNullish<T>, Exclude<Sel[K], undefined>>
      : never;
  } & {
    [K in keyof Sel as Exclude<Sel[K], undefined> extends SelectExpr
      ? K
      : never]: FragmentResult<Exclude<Sel[K], undefined>>;
  } & {
    [K in keyof Sel as IsSubSelect<Exclude<Sel[K], undefined>> extends true
      ? K
      : never]: K extends keyof NonNullish<T>
      ? ShapeResult<NonNullish<T>[K], Exclude<Sel[K], undefined>>
      : unknown;
  }
>;

/** A projection entry's value is a nested select when it is a plain object (not a fragment). */
type IsSubSelect<V> = V extends true
  ? false
  : V extends string
    ? false
    : V extends SelectExpr
      ? false
      : V extends object
        ? true
        : false;

/** The shape one projection entry contributes. */
type EntryShape<
  TD extends AnyTableDef,
  K extends PropertyKey,
  V,
> = V extends true
  ? K extends keyof App<TD>
    ? { [P in K]: App<TD>[P] }
    : K extends string
      ? PathShape<K, PathValue<App<TD>, K>>
      : unknown
  : V extends string
    ? { [P in K]: PathValue<App<TD>, V> }
    : V extends SelectExpr
      ? { [P in K]: FragmentResult<V> }
      : IsSubSelect<V> extends true
        ? K extends keyof App<TD>
          ? { [P in K]: ShapeResult<App<TD>[P], V> }
          : unknown
        : unknown;

/** `UnionToIntersection` — merges the per-entry shapes into one object type. */
type UnionToIntersection<U> = (
  U extends unknown
    ? (x: U) => void
    : never
) extends (x: infer I) => void
  ? I
  : never;

/** The shape of a projection object over a table. */
export type SelectedShape<TD extends AnyTableDef, Sel> = Simplify<
  Sel extends readonly (infer K extends string)[]
    ? { [P in K]: P extends keyof App<TD> ? App<TD>[P] : unknown }
    : UnionToIntersection<
        {
          [K in keyof Sel]-?: EntryShape<TD, K, Exclude<Sel[K], undefined>>;
        }[keyof Sel]
      > &
        (Sel extends { "*": true } ? App<TD> : unknown)
>;

/** Apply the `split` cardinality change to a result shape. */
type ApplySplit<TD extends AnyTableDef, A, R> = A extends { split: infer S }
  ? A extends { value: true }
    ? R extends readonly unknown[]
      ? ElementOf<R>
      : R
    : S extends keyof App<TD>
      ? Simplify<Omit<R, S> & { [K in S]: ElementOf<App<TD>[S]> }>
      : R
  : R;

/** The row type a read resolves to, dispatched by the args literal. */
export type ResultOf<TD extends AnyTableDef, A> = ApplySplit<
  TD,
  A,
  A extends { value: true }
    ? A extends { select: infer Sel }
      ? SingleValue<SelectedShape<TD, Sel>>
      : unknown
    : A extends { select: infer Sel }
      ? SelectedShape<TD, Sel>
      : A extends { omit: infer O }
        ? Simplify<
            Omit<
              App<TD>,
              O extends readonly (infer K extends PropertyKey)[] ? K : never
            >
          >
        : App<TD>
>;

/** The value of a single-entry projection (`value: true`). */
type SingleValue<S> = S extends Record<string, infer V> ? V : unknown;

/** What `findMany` resolves to (`only` unwraps the single object). */
export type FindManyResult<TD extends AnyTableDef, A> = ReadResult<
  A extends { only: true } ? ResultOf<TD, A> | null : ResultOf<TD, A>[],
  A
>;

/** What `findFirst`/`findOne` resolve to (a thenable that may miss). */
export type FindOneResult<TD extends AnyTableDef, A> = ThrowingReadResult<
  ResultOf<TD, A>,
  A
>;

/** The envelope of an offset page (`paginate`). */
export interface PaginationInfo {
  readonly type: "offset";
  readonly page: number;
  readonly perPage: number;
  /** Present when `count` is enabled (the default). */
  readonly total?: number;
  readonly pageCount?: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

/** What `paginate` resolves to. */
export interface PaginationResult<T> {
  readonly data: T[];
  readonly pagination: PaginationInfo;
}

/** A cursor value: a record id (single-id ordering) or a tuple object. */
export type CursorInput =
  | string
  | { toString(): string }
  | Record<string, unknown>;

/** The envelope of a keyset page (`cursor`). */
export interface CursorInfo {
  readonly type: "cursor";
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  /** Feed back as `after`; `null` when there is no next page. */
  readonly nextCursor: CursorInput | null;
  /** Feed back as `before`; `null` when there is no previous page. */
  readonly previousCursor: CursorInput | null;
}

/** What `cursor` resolves to. */
export interface CursorResult<T> {
  readonly data: T[];
  readonly pagination: CursorInfo;
}

/** `paginate` args: a read with a required `limit` (the page size). */
export interface PaginateArgs<TD extends AnyTableDef>
  extends Omit<ReadArgs<TD>, "limit"> {
  limit: number;
  start?: number;
  /** `false` skips the count statement and probes `LIMIT n+1`. Default `true`. */
  count?: boolean;
}

/** `cursor` args: a read with a required `limit` and the keyset cursors. */
export interface CursorArgs<TD extends AnyTableDef>
  extends Omit<ReadArgs<TD>, "limit" | "groupBy" | "groupAll" | "split"> {
  limit: number;
  /** Rows after this cursor. */
  after?: CursorInput;
  /** Rows before this cursor. */
  before?: CursorInput;
}

/** What `findUnique` resolves to (a thenable that may miss). */
export type FindUniqueResult<TD extends AnyTableDef, A> = ThrowingReadResult<
  ResultOf<TD, A>,
  A
>;

/** A field usable by an aggregator: a known column or a dotted/bracketed path. */
export type AggField<TD extends AnyTableDef> =
  | (keyof App<TD> & string)
  | `${string}.${string}`;

/** The value type of an aggregator operand. */
type AggValue<TD extends AnyTableDef, F> = F extends keyof App<TD>
  ? App<TD>[F]
  : F extends string
    ? PathValue<App<TD>, F>
    : unknown;

/** One aggregator object (`{ sum: 'age' }`, `{ collect: 'email' }`). */
export interface Aggregator<TD extends AnyTableDef> {
  sum?: AggField<TD>;
  avg?: AggField<TD>;
  min?: AggField<TD>;
  max?: AggField<TD>;
  median?: AggField<TD>;
  stddev?: AggField<TD>;
  variance?: AggField<TD>;
  collect?: AggField<TD>;
  distinct?: AggField<TD>;
}

/** An aggregate select entry: `_count: true`, a path alias, an aggregator, or a fragment. */
export type AggregateEntry<TD extends AnyTableDef> =
  | true
  | (keyof App<TD> & string)
  | (string & {})
  | SelectExpr
  | Aggregator<TD>;

/** The aggregate `select` — keyed by output name. */
export type AggregateSelect<TD extends AnyTableDef> = {
  [key: string]: AggregateEntry<TD> | undefined;
};

/** The clauses `aggregate` accepts (`having` does not exist in SurrealQL — runtime rejects it). */
export interface AggregateArgs<TD extends AnyTableDef> {
  where?: WhereInput<TD>;
  select: AggregateSelect<TD>;
  groupBy?: readonly GroupByKey<TD>[];
  groupAll?: boolean;
  orderBy?: OrderByArg<TD>;
  limit?: number;
  start?: number;
  with?: WithArg;
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  timeout?: number | string;
  version?: Date | string;
  /** Hook/plugin metadata (consumed in M6). */
  meta?: Record<string, unknown>;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: boolean;
}

/** The shape one aggregate entry contributes. */
type AggEntryShape<
  TD extends AnyTableDef,
  K extends PropertyKey,
  V,
> = V extends true
  ? { [P in K]: K extends "_count" ? number : unknown }
  : V extends string
    ? { [P in K]: PathValue<App<TD>, V> }
    : V extends SelectExpr
      ? { [P in K]: FragmentResult<V> }
      : V extends Record<infer Op, infer F>
        ? { [P in K]: AggOpResult<TD, Op & string, F> }
        : { [P in K]: unknown };

/** The result type of one aggregator operator (`sum/avg/…` -> number, `collect` -> array, …). */
type AggOpResult<TD extends AnyTableDef, Op extends string, F> = [Op] extends [
  never,
]
  ? unknown
  : Op extends "sum" | "avg" | "median" | "stddev" | "variance"
    ? number
    : Op extends "min" | "max"
      ? AggValue<TD, F>
      : Op extends "collect" | "distinct"
        ? AggValue<TD, F>[]
        : unknown;

/** The row shape `aggregate` resolves to (per select entry). */
export type AggregateShape<TD extends AnyTableDef, Sel> = Simplify<
  UnionToIntersection<
    {
      [K in keyof Sel]-?: AggEntryShape<TD, K, Exclude<Sel[K], undefined>>;
    }[keyof Sel]
  >
>;
