/**
 * `count` / `exists` / `combine` — the three clause compilers, minus the `select` entry dispatch.
 *
 * The `select` loop, the operator table, the shared guards and the clause tail all live in
 * `combine-entries.ts`, because `combine({ split })` compiles the same `select` through a
 * different lowering (`combine-split.ts`). Keeping ONE copy is deliberate: two copies would let a
 * new aggregator land in one and  disagree with the other.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident"
import type { ModelMeta, SchemaIndex } from "../meta"

import {
  aggregateTail,
  assertAggregateShape,
  assertGroupKeysProjected,
  compileAggregateSelect,
  directColumns,
} from "./aggregate-entries"
import { compileSplitAggregate } from "./aggregate-split"
import type { ProjectionSpec } from "./projection"
import {
  type Binds,
  compileError,
  compileWithClause,
  datetimeLiteral,
  durationLiteral,
  isTableMeta,
  rangeTarget,
  rejectRemovedArgs,
} from "./shared"
import { compileWhere, mergeScope } from "./where"

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export type CountArgs = {
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  meta?: Record<string, unknown>
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown
  range?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  skip?: unknown
  take?: unknown
  timeout?: unknown
  version?: unknown
  where?: unknown
  with?: unknown
}

/** The `FROM` target of `count`/`exists`: the table, or a record range (`t:1..=2`). */
function aggregateTarget(meta: ModelMeta, range: unknown, operation: string): string {
  return range === undefined ? escapeIdent(meta.name) : rangeTarget(meta, range, operation)
}

/** `SELECT count() FROM <target> [WHERE …] GROUP ALL [VERSION …] [TIMEOUT …]`. */
export function compileCount(
  meta: ModelMeta,
  args: CountArgs,
  binds: Binds,
  operation = "count",
  options: { readonly index?: SchemaIndex } = {},
): string {
  rejectRemovedArgs(args, operation)
  const parts: string[] = ["SELECT count()", `FROM ${aggregateTarget(meta, args.range, operation)}`]
  if (args.with !== undefined) parts.push(compileWithClause(args.with, operation))

  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
  })
  if (where) parts.push(`WHERE ${where}`)

  parts.push("GROUP ALL")
  if (args.version !== undefined) parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`)

  if (args.timeout !== undefined) parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`)

  return parts.join(" ")
}

/** `SELECT VALUE id FROM <target> [WHERE …] LIMIT 1 [VERSION …] [TIMEOUT …]`. */
export function compileExists(
  meta: ModelMeta,
  args: CountArgs,
  binds: Binds,
  operation = "exists",
  options: { readonly index?: SchemaIndex } = {},
): string {
  rejectRemovedArgs(args, operation)
  const parts: string[] = [
    "SELECT VALUE id",
    `FROM ${aggregateTarget(meta, args.range, operation)}`,
  ]
  if (args.with !== undefined) parts.push(compileWithClause(args.with, operation))

  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
  })
  if (where) parts.push(`WHERE ${where}`)

  parts.push(`LIMIT ${binds.add(1)}`)
  if (args.version !== undefined) parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`)

  if (args.timeout !== undefined) parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`)

  return parts.join(" ")
}

/** The clauses `combine` accepts (having does NOT exist in SurrealQL — rejected). */

export type AggregateArgs = {
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  groupAll?: unknown
  groupBy?: unknown
  /** Not expressible in SurrealQL — always rejected with `HavingUnsupported`. */
  having?: unknown
  limit?: unknown
  meta?: Record<string, unknown>
  orderBy?: unknown
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  select?: unknown
  skip?: unknown
  /** UNWIND the rows by this array/set field, then group (see `combine-split.ts`). */
  split?: unknown
  start?: unknown
  take?: unknown
  timeout?: unknown
  version?: unknown
  where?: unknown
  with?: unknown
}

/** A compiled combine: the statement + how to decode its rows. */
export type CompiledAggregate = {
  readonly projection: ProjectionSpec
  readonly sql: string
}

/**
 * `combine` — `SELECT <agregadores> FROM t [WHERE] GROUP BY/ALL [ORDER BY] [LIMIT/START]`.
 *
 * `having` rejects it (SurrealQL has no HAVING); with neither `groupBy` nor `groupAll`, `GROUP ALL`
 * implis it (one row over the whole filter, the natural combine default).
 *
 * `split` takes the UNWIND-then-GROUP path (`combine-split.ts`) because the server evaluates
 * `SPLIT` before `GROUP` and refuses them together.
 */
export function compileAggregate(
  meta: ModelMeta,
  args: AggregateArgs,
  binds: Binds,
  operation = "aggregate",
  options: { readonly index?: SchemaIndex } = {},
): CompiledAggregate {
  rejectRemovedArgs(args, operation)
  if (args.having !== undefined) {
    throw compileError(
      "HavingUnsupported",
      `${operation}: HAVING does not exist in SurrealQL — filter the grouped rows with a subquery via $query, or aggregate in two steps.`,
      { operation },
    )
  }
  if (args.split !== undefined) {
    if (typeof args.split !== "string" || args.split.trim().length === 0) {
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "split" must be a field path (an array/set field to unfold) — SurrealDB evaluates SPLIT before GROUP, and only a field is a valid split idiom.`,
        { operation },
      )
    }
    return compileSplitAggregate(meta, args, binds, operation, options)
  }

  const groupBy = assertAggregateShape(args, operation)
  const { fields, hasExpression, parts, projectedKeys } = compileAggregateSelect(
    meta,
    args.select as Record<string, unknown>,
    binds,
    operation,
    directColumns(meta),
  )
  if (parts.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one aggregator or group key.`,
      { operation },
    )
  }
  // SurrealDB requires every GROUP BY key in the projection ("Missing group idiom"); catch it here
  // with a teaching error when the projection is statically analyzable. Both forms are valid group
  // keys (live-verified): the OUTPUT KEY of an alias (`SELECT tenant AS t … GROUP BY t`) and the
  // PATH it projects (`… GROUP BY tenant`) — so the check accepts either spelling.
  assertGroupKeysProjected(groupBy, projectedKeys, hasExpression, operation)

  const statement: string[] = [`SELECT ${parts.join(", ")}`, `FROM ${escapeIdent(meta.name)}`]
  if (args.with !== undefined) statement.push(compileWithClause(args.with, operation))

  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
  })
  if (where) statement.push(`WHERE ${where}`)

  statement.push(...aggregateTail(args, groupBy, binds, operation, { version: true }))

  return {
    projection: { fields, includes: [], omit: [], star: false, value: false },
    sql: statement.join(" "),
  }
}

// Keep the operand guard reachable from this module's own namespace: it's the policy half of the
// combine compiler, re-exported so `reads.ts` can check an operand without importing the
// lowering internals.
export { assertAggregateOperand } from "./aggregate-operand"
export { pathList, renderPath } from "./shared"
