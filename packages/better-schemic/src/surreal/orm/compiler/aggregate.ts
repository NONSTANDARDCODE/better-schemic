/**
 * `count` / `exists` / `aggregate` — the three clause compilers, minus the `select` entry dispatch.
 *
 * The `select` loop, the operator table, the shared guards and the clause tail all live in
 * `aggregate-entries.ts`, because `aggregate({ split })` compiles the same `select` through a
 * different lowering (`aggregate-split.ts`). Keeping ONE copy is deliberate: two copies would let a
 * new aggregator land in one and silently disagree with the other.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident"

import {
  aggregateTail,
  assertAggregateShape,
  assertGroupKeysProjected,
  compileAggregateSelect,
  directColumns,
} from "./aggregate-entries"
import { assertAggregateOperand } from "./aggregate-operand"
import { compileSplitAggregate } from "./aggregate-split"
import {
  compileError,
  compileWithClause,
  datetimeLiteral,
  durationLiteral,
  isTableMeta,
  pathList,
  rangeTarget,
  rejectRemovedArgs,
  renderPath,
} from "./shared"
import { compileWhere, mergeScope } from "./where"

import type { ModelMeta, SchemaIndex } from "../meta"
import type { ProjectionSpec } from "./projection"
import type { Binds } from "./shared"

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export interface CountArgs {
  where?: unknown
  range?: unknown
  with?: unknown
  timeout?: unknown
  version?: unknown
  meta?: Record<string, unknown>
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown
  take?: unknown
  skip?: unknown
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

/** The clauses `aggregate` accepts (having does NOT exist in SurrealQL — rejected). */

export interface AggregateArgs {
  where?: unknown
  select?: unknown
  groupBy?: unknown
  groupAll?: unknown
  orderBy?: unknown
  limit?: unknown
  start?: unknown
  with?: unknown
  timeout?: unknown
  version?: unknown
  meta?: Record<string, unknown>
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  /** Not expressible in SurrealQL — always rejected with `HavingUnsupported`. */
  having?: unknown
  /** UNWIND the rows by this array/set field, then group (see `aggregate-split.ts`). */
  split?: unknown
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown
  take?: unknown
  skip?: unknown
}

/** A compiled aggregate: the statement + how to decode its rows. */
export interface CompiledAggregate {
  readonly sql: string
  readonly projection: ProjectionSpec
}

/**
 * `aggregate` — `SELECT <agregadores> FROM t [WHERE] GROUP BY/ALL [ORDER BY] [LIMIT/START]`.
 *
 * `having` is rejected (SurrealQL has no HAVING); with neither `groupBy` nor `groupAll`, `GROUP ALL`
 * is implied (one row over the whole filter, the natural aggregate default).
 *
 * `split` takes the UNWIND-then-GROUP path (`aggregate-split.ts`) because the server evaluates
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

  const groupBy = assertAggregateShape(args, operation),
    { parts, fields, projectedKeys, hasExpression } = compileAggregateSelect(
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
  // With a teaching error when the projection is statically analyzable. Both forms are valid group
  // Keys (live-verified): the OUTPUT KEY of an alias (`SELECT tenant AS t … GROUP BY t`) and the
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
    sql: statement.join(" "),
    projection: { star: false, fields, omit: [], value: false, includes: [] },
  }
}

// Keep the operand guard reachable from this module's own namespace: it is the policy half of the
// Aggregate compiler, re-exported so `reads.ts` can validate an operand without importing the
// Lowering internals.
export { assertAggregateOperand, pathList, renderPath }
