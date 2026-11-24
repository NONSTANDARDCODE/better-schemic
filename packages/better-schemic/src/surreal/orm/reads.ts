/**
 * The read operations of a delegate — `findMany`/`findFirst`/`findOne`/`findUnique`/`count`/
 * `exists`/`combine`/`paginate`/`cursor`. Every op compiles at call time (a bad arg throws at the call
 * site), runs  (nothing touches the connection until awaited), and decodes its rows through
 * `./decode`. `./delegate` owns the public surface; this module owns the runtime.
 */
import { RecordId, type RecordIdValue } from "surrealdb"

import { escapeIdentSafe as escapeIdent } from "../ident"
import { bareIdValue } from "../pure"

import type {
  AggregateArgs as AggregateRuntimeArgs,
  CountArgs as CountRuntimeArgs,
} from "./compiler/aggregate"
import { compileAggregate, compileCount, compileExists } from "./compiler/aggregate"
import type { CursorKey } from "./compiler/keyset"
import type {
  CursorArgs as CursorRuntimeArgs,
  PaginateArgs as PaginateRuntimeArgs,
} from "./compiler/pagination"
import { compileCursor, compilePaginate } from "./compiler/pagination"
import type { CompileReadOptions, ReadArgs } from "./compiler/select"
import { compileRead } from "./compiler/select"
import {
  baseColumn,
  type Binds,
  compileError,
  createBinds,
  isTableMeta,
  pathSegments,
} from "./compiler/shared"
import { uniqueTarget } from "./compiler/unique"
import { contextOption, resolveMeta } from "./context"
import { decodeRow, decodeRows, isRecord } from "./decode"
import type { DelegateContext } from "./delegate"
import { execute, sqlPreview, type Statement } from "./execute"
import { runWithHooks } from "./hooks"
import type { ModelMeta } from "./meta"
import {
  attachExplain,
  attachSql,
  attachThrow,
  type ExplainKey,
  type ExplainResult,
  lazyResult,
  type ThrowingResult,
} from "./results"
import type { OperationContext } from "./types/context"
import type { OperationKind } from "./types/hooks"

/** The read methods a delegate exposes (the runtime side of the typed `Delegate` interface). */
export function createReadOperations(
  meta: ModelMeta,
  ctx: DelegateContext,
): Record<string, unknown> {
  return {
    aggregate: (args: AggregateRuntimeArgs) => finishRead(ctx, aggregatePlan(meta, ctx, args)),
    count: (args: CountRuntimeArgs = {}) => finishRead(ctx, countPlan(meta, ctx, args)),
    cursor: (args: CursorRuntimeArgs) => finishRead(ctx, cursorPlan(meta, ctx, args)),
    exists: (args: CountRuntimeArgs = {}) => finishRead(ctx, existsPlan(meta, ctx, args)),
    findFirst: (args: ReadArgs = {}) =>
      finishRead(ctx, prepare(meta, ctx, args, "findFirst", { one: true })),
    findMany: (args: ReadArgs = {}) => finishRead(ctx, prepare(meta, ctx, args, "findMany")),
    findOne: (args: ReadArgs = {}) =>
      finishRead(ctx, prepare(meta, ctx, args, "findOne", { one: true })),
    findUnique: (args: ReadArgs) => finishRead(ctx, prepareUnique(meta, ctx, args)),
    paginate: (args: PaginateRuntimeArgs) => finishRead(ctx, paginatePlan(meta, ctx, args)),
  }
}

/** The runtime context every prepared read derives from its args. */
type ReadRuntimeArgs = {
  /** Per-call namespace/database override (`findMany({ context: { database } })`). */
  readonly context?: OperationContext
  readonly explain?: unknown
  /** Per-call hook metadata (`findMany({ meta })`). */
  readonly meta?: Record<string, unknown>
  readonly where?: unknown
}

/** One statement of a prepared read with its `ExplainResult` role. */
type PreparedStatement = {
  readonly key: ExplainKey
  readonly statement: Statement
}

/** A compiled read plus everything the executor/`.throw()`/`.explain()` needs. */
type PreparedRead = {
  /** Per-call scope override, resolved against the client's context at run time. */
  readonly context?: OperationContext
  /** Interpret the raw rows of the prepared statements. */
  readonly decode: (rows: readonly unknown[]) => unknown
  /** `explain: true` — return the plan instead of executing. */
  readonly explain: boolean
  /** Per-call hook metadata (merged over the scope's at run time). */
  readonly hookMeta?: Record<string, unknown>
  readonly meta: ModelMeta
  readonly operation: string
  /** One row (throwing wrapper) vs some. */
  readonly resultMode: "many" | "one"
  readonly statements: readonly PreparedStatement[]
  /** The filter, for `NotFoundInfo` (`.throw()`). */
  readonly where?: unknown
}

/** Wrap compiled SQL + the shared binds into a keyed prepared statement. */
const stmt = (sql: string, binds: Binds, key: ExplainKey): PreparedStatement => ({
  key,
  statement: { sql, vars: binds.vars },
})

/** Compile a read into its statement + decode spec (eager — a bad arg throws here). */
function prepare(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: ReadArgs,
  operation: string,
  options: {
    compile?: CompileReadOptions
    one?: boolean
    /** Override the result mode (findUnique's id path is "one" without forcing a LIMIT). */
    resultMode?: "many" | "one"
  } = {},
): PreparedRead {
  const binds = createBinds()
  const effective = options.one ? { ...args, limit: args.limit ?? 1 } : args
  const compiled = compileRead(meta, effective, binds, operation, {
    ...options.compile,
    index: ctx.index,
  })
  const decode = (rows: readonly unknown[]): unknown => {
    const raw = rows[0]
    if (compiled.only) return decodeRow(raw, meta, compiled.projection, ctx.index) ?? null

    const page = Array.isArray(raw) ? raw : []
    if (options.one === true)
      return page.length === 0 ? null : decodeRow(page[0], meta, compiled.projection, ctx.index)

    return decodeRows(page, meta, compiled.projection, ctx.index)
  }
  return prepared(meta, operation, [stmt(compiled.sql, binds, "data")], args, {
    decode,
    resultMode: options.resultMode ?? (options.one ? "one" : "many"),
  })
}

/** Assemble a prepared read from its statements + decoder. */
function prepared(
  meta: ModelMeta,
  operation: string,
  statements: readonly PreparedStatement[],
  args: ReadRuntimeArgs,
  extras: {
    decode: (rows: readonly unknown[]) => unknown
    resultMode: "many" | "one"
  },
): PreparedRead {
  return {
    decode: extras.decode,
    explain: args.explain === true,
    meta,
    operation,
    resultMode: extras.resultMode,
    statements,
    where: args.where,
    ...(args.context ? { context: args.context } : {}),
    ...(args.meta === undefined ? {} : { hookMeta: args.meta }),
  }
}

/** The rows of a statement index, as an array. */
const rowsAt = (rows: readonly unknown[], index: number): readonly unknown[] => {
  const raw = rows[index]
  return Array.isArray(raw) ? raw : []
}

const countDecode = (rows: readonly unknown[]): unknown => {
  const first = rowsAt(rows, 0)[0] as undefined | { count?: unknown }
  return typeof first?.count === "number" ? first.count : 0
}

const existsDecode = (rows: readonly unknown[]): unknown => rowsAt(rows, 0).length > 0

/** `count` plan: `[{ count: n }]` -> `n` (0 when the server returns nothing). */
function countPlan(meta: ModelMeta, ctx: DelegateContext, args: CountRuntimeArgs): PreparedRead {
  const binds = createBinds()
  const sql = compileCount(meta, args, binds, "count", { index: ctx.index })
  return prepared(meta, "count", [stmt(sql, binds, "count")], args, {
    decode: countDecode,
    resultMode: "many",
  })
}

/** `exists` plan: `SELECT VALUE id … LIMIT 1` -> whether any row came back. */
function existsPlan(meta: ModelMeta, ctx: DelegateContext, args: CountRuntimeArgs): PreparedRead {
  const binds = createBinds()
  const sql = compileExists(meta, args, binds, "exists", { index: ctx.index })
  return prepared(meta, "exists", [stmt(sql, binds, "exists")], args, {
    decode: existsDecode,
    resultMode: "many",
  })
}

/** `combine` plan: decode the grouped rows through the per-entry projection. */
function aggregatePlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: AggregateRuntimeArgs,
): PreparedRead {
  const binds = createBinds()
  const compiled = compileAggregate(meta, args, binds, "aggregate", {
    index: ctx.index,
  })
  const decode = (rows: readonly unknown[]): unknown =>
    decodeRows(rowsAt(rows, 0), meta, compiled.projection, ctx.index)
  return prepared(meta, "aggregate", [stmt(compiled.sql, binds, "data")], args, {
    decode,
    resultMode: "many",
  })
}

/** `paginate` plan: data + count in ONE round-trip; `count:false` probes `n+1` for `hasNext`. */
function paginatePlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: PaginateRuntimeArgs,
): PreparedRead {
  const binds = createBinds()
  const plan = compilePaginate(meta, args, binds, "paginate", {
    index: ctx.index,
  })
  const statements: PreparedStatement[] = [
    stmt(plan.dataSql, binds, "data"),
    ...(plan.countSql ? [stmt(plan.countSql, binds, "total")] : []),
  ]
  const decode = (rows: readonly unknown[]): unknown => {
    const pageRows = rowsAt(rows, 0)
    const data = decodeRows(
      plan.probe ? pageRows.slice(0, plan.limit) : pageRows,
      meta,
      plan.projection,
      ctx.index,
    )
    let total: number | undefined
    if (plan.count) {
      const first = rowsAt(rows, 1)[0] as undefined | { count?: unknown }
      total = typeof first?.count === "number" ? first.count : 0
    }
    const totalCount = total ?? 0
    const hasNext = plan.count
      ? totalCount > plan.start + data.length
      : pageRows.length > plan.limit
    return {
      data,
      pagination: {
        page: Math.floor(plan.start / plan.limit) + 1,
        perPage: plan.limit,
        type: "offset",
        ...(plan.count ? { pageCount: Math.ceil(totalCount / plan.limit), total } : {}),
        hasNext,
        hasPrevious: plan.start > 0,
      },
    }
  }
  return prepared(meta, "paginate", statements, args, {
    decode,
    resultMode: "many",
  })
}

/** `cursor` plan: one probe statement; `before` flips the order and the rows back. */
function cursorPlan(meta: ModelMeta, ctx: DelegateContext, args: CursorRuntimeArgs): PreparedRead {
  const binds = createBinds()
  const plan = compileCursor(meta, args, binds, "cursor", { index: ctx.index })
  const decode = (rows: readonly unknown[]): unknown => {
    const pageRows = rowsAt(rows, 0)
    const hasMore = pageRows.length > plan.limit
    const probe = pageRows.slice(0, plan.limit)
    const decoded = decodeRows(probe, meta, plan.projection, ctx.index)
    const data = plan.backward ? [...decoded].reverse() : decoded
    // The cursors carry the STORED value, so they read the RAW probe rows paired positionally
    // with `data` (both reversed for `before`) — never the codec-decoded app value. A datetime
    // field keeps its nanoseconds (`Date` would truncate to ms, and the keyset predicate would
    // then skip every row created in the same millisecond).
    const raw = plan.backward ? [...probe].reverse() : probe
    const hasPrevious = plan.backward
      ? hasMore
      : args.after !== undefined || args.before !== undefined
    const hasNext = plan.backward ? true : hasMore
    const nextCursor = hasNext ? cursorOf(meta, raw.at(-1), plan.keyset) : null
    const previousCursor = hasPrevious ? cursorOf(meta, raw[0], plan.keyset) : null
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const row of data) stripKeyset(row, plan.keyset)

    return {
      data,
      pagination: {
        hasNext,
        hasPrevious,
        nextCursor,
        previousCursor,
        type: "cursor",
      },
    }
  }
  return prepared(
    meta,
    "cursor",
    [stmt(plan.sql, binds, plan.backward ? "probe:hasPrevious" : "probe:hasNext")],
    args,
    { decode, resultMode: "many" },
  )
}

/** Extract a row's cursor value (the id for a single-id order, a tuple otherwise). */
function cursorOf(meta: ModelMeta, row: unknown, keyset: readonly CursorKey[]): unknown {
  if (row === undefined || row === null) return null

  if (keyset.length === 1 && keyset[0]?.field === "id")
    return cursorValueOf(meta, keyset[0], keysetValue(row, keyset[0]))

  const tuple: Record<string, unknown> = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const key of keyset) {
    const value = cursorValueOf(meta, key, keysetValue(row, key))
    if (value === undefined) {
      throw compileError(
        "ValidationError",
        `cursor: the raw row is missing "${key.field}" — the server returned no value for an orderBy field (a NONE keyset value can't build a cursor).`,
        { field: key.field, operation: "cursor" },
      )
    }
    tuple[key.field] = value
  }
  return tuple
}

/**
 * The cursor's APP representation of a keyset value: a string-id record column returns the bare
 * string (`01M…`); everything else keeps the raw stored value (a `DateTime` keeps its nanoseconds).
 */
function cursorValueOf(meta: ModelMeta, key: CursorKey, value: unknown): unknown {
  if (!(value instanceof RecordId) || !isTableMeta(meta)) return value

  const column = meta.columns.get(baseColumn(key.field))
  if (!column?.record?.stringIds) return value

  return bareIdValue(value.id as RecordIdValue)
}

/**
 * Read one keyset value off a raw row: the reserved alias, or the field itself — its nested
 * path, falling back to the flat key a same-path `select` alias lands under.
 */
function keysetValue(row: unknown, key: CursorKey): unknown {
  if (key.alias !== undefined) return isRecord(row) ? row[key.alias] : undefined

  const nested = readPath(row, pathSegments(key.field))
  if (nested !== undefined) return nested

  return isRecord(row) ? row[key.field] : undefined
}

/** Remove the reserved keyset aliases the compiler appended (they aren't part of the result). */
function stripKeyset(row: unknown, keyset: readonly CursorKey[]): void {
  if (!isRecord(row)) return

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const key of keyset) if (key.alias !== undefined) Reflect.deleteProperty(row, key.alias)
}

/** Read a dotted path off a raw row (`undefined` when an ancestor is missing or a scalar). */
function readPath(value: unknown, segments: readonly string[]): unknown {
  let current: unknown = value
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const segment of segments) {
    if (!isRecord(current)) return undefined

    current = current[segment]
  }
  return current
}

/** `findUnique`: target the record (id) or filter by the unique field, then take the one row. */
function prepareUnique(meta: ModelMeta, ctx: DelegateContext, args: ReadArgs): PreparedRead {
  const target = uniqueTarget(meta, args.where)
  if (target.kind === "id") {
    return prepare(meta, ctx, { ...args, only: true, where: undefined }, "findUnique", {
      compile: { target: `ONLY ${escapeIdent(meta.name)}:${target.id}` },
      resultMode: "one",
    })
  }
  return prepare(
    meta,
    ctx,
    {
      ...args,
      // A single-field target narrows to that equality; a composite one keeps the whole conjunction
      // (its fields ARE the unique key).
      where:
        target.kind === "field"
          ? { [target.field]: target.value }
          : Object.fromEntries(target.entries),
    },
    "findUnique",
    { one: true },
  )
}

/** Run a prepared read (one round-trip) and decode its result. */
async function runPrepared(ctx: DelegateContext, prepared: PreparedRead): Promise<unknown> {
  const hooks = ctx.hooks
  const first = prepared.statements[0]?.statement
  const meta = hooks ? resolveMeta(ctx, prepared.context, prepared.hookMeta) : undefined
  return runWithHooks(
    hooks,
    {
      operation: prepared.operation as OperationKind,
      table: prepared.meta.name,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tabela sem nome em runtime cairia em undefined; fallback defensivo
      ...(first ? { surql: first.sql, vars: first.vars ?? {} } : {}),
      ...(meta ? { meta } : {}),
    },
    async () => {
      const out = await execute(ctx.conn, {
        debug: ctx.debug,
        logger: ctx.logger,
        operation: prepared.operation,
        statements: prepared.statements.map((entry) => entry.statement),
        table: prepared.meta.name,
        ...contextOption(ctx, prepared.context),
      })
      return prepared.decode(out.rows)
    },
  )
}

/** Run `EXPLAIN` for every prepared statement (ONE round-trip) — never the real query. */
async function explainPrepared(
  ctx: DelegateContext,
  prepared: PreparedRead,
): Promise<ExplainResult> {
  const out = await execute(ctx.conn, {
    debug: ctx.debug,
    logger: ctx.logger,
    operation: prepared.operation,
    phase: "explain",
    statements: prepared.statements.map(({ statement }) => ({
      sql: `EXPLAIN ${statement.sql}`,
      vars: statement.vars,
    })),
    table: prepared.meta.name,
    ...contextOption(ctx, prepared.context),
  })
  return {
    driver: "surrealdb",
    ignoredOptions: [],
    operation: prepared.operation,
    statements: prepared.statements.map(({ key, statement }, index) => ({
      key,
      plan: out.rows[index],
      surql: statement.sql,
      vars: statement.vars ?? {},
    })),
  }
}

/**
 * Finish a read: `explain: true` returns the plan instead of executing; otherwise the lazy result
 * gets `.explain()` attached (which runs EXPLAIN without starting the real statement).
 */
function finishRead(ctx: DelegateContext, prepared: PreparedRead): unknown {
  const preview = () =>
    sqlPreview(
      prepared.statements.map((entry) => entry.statement),
      {
        operation: prepared.operation,
        table: prepared.meta.name,
        ...contextOption(ctx, prepared.context),
      },
    )
  if (ctx.compileOnly) return preview()

  const result = prepared.explain
    ? explainPrepared(ctx, prepared)
    : attachExplain(
        prepared.resultMode === "one"
          ? throwingPrepared(ctx, prepared)
          : lazyPrepared(ctx, prepared),
        () => explainPrepared(ctx, prepared),
      )
  return attachSql(result, preview)
}

/** A lazy read (runs on await). */
function lazyPrepared(ctx: DelegateContext, prepared: PreparedRead): Promise<unknown> {
  return lazyResult(() => runPrepared(ctx, prepared))
}

/** A lazy read with `.throw()` attached (the miss carries `NotFoundInfo`). */
function throwingPrepared(ctx: DelegateContext, prepared: PreparedRead): ThrowingResult<unknown> {
  return attachThrow(lazyPrepared(ctx, prepared), () => ({
    operation: prepared.operation,
    surql: prepared.statements[0]?.statement.sql,
    table: prepared.meta.name,
    vars: ctx.debug ? prepared.statements[0]?.statement.vars : undefined,
    where: prepared.where,
  }))
}
