/**
 * The write operations of a delegate — `create`/`createMany`/`insert`/`insertMany`/`update`/
 * `updateMany`/`patch`/`upsert`/`upsertMany`/`delete`/`deleteMany`/`updateEach` plus the edge
 * operations `relate`/`relateMany`/`unrelate`/`unrelateMany`.
 *
 * Every op compiles EAGERLY (a bad arg throws at the call site) and runs immediately (writes have
 * no `.explain()` — `EXPLAIN` is SELECT-only, `orm-syntax-map.md` §9). `./delegate` owns the public
 * surface; this module owns the runtime, mirroring `./reads`.
 *
 * Decoding is interpreted from the plan ONCE — `none`/`diff`/rows (indexed by the plan) — so every
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
  compileUpsertMany,
} from "./compiler/mutate";
import { fullProjectionSpec, type ProjectionSpec } from "./compiler/projection";
import {
  compileRelate,
  compileRelateMany,
  compileUnrelate,
  compileUnrelateMany,
  type RelateRuntimeArgs,
} from "./compiler/relate";
import { type Binds, createBinds } from "./compiler/shared";
import {
  compileCreate,
  compileCreateMany,
  compileInsert,
  compileInsertMany,
} from "./compiler/write";
import type {
  CreateManyRuntimeArgs,
  CreateRuntimeArgs,
  DeleteManyRuntimeArgs,
  DeleteRuntimeArgs,
  InsertRuntimeArgs,
  UpdateEachRuntimeArgs,
  UpdateManyRuntimeArgs,
  UpdateRuntimeArgs,
  UpsertManyRuntimeArgs,
  UpsertRuntimeArgs,
  WritePlan,
} from "./compiler/write-shared";
import { contextOption, resolveMeta } from "./context";
import { decodeRows } from "./decode";
import type { DelegateContext } from "./delegate";
import { BetterSchemicError } from "./errors";
import { execute, type Statement } from "./execute";
import { runWithHooks } from "./hooks";
import type { ModelMeta } from "./meta";
import {
  attachThrow,
  type BatchResult,
  type NotFoundInfo,
  type ThrowingResult,
} from "./results";
import type { OperationContext } from "./types/context";
import type { OperationKind } from "./types/hooks";

/** The full-row decode every write returns (writes have no projections — except `updateEach.select`). */
const FULL: ProjectionSpec = fullProjectionSpec();

/** One prepared write: statements + how to interpret the executor's rows. */
interface PreparedWrite {
  readonly meta: ModelMeta;
  readonly operation: string;
  readonly statements: readonly Statement[];
  readonly transactional: boolean;
  readonly where?: unknown;
  /** The compiled plan says the singular row may be absent (`.throw()` attaches). */
  readonly mayMiss: boolean;
  readonly decode: (rows: readonly (unknown | undefined)[]) => unknown;
  /** Per-call scope override, resolved against the client's context at run time. */
  readonly context?: OperationContext;
  /** The write payload, for `beforeCreate`/`beforeUpdate` hooks. */
  readonly data?: unknown;
  /** Per-call hook metadata (merged over the scope's at run time). */
  readonly hookMeta?: Record<string, unknown>;
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
            compileCreate(meta, args, binds, "create", (name) =>
              ctx.index.byName.get(name),
            ),
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
                  ? (decoded) =>
                      (args.data as readonly unknown[]).length - decoded
                  : undefined,
            }),
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
                  ? (decoded) =>
                      (args.data as readonly unknown[]).length - decoded
                  : undefined,
            }),
        ),
      ),
    update: (args: UpdateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "update",
          args,
          (binds) =>
            compileUpdate(meta, args, binds, "update", { index: ctx.index }),
          (plan, rows) => decodeResult(plan, rows, meta),
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
    patch: (args: UpdateRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "patch",
          args,
          (binds) =>
            compilePatch(meta, args, binds, "patch", { index: ctx.index }),
          (plan, rows) => decodeResult(plan, rows, meta),
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
          (plan, rows) => decodeResult(plan, rows, meta),
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
    delete: (args: DeleteRuntimeArgs = {}) =>
      finish(
        ctx,
        prepare(
          meta,
          "delete",
          args,
          (binds) =>
            compileDelete(meta, args, binds, "delete", { index: ctx.index }),
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
  };
}

// --- assembly ------------------------------------------------------------------------------------

/** Compile a write into a {@link PreparedWrite} (eager — a bad arg throws at the call site). */
function prepare(
  meta: ModelMeta,
  operation: string,
  args: object,
  compile: (binds: Binds) => WritePlan,
  decode: (plan: WritePlan, rows: readonly (unknown | undefined)[]) => unknown,
): PreparedWrite {
  const binds = createBinds();
  const plan = compile(binds);
  const where = (args as { where?: unknown }).where;
  const data = (args as { data?: unknown }).data;
  const context = (args as { context?: OperationContext }).context;
  const hookMeta = (args as { meta?: Record<string, unknown> }).meta;
  return {
    meta,
    operation,
    statements: plan.statements.map((sql) => ({ sql, vars: binds.vars })),
    transactional: plan.transactional,
    ...(where !== undefined ? { where } : {}),
    ...(data !== undefined ? { data } : {}),
    mayMiss: plan.mayMiss === true,
    decode: (rows) => decode(plan, rows),
    ...(context ? { context } : {}),
    ...(hookMeta !== undefined ? { hookMeta } : {}),
  };
}

/** Run a prepared write (one round-trip) and decode its result. */
async function runPrepared(
  ctx: DelegateContext,
  prepared: PreparedWrite,
): Promise<unknown> {
  const hooks = ctx.hooks;
  const first = prepared.statements[0];
  const meta = hooks
    ? resolveMeta(ctx, prepared.context, prepared.hookMeta)
    : undefined;
  return runWithHooks(
    hooks,
    {
      table: prepared.meta.name,
      operation: prepared.operation as OperationKind,
      ...(first ? { surql: first.sql, vars: first.vars ?? {} } : {}),
      ...(prepared.data !== undefined ? { data: prepared.data } : {}),
      ...(prepared.where !== undefined ? { where: prepared.where } : {}),
      ...(meta ? { meta } : {}),
    },
    async () => {
      const out = await execute(ctx.conn, {
        statements: prepared.statements,
        transactional: prepared.transactional,
        inTransaction: ctx.inTransaction === true,
        operation: prepared.operation,
        table: prepared.meta.name,
        debug: ctx.debug,
        ...contextOption(ctx, prepared.context),
      });
      return prepared.decode(out.rows);
    },
  );
}

/** Await a prepared write, attaching `.throw()` when the compiled plan says the row may be absent. */
function finish(ctx: DelegateContext, prepared: PreparedWrite): unknown {
  const promise = runPrepared(ctx, prepared);
  if (!prepared.mayMiss) return promise;
  return attachThrow(promise as Promise<unknown | null>, (): NotFoundInfo => {
    const statement = prepared.statements[prepared.statements.length - 1];
    return {
      table: prepared.meta.name,
      operation: prepared.operation,
      where: prepared.where,
      surql: statement?.sql,
      vars: ctx.debug ? statement?.vars : undefined,
    };
  }) as ThrowingResult<unknown>;
}

// --- decoding — ONE interpretation of the plan ---------------------------------------------------

/** The statement indexes the payload lives in (every statement by default). */
function payloadIndexes(
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
): readonly number[] {
  return plan.resultIndexes ?? rows.map((_, i) => i);
}

/** The payload rows, one level flattened (a statement's array, or its single object). */
function payloadRows(
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
): unknown[] {
  const out: unknown[] = [];
  for (const index of payloadIndexes(plan, rows)) {
    const raw = rows[index];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) out.push(...raw);
    else out.push(raw);
  }
  return out;
}

/** The flat JSON Patch of every result statement (`[[ops]]` → `ops`, statements combined). */
function payloadDiff(
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
): unknown[] {
  const out: unknown[] = [];
  for (const index of payloadIndexes(plan, rows)) {
    const raw = rows[index];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (Array.isArray(entry)) out.push(...entry);
      else out.push(entry);
    }
  }
  return out;
}

/** The generic row/many/none/diff interpretation of a singular plan. */
function decodeResult(
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
  meta: ModelMeta,
): unknown {
  if (plan.result === "none") return null;
  if (plan.result === "diff") return payloadDiff(plan, rows);
  const data = decodeRows(payloadRows(plan, rows), meta, FULL);
  return plan.result === "row" ? (data[0] ?? null) : data;
}

/** A batch plan: `data` rows, the affected `count`, and how many items were skipped. */
function decodeBatch(
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
  meta: ModelMeta,
  extras: {
    /** Items intentionally skipped (duplicates / ignored / no-match), from the decoded count. */
    readonly skipped?: (decoded: number) => number | undefined;
    /** Return only the affected count (`deleteMany`/`unrelate` handle rows, not data). */
    readonly countOnly?: boolean;
  } = {},
): unknown {
  if (plan.result === "diff") return payloadDiff(plan, rows);
  if (plan.result === "none") return batch(plan, undefined);
  const data = decodeRows(payloadRows(plan, rows), meta, FULL);
  if (extras.countOnly === true)
    return batch(plan, undefined, undefined, data.length);
  return batch(plan, data, extras.skipped?.(data.length));
}

/** The batch envelope: `count` only when rows were returned, `skipped` when known. */
function batch(
  plan: WritePlan,
  data: unknown[] | undefined,
  skipped?: number,
  count?: number,
): BatchResult<unknown> {
  const affected = count ?? data?.length;
  return {
    ...(affected !== undefined ? { count: affected } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(skipped !== undefined ? { skipped } : {}),
    statements: plan.statements.length,
  };
}

/** `updateEach`: per-item results, `skipped`, `onEmpty: 'throw'`, and the eager `select` spec. */
function decodeUpdateEach(
  args: UpdateEachRuntimeArgs,
  plan: WritePlan,
  rows: readonly (unknown | undefined)[],
  meta: ModelMeta,
): unknown {
  if (plan.result === "none") return batch(plan, undefined);
  const spec = plan.select ?? FULL;
  const items = payloadIndexes(plan, rows).map((index) => {
    const raw = rows[index];
    return Array.isArray(raw) ? decodeRows(raw, meta, spec) : [];
  });
  const empty = items.filter((entry) => entry.length === 0).length;
  if (args.onEmpty === "throw" && empty > 0)
    throw new BetterSchemicError(
      "ResultNotFound",
      `updateEach: ${empty} item(s) matched no record (onEmpty: "throw") — fix the "by" values or use onEmpty: "return" to collect them in "skipped".`,
      { table: meta.name, operation: "updateEach", details: { empty } },
    );
  return batch(plan, items.flat(), empty);
}
