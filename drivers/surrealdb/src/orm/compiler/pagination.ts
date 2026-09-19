/**
 * The pagination compiler — `paginate` (offset) and `cursor` (keyset).
 *
 * Both compile to ONE round-trip: `paginate` sends the data statement plus its count statement in
 * the same `conn.query`; `cursor` sends a single probe statement (`LIMIT n+1`) and derives
 * `hasNext`/`hasPrevious` from the extra row. The keyset comparison is a live-verified tuple:
 * `(a < $x) OR (a = $x AND b > $y)` — the tiebreaker is always the unique field (`id`).
 */

import { BoundQuery } from "surrealdb";
import type { ModelMeta, SchemaIndex } from "../meta";
import { compileCount } from "./aggregate";
import type { ProjectionSpec } from "./projection";
import { compileRead } from "./select";
import {
  type Binds,
  compileError,
  createBinds,
  describeValue,
  isPlainObject,
  nonNegativeInt,
  paren,
  pathList,
  positiveInt,
  rejectRemovedArgs,
  renderPath,
  uniqueFields,
} from "./shared";

/** One parsed `orderBy` entry (`f1: "desc"`). */
export interface CursorOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** `paginate` args: a read with a required `limit` (the page size). */
export interface PaginateArgs {
  where?: unknown;
  select?: unknown;
  omit?: unknown;
  orderBy?: unknown;
  limit?: unknown;
  start?: unknown;
  range?: unknown;
  split?: unknown;
  groupBy?: unknown;
  groupAll?: unknown;
  only?: unknown;
  value?: unknown;
  with?: unknown;
  timeout?: unknown;
  version?: unknown;
  meta?: unknown;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown;
  /** `false` skips the count statement and probes `LIMIT n+1` for `hasNext`. Default `true`. */
  count?: unknown;
  parallel?: unknown;
  take?: unknown;
  skip?: unknown;
}

/** The compiled `paginate` plan. */
export interface PaginatePlan {
  readonly dataSql: string;
  readonly projection: ProjectionSpec;
  /** The count statement (absent with `count: false`). */
  readonly countSql?: string;
  readonly limit: number;
  readonly start: number;
  readonly count: boolean;
  /** With `count: false`, fetch `limit + 1` rows and trim. */
  readonly probe: boolean;
}

/** Compile `paginate` into its data + count statements (binds shared across both). */
export function compilePaginate(
  meta: ModelMeta,
  args: PaginateArgs,
  binds: Binds,
  operation = "paginate",
  options: { readonly index?: SchemaIndex } = {},
): PaginatePlan {
  const limit = positiveInt(args.limit, "limit", operation);
  const start = nonNegativeInt(args.start ?? 0, "start", operation);
  const count = args.count !== false;
  const probe = !count;
  const compiled = compileRead(
    meta,
    {
      ...args,
      limit: probe ? limit + 1 : limit,
      start: start > 0 ? start : undefined,
    },
    binds,
    operation,
    { index: options.index },
  );
  const dataSql = compiled.sql;

  if (!count)
    return {
      dataSql,
      projection: compiled.projection,
      limit,
      start,
      count,
      probe,
    };

  const groupBy = pathList(args.groupBy, "groupBy", operation);
  const split = typeof args.split === "string" ? args.split : undefined;

  let countSql: string;
  if (groupBy.length > 0 || split) {
    // Count the GROUPS (or the split rows): the read core becomes a subquery, so the count rides
    // the SAME projection/where compilation as the data statement.
    const core =
      groupBy.length > 0
        ? {
            select: Object.fromEntries(groupBy.map((key) => [key, true])),
            groupBy,
          }
        : { select: { [split as string]: true }, split };
    const inner = compileRead(
      meta,
      { where: args.where, with: args.with, range: args.range, ...core },
      binds,
      operation,
      { index: options.index },
    );
    countSql = `SELECT count() FROM (${inner.sql}) GROUP ALL`;
  } else {
    countSql = compileCount(meta, args, binds, operation, {
      index: options.index,
    });
  }
  return {
    dataSql,
    projection: compiled.projection,
    countSql,
    limit,
    start,
    count,
    probe,
  };
}

/** `cursor` args: a read with a required `limit` and optional `after`/`before` cursors. */
export interface CursorArgs {
  where?: unknown;
  select?: unknown;
  omit?: unknown;
  orderBy?: unknown;
  limit?: unknown;
  range?: unknown;
  with?: unknown;
  timeout?: unknown;
  version?: unknown;
  meta?: unknown;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown;
  /** Relation hydration (M3). */
  include?: unknown;
  after?: unknown;
  before?: unknown;
  parallel?: unknown;
  take?: unknown;
  skip?: unknown;
  /** Rejected: grouping doesn't paginate by keyset. */
  groupBy?: unknown;
  groupAll?: unknown;
  split?: unknown;
}

/** The compiled `cursor` plan. */
export interface CursorPlan {
  readonly sql: string;
  readonly projection: ProjectionSpec;
  readonly limit: number;
  readonly order: readonly CursorOrder[];
  /** The page was fetched in reverse; the delegate reverses the rows back. */
  readonly backward: boolean;
}

/**
 * Compile `cursor` into one probe statement: `ORDER BY <order> LIMIT n+1` with the keyset predicate
 * ANDed to the user `where`. `before` reverses the order and the comparison; the delegate flips the
 * rows back.
 */
export function compileCursor(
  meta: ModelMeta,
  args: CursorArgs,
  binds: Binds,
  operation = "cursor",
  options: { readonly index?: SchemaIndex } = {},
): CursorPlan {
  rejectPaginationArgs(args, operation);
  const limit = positiveInt(args.limit, "limit", operation);
  if (args.after !== undefined && args.before !== undefined)
    throw compileError(
      "CursorDirectionConflict",
      `${operation}: pass "after" OR "before", not both — a cursor page moves one way.`,
      { operation },
    );
  const backward = args.before !== undefined;
  const cursor = backward ? args.before : args.after;

  const order = cursorOrder(args.orderBy, meta, operation);
  const effective: readonly CursorOrder[] = backward
    ? order.map((entry) => ({
        field: entry.field,
        direction: entry.direction === "asc" ? "desc" : "asc",
      }))
    : order;

  const predicate =
    cursor === undefined
      ? undefined
      : cursorComparison(effective, cursorValues(order, cursor, operation));
  const where =
    predicate === undefined
      ? args.where
      : args.where === undefined
        ? predicate
        : { AND: [args.where, predicate] };

  const compiled = compileRead(
    meta,
    {
      ...args,
      where,
      orderBy: effective.map((entry) => ({
        [entry.field]: entry.direction,
      })),
      limit: limit + 1,
      start: undefined,
      groupBy: undefined,
      groupAll: undefined,
      split: undefined,
    },
    binds,
    operation,
    { index: options.index },
  );
  return {
    sql: compiled.sql,
    projection: compiled.projection,
    limit,
    order,
    backward,
  };
}

/** Reject the clauses cursor can't keyset over (plus the removed/renamed args). */
function rejectPaginationArgs(args: CursorArgs, operation: string): void {
  rejectRemovedArgs(args, operation);
  for (const key of ["groupBy", "groupAll", "split"] as const)
    if (args[key] !== undefined)
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "${key}" is not supported with cursor pagination — use paginate() or $query.`,
        { operation },
      );
}

/** Parse `orderBy` into plain field/direction entries (default: `id asc`). */
function cursorOrder(
  orderBy: unknown,
  meta: ModelMeta,
  operation: string,
): readonly CursorOrder[] {
  const order: CursorOrder[] = [];
  if (orderBy === undefined) {
    order.push({ field: "id", direction: "asc" });
  } else {
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
    for (const entry of entries) {
      if (!isPlainObject(entry))
        throw compileError(
          "CursorTiebreakerRequired",
          `${operation}: orderBy entries must be plain fields ({ field: "asc" | "desc" }) — fragments can't build a keyset cursor.`,
          { operation },
        );
      for (const [field, direction] of Object.entries(entry)) {
        if (direction === undefined) continue;
        if (direction !== "asc" && direction !== "desc")
          throw compileError(
            "CursorTiebreakerRequired",
            `${operation}: orderBy direction for "${field}" must be "asc" or "desc" — expressions can't build a keyset cursor.`,
            { operation },
          );
        order.push({ field, direction });
      }
    }
  }
  if (order.length === 0)
    throw compileError(
      "CursorTiebreakerRequired",
      `${operation}: orderBy is empty — the cursor needs an ordering with a unique tiebreaker.`,
      { operation },
    );
  const last = order[order.length - 1] as CursorOrder;
  if (!isUniqueField(meta, last.field))
    throw compileError(
      "CursorTiebreakerRequired",
      `${operation}: the last orderBy field must be unique (got "${last.field}") — add "{ id: "asc" }" as the tiebreaker.`,
      { operation },
    );
  return order;
}

/** Is this field guaranteed unique (`id`, or a single-field UNIQUE index)? */
function isUniqueField(meta: ModelMeta, field: string): boolean {
  return field === "id" || uniqueFields(meta).includes(field);
}

/** Normalize the cursor value to one value per order field. */
function cursorValues(
  order: readonly CursorOrder[],
  cursor: unknown,
  operation: string,
): readonly unknown[] {
  const singleId =
    order.length === 1 && (order[0] as CursorOrder).field === "id";
  if (singleId && !isPlainObject(cursor)) return [cursor];
  if (!isPlainObject(cursor))
    throw compileError(
      "ValidationError",
      `${operation}: the cursor for a ${order.length}-field ordering must be an object like { ${order
        .map((entry) => `${entry.field}: …`)
        .join(", ")} } (got ${describeValue(cursor)}).`,
      { operation },
    );
  return order.map((entry) => {
    if (!(entry.field in cursor))
      throw compileError(
        "ValidationError",
        `${operation}: the cursor is missing "${entry.field}" — every orderBy field needs a value.`,
        { operation },
      );
    return (cursor as Record<string, unknown>)[entry.field];
  });
}

/**
 * `(a < $x) OR (a = $x AND (b < $y OR (b = $y AND id < $z)))` — the direction-aware tuple compare,
 * as a fragment with its OWN binds (merged into the read's bind map by `compileWhere`).
 */
function cursorComparison(
  order: readonly CursorOrder[],
  values: readonly unknown[],
): BoundQuery {
  const cursorBinds = createBinds("c");
  const refs = values.map((value) => cursorBinds.add(value));
  const compare = (index: number): string => {
    const entry = order[index] as CursorOrder;
    const field = renderPath(entry.field);
    const op = entry.direction === "asc" ? ">" : "<";
    const ref = refs[index] as string;
    const head = `${field} ${op} ${ref}`;
    if (index === order.length - 1) return head;
    const rest = `${head} OR (${field} = ${ref} AND ${compare(index + 1)})`;
    return index === 0 ? rest : paren(rest);
  };
  return new BoundQuery(compare(0), cursorBinds.vars);
}
