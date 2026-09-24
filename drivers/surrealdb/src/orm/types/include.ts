/**
 * The type-level `include` surface — links, graph edges and `_count`, derived from the authored
 * schema `S` (the same relation discovery `SchemaIndex` does at runtime: link fields win, edges
 * match schema key OR physical name, direction is inferred from the declared endpoints).
 *
 * ```ts
 * const rows = await client.users.findMany({
 *   include: {
 *     mentor: { select: { id: true, name: true } },
 *     likes: { where: { published: true }, select: { title: true } },
 *     _count: { select: { likes: true } },
 *   },
 * });
 * // rows[0].mentor -> { id: RecordId; name: string } | null
 * // rows[0].likes  -> { title: string }[]
 * // rows[0]._count -> { likes: number }
 * ```
 */
import type { App } from "../../pure";
import type {
  AdjacentEdgeAliases,
  EdgeDefAt,
  EdgeTargetDefs,
  LinkKeys,
  LinkTargetDefs,
  ManyLinkKeys,
} from "./relations";
import type { AnyTableDef, DefName, SchemaInput } from "./schema";
import type { OrderByArg, SelectArg, SelectedShape, Simplify } from "./select";
import type { EdgeDirection, EdgeOperand, Step, Where } from "./where";

/** The app rows of a def union (`Record<string, unknown>` for unresolved/wildcard targets). */
export type AppOf<T> = [T] extends [never]
  ? Record<string, unknown>
  : T extends AnyTableDef
    ? App<T>
    : Record<string, unknown>;

/** A `select` arg over a target-def union (distributes); loose when unresolved. */
type TargetSelectArg<T> = [T] extends [never]
  ? SelectArg<AnyTableDef>
  : T extends AnyTableDef
    ? SelectArg<T>
    : SelectArg<AnyTableDef>;

/** The selected shape of a target-def union (distributes). */
type TargetSelected<T, Sel> = [T] extends [never]
  ? Record<string, unknown>
  : T extends AnyTableDef
    ? SelectedShape<T, Sel>
    : Record<string, unknown>;

/** The `orderBy` arg over a target-def union (distributes). */
type TargetOrderBy<T> = [T] extends [never]
  ? OrderByArg<AnyTableDef>
  : T extends AnyTableDef
    ? OrderByArg<T>
    : OrderByArg<AnyTableDef>;

// --- include arg ---------------------------------------------------------------------------------

/** `include: { author: … }` options for a LINK field. */
export interface LinkIncludeOptions<Targets, S, D extends number> {
  select?: TargetSelectArg<Targets>;
  include?: IncludeArg<
    [Targets] extends [never]
      ? AnyTableDef
      : Targets extends AnyTableDef
        ? Targets
        : AnyTableDef,
    S,
    Step<D>
  >;
  "*"?: true;
}

/** A link include: `true`, a projection, or a nested link fetch. */
export type LinkIncludeArg<Targets, S, D extends number> =
  | true
  | LinkIncludeOptions<Targets, S, D>;

/** `include: { likes: … }` options for a GRAPH edge. */
export interface EdgeIncludeOptions<E, Targets, S, D extends number> {
  where?: EdgeOperand<E, Targets, S, Step<D>>;
  /** Target projection shorthand. */
  select?: TargetSelectArg<Targets>;
  /** Explicit target projection (`true` = whole target); exclusive with `select`. */
  target?: true | { select?: TargetSelectArg<Targets> };
  /** Edge records (`true` = whole edge). */
  edge?: true | { select?: SelectArg<E extends AnyTableDef ? E : AnyTableDef> };
  orderBy?:
    | TargetOrderBy<Targets>
    | OrderByArg<E extends AnyTableDef ? E : AnyTableDef>;
  limit?: number;
  start?: number;
  direction?: EdgeDirection;
  /** Traverse ANY edge of the table (the key is then only the output alias). */
  wildcard?: true;
}

/** An edge include: `true` (target records), a projection, or the edge options object. */
export type EdgeIncludeArg<E, Targets, S, D extends number> =
  | true
  | EdgeIncludeOptions<E, Targets, S, D>;

/** `_count: { select: { <many-link|edge>: true | { where, direction } } }`. */
export interface CountIncludeOptions<TD extends AnyTableDef, S> {
  select: {
    [K in (ManyLinkKeys<TD> | AdjacentEdgeAliases<S, TD>) & string]?:
      | true
      | CountFilter<TD, S, K>;
  };
}

/** Per-key `_count` options: a target filter, and (edges only) a direction override. */
type CountFilter<TD extends AnyTableDef, S, K extends string> =
  K extends ManyLinkKeys<TD>
    ? {
        where?: Where<
          LinkTargetDefs<TD, S, K> extends infer T
            ? T extends AnyTableDef
              ? T
              : never
            : never,
          S
        >;
      }
    : {
        where?: EdgeOperand<
          EdgeDefAt<S, K>,
          EdgeTargetDefs<S, EdgeDefAt<S, K>, DefName<TD>>,
          S,
          3
        >;
        direction?: EdgeDirection;
      };

/** The `include` argument: one optional entry per link, adjacent edge and `_count`. */
export type IncludeArg<
  TD extends AnyTableDef,
  S = SchemaInput,
  D extends number = 3,
> = Simplify<
  {
    [K in LinkKeys<TD>]?: LinkIncludeArg<LinkTargetDefs<TD, S, K>, S, D>;
  } & {
    [K in AdjacentEdgeAliases<S, TD>]?: EdgeIncludeArg<
      EdgeDefAt<S, K>,
      EdgeTargetDefs<S, EdgeDefAt<S, K>, DefName<TD>>,
      S,
      D
    >;
  } & {
    _count?: CountIncludeOptions<TD, S>;
  }
>;

// --- include result ------------------------------------------------------------------------------

/** `_count` result value: one number per selected key (the key itself is `_count`). */
type CountResult<V> = V extends { select: infer Sel }
  ? Simplify<{
      [K in keyof Sel as Sel[K] extends undefined ? never : K]: number;
    }>
  : unknown;

/** A link include result — `true`/`select`/nested `include`, honoring array link cardinality. */
type LinkResult<
  TD extends AnyTableDef,
  S,
  K extends LinkKeys<TD>,
  V,
  D extends number,
> = LinkResultShape<LinkTargetDefs<TD, S, K>, V, S, D, IsMany<TD, K>>;

type IsMany<TD extends AnyTableDef, K extends LinkKeys<TD>> =
  K extends ManyLinkKeys<TD> ? true : false;

type LinkResultShape<
  Targets,
  V,
  S,
  D extends number,
  Many extends boolean,
> = Many extends true
  ? LinkItemResult<Targets, V, S, D>[]
  : LinkItemResult<Targets, V, S, D> | null;

type LinkItemResult<Targets, V, S, D extends number> = V extends true
  ? AppOf<Targets>
  : V extends { include: infer I }
    ? WithIncludes<Targets, AppOf<Targets>, S, I, D>
    : V extends { select: infer Sel }
      ? TargetSelected<Targets, Sel>
      : V extends { "*": true }
        ? AppOf<Targets>
        : AppOf<Targets>;

/** An edge include result — target records, edge records, or the `{ edge, target }` remount. */
type EdgeResult<E, Targets, V> = V extends true
  ? AppOf<Targets>[]
  : V extends { edge: infer EdgeSel }
    ? EdgeRemount<E, Targets, EdgeSel, V>
    : V extends { target: infer TargetSel }
      ? TargetProjectionResult<Targets, TargetSel>[]
      : V extends { select: infer Sel }
        ? TargetProjectionResult<Targets, Sel>[]
        : AppOf<Targets>[];

type EdgeRemount<E, Targets, EdgeSel, V> = V extends {
  target: infer TargetSel;
}
  ? {
      edge: EdgeProjection<E, EdgeSel>;
      target: TargetProjectionResult<Targets, TargetSel>;
    }[]
  : EdgeProjection<E, EdgeSel>[];

type TargetProjectionResult<Targets, Sel> = Sel extends true
  ? AppOf<Targets>
  : Sel extends { select: infer Inner }
    ? TargetSelected<Targets, Inner>
    : TargetSelected<Targets, Sel>;

type EdgeProjection<E, Sel> = Sel extends true
  ? AppOf<E>
  : Sel extends { select: infer Inner }
    ? TargetSelected<E, Inner>
    : AppOf<E>;

/** One include entry resolved by key: `_count`, a link, or an edge. */
type IncludeEntry<
  TD extends AnyTableDef,
  S,
  K extends string,
  V,
  D extends number,
> = K extends "_count"
  ? CountResult<V>
  : K extends LinkKeys<TD>
    ? LinkResult<TD, S, K, V, D>
    : K extends AdjacentEdgeAliases<S, TD>
      ? EdgeResult<
          EdgeDefAt<S, K>,
          EdgeTargetDefs<S, EdgeDefAt<S, K>, DefName<TD>>,
          V
        >
      : unknown;

/** The keys an `include` literal adds to the result. */
export type WithIncludes<TD, Base, S, I, D extends number> = I extends undefined
  ? Base
  : Simplify<
      Omit<Base, keyof I & string> & {
        [K in keyof I & string as I[K] extends undefined ? never : K]: [
          TD,
        ] extends [never]
          ? unknown
          : TD extends AnyTableDef
            ? IncludeEntry<TD, S, K, Exclude<I[K], undefined>, D>
            : unknown;
      }
    >;
