/**
 * The write operations of a delegate — `create`/`createMany`/`insert`/`insertMany`/`update`/
 * `updateMany`/`patch`/`upsert`/`upsertMany`/`delete`/`deleteMany`/`updateEach` plus the edge
 * operations `relate`/`relateMany`/`unrelate`/`unrelateMany`.
 *
 * Every op compiles at call time (a bad arg throws at the call site) and runs at once (writes have
 * no `.explain()` — `EXPLAIN` is SELECT-, `orm-syntax-map.md` §9). `./delegate` owns the public
 * surface; this module owns the runtime, mirroring `./reads`.
 *
 * Decoding interprets it from the plan ONCE — `none`/`diff`/rows (indexed by the plan) — so every
 * op shares the same `payloadRows`/`payloadDiff` rules instead of re-deriving them.
 */

import {
  compileDelete,
  compileDeleteMany,
  compilePatch,
  compileUpdate,
  compileUpdateEach,
  compileUpdateMany,
  compileUpsert,
  compileUpsertDelta,
  compileUpsertMany,
} from "./compiler/mutate"
import { fullProjectionSpec, type ProjectionSpec } from "./compiler/projection"
import {
  compileRelate,
  compileRelateMany,
  compileUnrelate,
  compileUnrelateMany,
  type RelateRuntimeArgs,
} from "./compiler/relate"
import { type Binds, createBinds } from "./compiler/shared"
import {
  compileCreate,
  compileCreateMany,
  compileInsert,
  compileInsertMany,
} from "./compiler/write"
import type {
  CreateManyRuntimeArgs,
  CreateRuntimeArgs,
  DeleteManyRuntimeArgs,
  DeleteRuntimeArgs,
  InsertRuntimeArgs,
  UpdateEachRuntimeArgs,
  UpdateManyRuntimeArgs,
  UpdateRuntimeArgs,
  UpsertDeltaRuntimeArgs,
  UpsertManyRuntimeArgs,
  UpsertRuntimeArgs,
  WritePlan,
} from "./compiler/write-shared"
import { contextOption, resolveMeta } from "./context"
import { decodeRows, isRecord } from "./decode"
import type { DelegateContext } from "./delegate"
import { computeFieldDelta } from "./delta"
import { OrmError } from "./errors"
import { execute, sqlPreview, type Statement } from "./execute"
import { runWithHooks } from "./hooks"
import type { ModelMeta } from "./meta"
import { attachThrow, type BatchResult, type NotFoundInfo } from "./results"
import type { OperationContext } from "./types/context"
import type { OperationKind } from "./types/hooks"

/** The full-row decode every write returns (writes have no projections — except `select`). */
const FULL: ProjectionSpec = fullProjectionSpec()

/**
 * The decode spec of a prepared write: the full row when no `select`/`omit` gives it, else the
 * compiled projection. A CLIENT-applied projection (BEFORE state, `delete`, `upsertDelta`, OMIT)
 * reads aliases from their schema path (`from`) instead of the server's output key (`source`) —
 * the rows were not projected by the server, so the alias  doesn't exist.
 */
function writeSpec(plan: WritePlan): ProjectionSpec {
  const spec = plan.select
  if (!spec || plan.selectMode !== "client") return spec ?? FULL

  return {
    ...spec,
    fields: spec.fields.map((field) => (field.from ? { ...field, source: field.from } : field)),
  }
}

/** One prepared write: statements + how to interpret the executor's rows. */
type PreparedWrite = {
  /** Per-call scope override, resolved against the client's context at run time. */
  readonly context?: OperationContext
  /** The write payload, for `beforeCreate`/`beforeUpdate` hooks. */
  readonly data?: unknown
  readonly decode: (rows: readonly unknown[]) => unknown
  /** The plan returns the `{ before, after }` envelope (`upsertDelta` decodes it itself). */
  readonly delta: boolean
  /** Per-call hook metadata (merged over the scope's at run time). */
  readonly hookMeta?: Record<string, unknown>
  /** The compiled plan says the singular row may be absent (`.throw()` attaches). */
  readonly mayMiss: boolean
  readonly meta: ModelMeta
  readonly operation: string
  readonly statements: readonly Statement[]
  readonly transactional: boolean
  readonly where?: unknown
}

/** The write methods a delegate exposes (the runtime side of the typed `Delegate` interface). */
export function createWriteOperations(
  meta: ModelMeta,
  ctx: DelegateContext,
): Record<string, unknown> {
  return {
    create: (args: CreateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "create",
          args,
          (binds) =>
            compileCreate(meta, args, binds, "create", (name) => ctx.index.byName.get(name)),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    createMany: (args: CreateManyRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "createMany",
          args,
          (binds) => compileCreateMany(meta, args, binds, "createMany"),
          (plan, rows) =>
            decodeBatch(plan, rows, meta, {
              skipped:
                args.skipDuplicates === true
                  ? (decoded: number): number => (args.data as readonly unknown[]).length - decoded
                  : undefined,
            }),
        ),
      ),
    delete: (args: DeleteRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "delete",
          args,
          (binds) => compileDelete(meta, args, binds, "delete", { index: ctx.index }),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    deleteMany: (args: DeleteManyRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "deleteMany",
          args,
          (binds) =>
            compileDeleteMany(meta, args, binds, "deleteMany", {
              index: ctx.index,
            }),
          (plan, rows) => decodeBatch(plan, rows, meta, { countOnly: true }),
        ),
      ),
    insert: (args: InsertRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "insert",
          args,
          (binds) => compileInsert(meta, args, binds, "insert"),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    insertMany: (args: InsertRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "insertMany",
          args,
          (binds) => compileInsertMany(meta, args, binds, "insertMany"),
          (plan, rows) =>
            decodeBatch(plan, rows, meta, {
              skipped:
                args.onDuplicate === "ignore"
                  ? (decoded: number): number => (args.data as readonly unknown[]).length - decoded
                  : undefined,
            }),
        ),
      ),
    patch: (args: UpdateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "patch",
          args,
          (binds) => compilePatch(meta, args, binds, "patch", { index: ctx.index }),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    relate: (args: RelateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "relate",
          args,
          (binds) => compileRelate(meta, args, binds, "relate"),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    relateMany: (args: { data?: unknown } = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "relateMany",
          args,
          (binds) => compileRelateMany(meta, args, binds, "relateMany"),
          (plan, rows) => decodeBatch(plan, rows, meta),
        ),
      ),
    unrelate: (args: RelateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "unrelate",
          args,
          (binds) => compileUnrelate(meta, args, binds, "unrelate"),
          (plan, rows) => decodeBatch(plan, rows, meta, { countOnly: true }),
        ),
      ),
    unrelateMany: (args: DeleteManyRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "unrelateMany",
          args,
          (binds) =>
            compileUnrelateMany(meta, args, binds, "unrelateMany", {
              index: ctx.index,
            }),
          (plan, rows) => decodeBatch(plan, rows, meta, { countOnly: true }),
        ),
      ),
    update: (args: UpdateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "update",
          args,
          (binds) => compileUpdate(meta, args, binds, "update", { index: ctx.index }),
          (plan, rows) => decodeResult(plan, rows, meta),
        ),
      ),
    updateEach: (args: UpdateEachRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "updateEach",
          args,
          (binds) => compileUpdateEach(meta, args, binds, "updateEach"),
          (plan, rows) => decodeUpdateEach(args, plan, rows, meta),
        ),
      ),
    updateMany: (args: UpdateManyRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "updateMany",
          args,
          (binds) =>
            compileUpdateMany(meta, args, binds, "updateMany", {
              index: ctx.index,
            }),
          (plan, rows) => decodeBatch(plan, rows, meta),
        ),
      ),
    upsert: (args: UpsertRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "upsert",
          args,
          (binds) => compileUpsert(meta, args, binds, "upsert"),
          (plan, rows) => decodeUpsertResult(plan, rows, meta, args),
        ),
      ),
    upsertDelta: (args: UpsertDeltaRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "upsertDelta",
          args,
          (binds) => compileUpsertDelta(meta, args, binds, "upsertDelta"),
          (plan, rows) => decodeDeltaResult(plan, rows, meta, args),
          args.data === undefined ? args.update : args.data,
        ),
      ),
    upsertMany: (args: UpsertManyRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "upsertMany",
          args,
          (binds) => compileUpsertMany(meta, args, binds, "upsertMany"),
          (plan, rows) => decodeBatch(plan, rows, meta),
        ),
      ),
  }
}

// --- assembly ------------------------------------------------------------------------------------

/** Compile a write into a {@link PreparedWrite} (eager — a bad arg throws at the call site). */
function prepare(
  meta: ModelMeta,
  operation: string,

  args: Record<string, unknown>,
  compile: (binds: Binds) => WritePlan,
  decode: (plan: WritePlan, rows: readonly unknown[]) => unknown,
  /** The hook payload when it isn't `args.data` (upsertDelta's distinct branches). */
  payload?: unknown,
): PreparedWrite {
  const binds = createBinds()
  const plan = compile(binds)
  const where = (args as { where?: unknown }).where
  const data = payload === undefined ? (args as { data?: unknown }).data : payload
  const context = (args as { context?: OperationContext }).context
  const hookMeta = (args as { meta?: Record<string, unknown> }).meta
  return {
    meta,
    operation,
    statements: plan.statements.map((sql) => ({ sql, vars: binds.vars })),
    transactional: plan.transactional,
    ...(where === undefined ? {} : { where }),
    ...(data === undefined ? {} : { data }),
    decode: (rows) => decode(plan, rows),
    delta: plan.result === "delta",
    mayMiss: plan.mayMiss === true,
    ...(context ? { context } : {}),
    ...(hookMeta === undefined ? {} : { hookMeta }),
  }
}

/** Run a prepared write (one round-trip) and decode its result. */
async function runPrepared(ctx: DelegateContext, prepared: PreparedWrite): Promise<unknown> {
  const hooks = ctx.hooks
  const first = prepared.statements[0]
  const meta = hooks ? resolveMeta(ctx, prepared.context, prepared.hookMeta) : undefined
  return runWithHooks(
    hooks,
    {
      operation: prepared.operation as OperationKind,
      surql: first.sql,
      table: prepared.meta.name,
      vars: first.vars ?? {},
      ...(prepared.data === undefined ? {} : { data: prepared.data }),
      ...(prepared.where === undefined ? {} : { where: prepared.where }),
      ...(meta ? { meta } : {}),
    },
    async () => {
      const out = await execute(ctx.conn, {
        debug: ctx.debug,
        inTransaction: ctx.inTransaction === true,
        logger: ctx.logger,
        operation: prepared.operation,
        statements: prepared.statements,
        table: prepared.meta.name,
        transactional: prepared.transactional,
        ...contextOption(ctx, prepared.context),
      })
      return prepared.decode(out.rows)
    },
  )
}

/** Await a prepared write, attaching `.throw()` when the compiled plan says the row may be absent. */
function finish(ctx: DelegateContext, prepared: PreparedWrite): unknown {
  // Compile-delegate (`$sql`): no connection, no hooks, no rows — a true dry run.
  if (ctx.compileOnly) {
    return sqlPreview(prepared.statements, {
      inTransaction: ctx.inTransaction === true,
      operation: prepared.operation,
      table: prepared.meta.name,
      transactional: prepared.transactional,
      ...contextOption(ctx, prepared.context),
    })
  }
  const promise = runPrepared(ctx, prepared)
  // `upsertDelta` handles its own misses (ResultNotFound from the decode, strict or filtered): the
  // strict branch must REJECT rather than expose a `.throw()` the typed surface doesn't carry.
  if (!prepared.mayMiss || prepared.delta) return promise

  return attachThrow<unknown>(promise, (): NotFoundInfo => {
    const statement = prepared.statements.at(-1)
    return {
      operation: prepared.operation,
      surql: statement?.sql,
      table: prepared.meta.name,
      vars: ctx.debug ? statement?.vars : undefined,
      where: prepared.where,
    }
  })
}

// --- decoding — ONE interpretation of the plan ---------------------------------------------------

/** The statement indexes the payload lives in (every statement by default). */
function payloadIndexes(plan: WritePlan, rows: readonly unknown[]): readonly number[] {
  return plan.resultIndexes ?? rows.map((_, i) => i)
}

/** The payload rows, one level flattened (a statement's array, or its single object). */
function payloadRows(plan: WritePlan, rows: readonly unknown[]): unknown[] {
  const out: unknown[] = []

  payloadIndexes(plan, rows).forEach((index) => {
    const raw = rows[index]
    if (raw === undefined || raw === null) return

    if (Array.isArray(raw)) out.push(...(raw as readonly unknown[]))
    else out.push(raw)
  })
  return out
}

/** The flat JSON Patch of every result statement (`[[ops]]` → `ops`, statements combined). */
function payloadDiff(plan: WritePlan, rows: readonly unknown[]): unknown[] {
  const out: unknown[] = []

  payloadIndexes(plan, rows).forEach((index) => {
    const raw = rows[index]
    if (!Array.isArray(raw)) return

    raw.forEach((entry) => {
      if (Array.isArray(entry)) out.push(...(entry as readonly unknown[]))
      else out.push(entry)
    })
  })
  return out
}

/** The generic row/some/none/diff interpretation of a singular plan. */
function decodeResult(plan: WritePlan, rows: readonly unknown[], meta: ModelMeta): unknown {
  if (plan.result === "none") return null

  if (plan.result === "diff") return payloadDiff(plan, rows)

  const data = decodeRows(payloadRows(plan, rows), meta, writeSpec(plan))
  return plan.result === "row" ? (data[0] ?? null) : data
}

/**
 * The `upsert` decode: a plan that marks a miss as an ERROR (`missError` — the strict default, or
 * a create-mode `return: "after"` that produced no row because a permission/plugin scope filtered
 * the target) raises `ResultNotFound` before the generic row/none/diff interpretation. Everything
 * else delegates to {@link decodeResult}.
 */
function decodeUpsertResult(
  plan: WritePlan,
  rows: readonly unknown[],
  meta: ModelMeta,
  args: UpsertRuntimeArgs,
): unknown {
  if (plan.missError === true && payloadRows(plan, rows).length === 0)
    throw upsertMiss(plan, meta, args)

  return decodeResult(plan, rows, meta)
}

/** The `ResultNotFound` for an `upsert` that produced no row. The message classifies the miss by
 *  the COMPILED plan (`strictMiss`), never by `args.onMissing`: a target-less create has no
 *  `onMissing: "throw"` even though its default applies. */
function upsertMiss(plan: WritePlan, meta: ModelMeta, args: UpsertRuntimeArgs): OrmError {
  const statement = plan.statements.at(-1)
  const strict = plan.strictMiss === true
  return new OrmError(
    "ResultNotFound",
    strict
      ? `${meta.name}: no record matched upsert (onMissing: "throw") — it never creates; pass onMissing: "create" to upsert instead.`
      : `${meta.name}: upsert wrote no row — a permission or plugin scope filtered it (the target, or the create); check access, or use $withoutPlugins() for an explicit admin path.`,
    {
      details: args.where,
      operation: "upsert",
      surql: statement,
      table: meta.name,
    },
  )
}

/**
 * `upsertDelta`: the `{ before, after }` envelope → the typed create/update delta result. Both
 * sides decode through the table codecs separately; `before` absent (`undefined` over WS, `null`
 * over HTTP) is the create branch. An absent envelope (strict miss, or a scope-filtered target)
 * is a `ResultNotFound` — `record` is never nullable.
 */
function decodeDeltaResult(
  plan: WritePlan,
  rows: readonly unknown[],
  meta: ModelMeta,
  args: UpsertDeltaRuntimeArgs,
): unknown {
  const envelope = payloadRows(plan, rows)[0]
  if (!isRecord(envelope)) throw deltaMiss(plan, meta, args)

  if (!isRecord(envelope.after)) throw deltaMiss(plan, meta, args)

  const spec = writeSpec(plan)
  const after = decodeRows([envelope.after], meta, spec)[0] as Record<string, unknown>
  const rawBefore = envelope.before
  if (rawBefore === undefined || rawBefore === null) {
    return {
      before: null,
      changed: [],
      created: true,
      delta: null,
      record: after,
    }
  }
  const before = decodeRows([rawBefore], meta, spec)[0] as Record<string, unknown>
  const { changed, delta } = computeFieldDelta(before, after)
  return { before, changed, created: false, delta, record: after }
}

/** The `ResultNotFound` for an `upsertDelta` that produced no envelope. Like `upsertMiss`, the
 *  message classifies the miss by the COMPILED plan (`strictMiss`): a target-less create filtered
 *  by a permission is not a strict miss. */
function deltaMiss(plan: WritePlan, meta: ModelMeta, args: UpsertDeltaRuntimeArgs): OrmError {
  const statement = plan.statements.at(-1)
  const strict = plan.strictMiss === true
  return new OrmError(
    "ResultNotFound",
    strict
      ? `${meta.name}: no record matched upsertDelta (onMissing: "throw") — it never creates; use onMissing: "create" to upsert instead.`
      : `${meta.name}: upsertDelta wrote no row — a permission or plugin scope can filter the write out (tenantRls, a table permission); check access, or use $withoutPlugins() for an explicit admin path.`,
    {
      details: args.where,
      operation: "upsertDelta",
      surql: statement,
      table: meta.name,
    },
  )
}

/** A batch plan: `data` rows, the affected `count`, and how some items skipp them. */
function decodeBatch(
  plan: WritePlan,
  rows: readonly unknown[],
  meta: ModelMeta,
  extras: {
    /** Return the affected count (`deleteMany`/`unrelate` handle rows, not data). */
    readonly countOnly?: boolean
    /** Items intentionally skipped (duplicates / ignored / no-match), from the decoded count. */
    readonly skipped?: (decoded: number) => number | undefined
  } = {},
): unknown {
  if (plan.result === "diff") return payloadDiff(plan, rows)

  if (plan.result === "none") return batch(plan, undefined)

  const data = decodeRows(payloadRows(plan, rows), meta, writeSpec(plan))
  if (extras.countOnly === true) return batch(plan, undefined, undefined, data.length)

  return batch(plan, data, extras.skipped?.(data.length))
}

/** The batch envelope: `count` when rows return them, `skipped` when known. */
function batch(
  plan: WritePlan,
  data: undefined | unknown[],
  skipped?: number,
  count?: number,
): BatchResult {
  const affected = count ?? data?.length
  return {
    ...(affected === undefined ? {} : { count: affected }),
    ...(data === undefined ? {} : { data }),
    ...(skipped === undefined ? {} : { skipped }),
    statements: plan.statements.length,
  }
}

/** `updateEach`: per-item results, `skipped`, `onEmpty: 'throw'`, and the eager `select` spec. */
function decodeUpdateEach(
  args: UpdateEachRuntimeArgs,
  plan: WritePlan,
  rows: readonly unknown[],
  meta: ModelMeta,
): unknown {
  if (plan.result === "none") return batch(plan, undefined)

  const spec = writeSpec(plan)
  const items = payloadIndexes(plan, rows).map((index) => {
    const raw = rows[index]
    return Array.isArray(raw) ? decodeRows(raw, meta, spec) : []
  })
  const empty = items.filter((entry) => entry.length === 0).length
  if (args.onEmpty === "throw" && empty > 0) {
    throw new OrmError(
      "ResultNotFound",
      `updateEach: ${empty} item(s) matched no record (onEmpty: "throw") — fix the "by" values or use onEmpty: "return" to collect them in "skipped".`,
      { details: { empty }, operation: "updateEach", table: meta.name },
    )
  }
  return batch(plan, items.flat(), empty)
}
