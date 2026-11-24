/**
 * The pagination compiler — `paginate` (offset) and `cursor` (keyset).
 *
 * Both compile to ONE round-trip: `paginate` sends the data statement plus its count statement in
 * the same `conn.query`; `cursor` sends a single probe statement (`LIMIT n+1`) and derives
 * `hasNext`/`hasPrevious` from the extra row. The keyset comparison is a live-verified tuple:
 * `(a < $x) OR (a = $x AND b > $y)` — the tiebreaker is always the unique field (`id`).
 */

import { BoundQuery, DateTime } from "surrealdb"

import type { ModelMeta, SchemaIndex } from "../meta"

import { compileCount } from "./aggregate"
import { type CursorKey, keysetProjection } from "./keyset"
import type { ProjectionSpec } from "./projection"
import { compileRead } from "./select"
import {
  baseColumn,
  type Binds,
  coerceRecordValue,
  compileError,
  createBinds,
  describeValue,
  isPlainObject,
  isTableMeta,
  nonNegativeInt,
  paren,
  pathList,
  positiveInt,
  rejectRemovedArgs,
  renderPath,
  uniqueFields,
} from "./shared"

/** One parsed `orderBy` entry (`f1: "desc"`). */
export type CursorOrder = {
  readonly direction: "asc" | "desc"
  readonly field: string
}

/** `paginate` args: a read with a required `limit` (the page size). */
export type PaginateArgs = {
  /** `false` skips the count statement and probes `LIMIT n+1` for `hasNext`. Default `true`. */
  count?: unknown
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  groupAll?: unknown
  groupBy?: unknown
  limit?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  only?: unknown
  orderBy?: unknown
  parallel?: unknown
  range?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  select?: unknown
  skip?: unknown
  split?: unknown
  start?: unknown
  take?: unknown
  timeout?: unknown
  value?: unknown
  version?: unknown
  where?: unknown
  with?: unknown
}

/** The compiled `paginate` plan. */
export type PaginatePlan = {
  readonly count: boolean
  /** The count statement (absent with `count: false`). */
  readonly countSql?: string
  readonly dataSql: string
  readonly limit: number
  /** With `count: false`, fetch `limit + 1` rows and trim. */
  readonly probe: boolean
  readonly projection: ProjectionSpec
  readonly start: number
}

/** Compile `paginate` into its data + count statements (binds shared across both). */
export function compilePaginate(
  meta: ModelMeta,
  args: PaginateArgs,
  binds: Binds,
  operation = "paginate",
  options: { readonly index?: SchemaIndex } = {},
): PaginatePlan {
  const limit = positiveInt(args.limit, "limit", operation)
  const start = nonNegativeInt(args.start ?? 0, "start", operation)
  const count = args.count !== false
  const probe = !count
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
  )
  const dataSql = compiled.sql

  if (!count) {
    return {
      count,
      dataSql,
      limit,
      probe,
      projection: compiled.projection,
      start,
    }
  }

  const groupBy = pathList(args.groupBy, "groupBy", operation)
  const split = typeof args.split === "string" ? args.split : undefined

  let countSql: string
  if (groupBy.length > 0 || split) {
    // Count the GROUPS (or the split rows): the read core becomes a subquery, so the count rides
    // the SAME projection/where compilation as the data statement.
    const core =
      groupBy.length > 0
        ? {
            groupBy,
            select: Object.fromEntries(groupBy.map((key) => [key, true])),
          }
        : { select: { [split ?? ""]: true }, split }
    const inner = compileRead(
      meta,
      {
        range: args.range,
        scope: args.scope,
        where: args.where,
        with: args.with,
        ...core,
      },
      binds,
      operation,
      { index: options.index },
    )
    countSql = `SELECT count() FROM (${inner.sql}) GROUP ALL`
  } else {
    countSql = compileCount(meta, args, binds, operation, {
      index: options.index,
    })
  }
  return {
    count,
    countSql,
    dataSql,
    limit,
    probe,
    projection: compiled.projection,
    start,
  }
}

/**
 * `cursor` args: a read with a required `limit` and optional `after`/`before` cursors. `select`
 * doesn't need the `orderBy` fields: the compiler appends reserved `_keyset_<n>` aliases for the
 * keyset columns it's missing, and the delegate reads the cursors from them and strips them from
 * the returned rows.
 */
export type CursorArgs = {
  after?: unknown
  before?: unknown
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  groupAll?: unknown
  /** Rejected: grouping doesn't paginate by keyset. */
  groupBy?: unknown
  /** Relation hydration (M3). */
  include?: unknown
  limit?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  /** Rejected: a cursor page is some rows. */
  only?: unknown
  orderBy?: unknown
  parallel?: unknown
  range?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  select?: unknown
  skip?: unknown
  split?: unknown
  /** Rejected: offsets are `paginate`'s job — the keyset moves with after/before. */
  start?: unknown
  take?: unknown
  timeout?: unknown
  /** Rejected: a VALUE projection is a scalar, not a keyset row. */
  value?: unknown
  version?: unknown
  where?: unknown
  with?: unknown
}

/** The compiled `cursor` plan. */
export type CursorPlan = {
  /** The page fetchs it in reverse; the delegate reverses the rows back. */
  readonly backward: boolean
  /**
   * Where each `orderBy` field rides in the RAW row: in place, or under a reserved
   * `_keyset_<n>` alias the delegate reads for the cursor and strips from `data`. Cursor values
   * are never codec-decoded (a `DateTime` keeps its nanoseconds).
   */
  readonly keyset: readonly CursorKey[]
  readonly limit: number
  readonly order: readonly CursorOrder[]
  readonly projection: ProjectionSpec
  readonly sql: string
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
  rejectPaginationArgs(args, operation)
  const limit = positiveInt(args.limit, "limit", operation)
  if (args.after !== undefined && args.before !== undefined) {
    throw compileError(
      "CursorDirectionConflict",
      `${operation}: pass "after" OR "before", not both — a cursor page moves one way.`,
      { operation },
    )
  }
  const backward = args.before !== undefined
  const cursor = backward ? args.before : args.after

  const order = cursorOrder(args.orderBy, meta, operation)
  const effective: readonly CursorOrder[] = backward
    ? order.map((entry) => ({
        direction: entry.direction === "asc" ? "desc" : "asc",
        field: entry.field,
      }))
    : order

  const predicate =
    cursor === undefined
      ? undefined
      : cursorComparison(effective, cursorValues(meta, order, cursor, operation))
  let where: unknown = args.where
  if (predicate !== undefined) where = where === undefined ? predicate : { AND: [where, predicate] }

  const keyset = keysetProjection(meta, args.select, args.omit, order, operation)
  const compiled = compileRead(
    meta,
    {
      ...args,
      groupAll: undefined,
      groupBy: undefined,
      limit: limit + 1,
      orderBy: effective.map((entry) => ({
        [entry.field]: entry.direction,
      })),
      split: undefined,
      start: undefined,
      where,
    },
    binds,
    operation,
    { aliases: keyset.aliases, index: options.index },
  )
  return {
    backward,
    keyset: keyset.keys,
    limit,
    order,
    projection: compiled.projection,
    sql: compiled.sql,
  }
}

/** Reject the clauses cursor can't keyset over (plus the removed/renamed args). */
function rejectPaginationArgs(args: CursorArgs, operation: string): void {
  rejectRemovedArgs(args, operation)

  ;(["groupBy", "groupAll", "split"] as const).forEach((key) => {
    if (args[key] !== undefined) {
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "${key}" is not supported with cursor pagination — use paginate() or $query.`,
        { operation },
      )
    }
  })
  if (args.value === true) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: "value" is not supported with cursor pagination — a VALUE row is a scalar, not a keyset row.`,
      { operation },
    )
  }
  if (args.only === true) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: "only" is not supported with cursor pagination — a cursor page is many rows. Use findUnique for a single row.`,
      { operation },
    )
  }
  if (args.start !== undefined) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: "start" is not supported with cursor pagination — the keyset moves with after/before. Use paginate for offset pages.`,
      { operation },
    )
  }
}

/** Parse `orderBy` into plain field/direction entries (default: `id asc`). */
function cursorOrder(orderBy: unknown, meta: ModelMeta, operation: string): readonly CursorOrder[] {
  const order: CursorOrder[] = []
  if (orderBy === undefined) order.push({ direction: "asc", field: "id" })
  else {
    const entries = Array.isArray(orderBy) ? orderBy : [orderBy]

    entries.forEach((entry) => {
      if (!isPlainObject(entry)) {
        throw compileError(
          "CursorTiebreakerRequired",
          `${operation}: orderBy entries must be plain fields ({ field: "asc" | "desc" }) — fragments can't build a keyset cursor.`,
          { operation },
        )
      }

      Object.entries(entry).forEach(([field, direction]) => {
        if (direction === undefined) return

        if (direction !== "asc" && direction !== "desc") {
          throw compileError(
            "CursorTiebreakerRequired",
            `${operation}: orderBy direction for "${field}" must be "asc" or "desc" — expressions can't build a keyset cursor.`,
            { operation },
          )
        }
        order.push({ direction, field })
      })
    })
  }
  if (order.length === 0) {
    throw compileError(
      "CursorTiebreakerRequired",
      `${operation}: orderBy is empty — the cursor needs an ordering with a unique tiebreaker.`,
      { operation },
    )
  }
  const last = order.at(-1)
  if (last === undefined || !isUniqueField(meta, last.field)) {
    const field = last?.field ?? "(none)"
    throw compileError(
      "CursorTiebreakerRequired",
      `${operation}: the last orderBy field must be unique (got "${field}") — add "{ id: "asc" }" as the tiebreaker.`,
      { operation },
    )
  }
  return order
}

/** Is this field guaranteed unique (`id`, or a single-field UNIQUE index)? */
function isUniqueField(meta: ModelMeta, field: string): boolean {
  return field === "id" || uniqueFields(meta).includes(field)
}

/** Normalize the cursor value to one value per order field, coerced to the column's WIRE value. */
function cursorValues(
  meta: ModelMeta,
  order: readonly CursorOrder[],
  cursor: unknown,
  operation: string,
): readonly unknown[] {
  const singleId = order.length === 1 && order[0].field === "id"
  if (singleId && !isPlainObject(cursor)) return [coerceCursorValue(meta, "id", cursor, operation)]

  if (!isPlainObject(cursor)) {
    throw compileError(
      "ValidationError",
      `${operation}: the cursor for a ${order.length}-field ordering must be an object like { ${order
        .map((entry) => `${entry.field}: …`)
        .join(", ")} } (got ${describeValue(cursor)}).`,
      { operation },
    )
  }
  return order.map((entry) => {
    if (!(entry.field in cursor)) {
      throw compileError(
        "ValidationError",
        `${operation}: the cursor is missing "${entry.field}" — every orderBy field needs a value.`,
        { operation },
      )
    }
    return coerceCursorValue(meta, entry.field, cursor[entry.field], operation)
  })
}

/**
 * Coerce a cursor value to the column's WIRE value before binding: a record column takes a
 * `RecordId` (bare/`table:id` strings and numbers included), a datetime takes a `DateTime`
 * (string/`Date` accepted). The keyset compares type-vs-type, so a raw string would
 * not filter.
 */
function coerceCursorValue(
  meta: ModelMeta,
  field: string,
  value: unknown,
  operation: string,
): unknown {
  if (value === undefined || !isTableMeta(meta)) return value

  const column = meta.columns.get(baseColumn(field))
  if (!column) return value

  if (column.family === "record" || column.record)
    return coerceRecordValue(value, column.record?.targets, operation, `cursor "${field}"`)

  if (column.family === "date") {
    if (value instanceof DateTime) return value

    if (value instanceof Date) return new DateTime(value)

    if (typeof value === "string") {
      try {
        return new DateTime(value)
      } catch {
        throw compileError(
          "ValidationError",
          `${operation}: the cursor for "${field}" must be a Date, DateTime or ISO-8601 string (got ${describeValue(value)}).`,
          { field, operation },
        )
      }
    }
  }
  return value
}

/**
 * `(a < $x) OR (a = $x AND (b < $y OR (b = $y AND id < $z)))` — the direction-aware tuple compare,
 * as a fragment with its OWN binds (merged into the read's bind map by `compileWhere`).
 */
function cursorComparison(order: readonly CursorOrder[], values: readonly unknown[]): BoundQuery {
  const cursorBinds = createBinds("c")
  const refs = values.map((value) => cursorBinds.add(value))
  const compare = (index: number): string => {
    const entry = order[index]
    const field = renderPath(entry.field)
    const op = entry.direction === "asc" ? ">" : "<"
    const ref = refs[index]
    const head = `${field} ${op} ${ref}`
    if (index === order.length - 1) return head

    const rest = `${head} OR (${field} = ${ref} AND ${compare(index + 1)})`
    return index === 0 ? rest : paren(rest)
  }
  return new BoundQuery(compare(0), cursorBinds.vars)
}
