/**
 * The read operations of a delegate — `findMany`/`findFirst`/`findOne`/`findUnique`/`count`/
 * `exists`/`aggregate`/`paginate`/`cursor`. Every op compiles EAGERLY (a bad arg throws at the call
 * site), runs LAZILY (nothing touches the connection until awaited), and decodes its rows through
 * `./decode`. `./delegate` owns the public surface; this module owns the runtime.
 */
import { escapeIdent } from "surrealdb";
import type {
  AggregateArgs as AggregateRuntimeArgs,
  CountArgs as CountRuntimeArgs,
} from "./compiler/aggregate";
import {
  compileAggregate,
  compileCount,
  compileExists,
} from "./compiler/aggregate";
import type {
  CursorArgs as CursorRuntimeArgs,
  PaginateArgs as PaginateRuntimeArgs,
} from "./compiler/pagination";
import { compileCursor, compilePaginate } from "./compiler/pagination";
import type { CompileReadOptions, ReadArgs } from "./compiler/select";
import { compileRead } from "./compiler/select";
import { type Binds, compileError, createBinds } from "./compiler/shared";
import { uniqueTarget } from "./compiler/unique";
import { contextOption } from "./context";
import { decodeRow, decodeRows } from "./decode";
import type { DelegateContext } from "./delegate";
import { execute, type Statement } from "./execute";
import type { ModelMeta } from "./meta";
import {
  attachExplain,
  attachThrow,
  type ExplainKey,
  type ExplainResult,
  lazyResult,
  type ThrowingResult,
} from "./results";
import type { OperationContext } from "./types/context";

/** The read methods a delegate exposes (the runtime side of the typed `Delegate` interface). */
export function createReadOperations(
  meta: ModelMeta,
  ctx: DelegateContext,
): Record<string, unknown> {
  return {
    findMany: (args: ReadArgs = {}) =>
      finishRead(ctx, prepare(meta, ctx, args, "findMany")),
    findFirst: (args: ReadArgs = {}) =>
      finishRead(ctx, prepare(meta, ctx, args, "findFirst", { one: true })),
    findOne: (args: ReadArgs = {}) =>
      finishRead(ctx, prepare(meta, ctx, args, "findOne", { one: true })),
    findUnique: (args: ReadArgs) =>
      finishRead(ctx, prepareUnique(meta, ctx, args)),
    count: (args: CountRuntimeArgs = {}) =>
      finishRead(ctx, countPlan(meta, ctx, args)),
    exists: (args: CountRuntimeArgs = {}) =>
      finishRead(ctx, existsPlan(meta, ctx, args)),
    aggregate: (args: AggregateRuntimeArgs) =>
      finishRead(ctx, aggregatePlan(meta, ctx, args)),
    paginate: (args: PaginateRuntimeArgs) =>
      finishRead(ctx, paginatePlan(meta, ctx, args)),
    cursor: (args: CursorRuntimeArgs) =>
      finishRead(ctx, cursorPlan(meta, ctx, args)),
  };
}

/** The runtime context every prepared read derives from its args. */
interface ReadRuntimeArgs {
  readonly where?: unknown;
  readonly explain?: unknown;
  /** Per-call namespace/database override (`findMany({ context: { database } })`). */
  readonly context?: OperationContext;
}

/** One statement of a prepared read with its `ExplainResult` role. */
interface PreparedStatement {
  readonly statement: Statement;
  readonly key: ExplainKey;
}

/** A compiled read plus everything the executor/`.throw()`/`.explain()` needs. */
interface PreparedRead {
  readonly meta: ModelMeta;
  readonly operation: string;
  readonly statements: readonly PreparedStatement[];
  /** The filter, for `NotFoundInfo` (`.throw()`). */
  readonly where?: unknown;
  /** One row (throwing wrapper) vs many. */
  readonly resultMode: "many" | "one";
  /** `explain: true` — return the plan instead of executing. */
  readonly explain: boolean;
  /** Interpret the raw rows of the prepared statements. */
  readonly decode: (rows: readonly unknown[]) => unknown;
  /** Per-call scope override, resolved against the client's context at run time. */
  readonly context?: OperationContext;
}

/** Wrap compiled SQL + the shared binds into a keyed prepared statement. */
const stmt = (
  sql: string,
  binds: Binds,
  key: ExplainKey,
): PreparedStatement => ({
  statement: { sql, vars: binds.vars },
  key,
});

/** Compile a read into its statement + decode spec (eager — a bad arg throws here). */
function prepare(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: ReadArgs,
  operation: string,
  options: {
    one?: boolean;
    /** Override the result mode (findUnique's id path is "one" without forcing a LIMIT). */
    resultMode?: "many" | "one";
    compile?: CompileReadOptions;
  } = {},
): PreparedRead {
  const binds = createBinds();
  const effective = options.one ? { ...args, limit: args.limit ?? 1 } : args;
  const compiled = compileRead(meta, effective, binds, operation, {
    ...(options.compile ?? {}),
    index: ctx.index,
  });
  const decode = (rows: readonly unknown[]): unknown => {
    const raw = rows[0];
    if (compiled.only)
      return decodeRow(raw, meta, compiled.projection, ctx.index) ?? null;
    const page = Array.isArray(raw) ? raw : [];
    if (options.one === true)
      return page.length === 0
        ? null
        : decodeRow(page[0], meta, compiled.projection, ctx.index);
    return decodeRows(page, meta, compiled.projection, ctx.index);
  };
  return prepared(meta, operation, [stmt(compiled.sql, binds, "data")], args, {
    resultMode: options.resultMode ?? (options.one ? "one" : "many"),
    decode,
  });
}

/** Assemble a prepared read from its statements + decoder. */
function prepared(
  meta: ModelMeta,
  operation: string,
  statements: readonly PreparedStatement[],
  args: ReadRuntimeArgs,
  extras: {
    resultMode: "many" | "one";
    decode: (rows: readonly unknown[]) => unknown;
  },
): PreparedRead {
  return {
    meta,
    operation,
    statements,
    where: args.where,
    resultMode: extras.resultMode,
    explain: args.explain === true,
    decode: extras.decode,
    ...(args.context ? { context: args.context } : {}),
  };
}

/** The rows of a statement index, as an array. */
const rowsAt = (
  rows: readonly unknown[],
  index: number,
): readonly unknown[] => {
  const raw = rows[index];
  return Array.isArray(raw) ? raw : [];
};

/** `count` plan: `[{ count: n }]` -> `n` (0 when the server returns nothing). */
function countPlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: CountRuntimeArgs,
): PreparedRead {
  const binds = createBinds();
  const sql = compileCount(meta, args, binds, "count", { index: ctx.index });
  const decode = (rows: readonly unknown[]): unknown => {
    const first = rowsAt(rows, 0)[0] as { count?: unknown } | undefined;
    return typeof first?.count === "number" ? first.count : 0;
  };
  return prepared(meta, "count", [stmt(sql, binds, "count")], args, {
    resultMode: "many",
    decode,
  });
}

/** `exists` plan: `SELECT VALUE id … LIMIT 1` -> whether any row came back. */
function existsPlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: CountRuntimeArgs,
): PreparedRead {
  const binds = createBinds();
  const sql = compileExists(meta, args, binds, "exists", { index: ctx.index });
  const decode = (rows: readonly unknown[]): unknown =>
    rowsAt(rows, 0).length > 0;
  return prepared(meta, "exists", [stmt(sql, binds, "exists")], args, {
    resultMode: "many",
    decode,
  });
}

/** `aggregate` plan: decode the grouped rows through the per-entry projection. */
function aggregatePlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: AggregateRuntimeArgs,
): PreparedRead {
  const binds = createBinds();
  const compiled = compileAggregate(meta, args, binds, "aggregate", {
    index: ctx.index,
  });
  const decode = (rows: readonly unknown[]): unknown =>
    decodeRows(rowsAt(rows, 0), meta, compiled.projection, ctx.index);
  return prepared(
    meta,
    "aggregate",
    [stmt(compiled.sql, binds, "data")],
    args,
    { resultMode: "many", decode },
  );
}

/** `paginate` plan: data + count in ONE round-trip; `count:false` probes `n+1` for `hasNext`. */
function paginatePlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: PaginateRuntimeArgs,
): PreparedRead {
  const binds = createBinds();
  const plan = compilePaginate(meta, args, binds, "paginate", {
    index: ctx.index,
  });
  const statements: PreparedStatement[] = [
    stmt(plan.dataSql, binds, "data"),
    ...(plan.countSql ? [stmt(plan.countSql, binds, "total")] : []),
  ];
  const decode = (rows: readonly unknown[]): unknown => {
    const pageRows = rowsAt(rows, 0);
    const data = decodeRows(
      plan.probe ? pageRows.slice(0, plan.limit) : pageRows,
      meta,
      plan.projection,
      ctx.index,
    );
    let total: number | undefined;
    if (plan.count) {
      const first = rowsAt(rows, 1)[0] as { count?: unknown } | undefined;
      total = typeof first?.count === "number" ? first.count : 0;
    }
    const hasNext = plan.count
      ? (total as number) > plan.start + data.length
      : pageRows.length > plan.limit;
    return {
      data,
      pagination: {
        type: "offset",
        page: Math.floor(plan.start / plan.limit) + 1,
        perPage: plan.limit,
        ...(plan.count
          ? { total, pageCount: Math.ceil((total as number) / plan.limit) }
          : {}),
        hasNext,
        hasPrevious: plan.start > 0,
      },
    };
  };
  return prepared(meta, "paginate", statements, args, {
    resultMode: "many",
    decode,
  });
}

/** `cursor` plan: one probe statement; `before` flips the order and the rows back. */
function cursorPlan(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: CursorRuntimeArgs,
): PreparedRead {
  const binds = createBinds();
  const plan = compileCursor(meta, args, binds, "cursor", { index: ctx.index });
  const decode = (rows: readonly unknown[]): unknown => {
    const pageRows = rowsAt(rows, 0);
    const hasMore = pageRows.length > plan.limit;
    const decoded = decodeRows(
      pageRows.slice(0, plan.limit),
      meta,
      plan.projection,
      ctx.index,
    );
    const data = plan.backward ? [...decoded].reverse() : decoded;
    const hasPrevious = plan.backward
      ? hasMore
      : args.after !== undefined || args.before !== undefined;
    const hasNext = plan.backward ? true : hasMore;
    return {
      data,
      pagination: {
        type: "cursor",
        hasNext,
        hasPrevious,
        nextCursor: hasNext
          ? cursorOf(data[data.length - 1], plan.order)
          : null,
        previousCursor: hasPrevious ? cursorOf(data[0], plan.order) : null,
      },
    };
  };
  return prepared(
    meta,
    "cursor",
    [
      stmt(
        plan.sql,
        binds,
        plan.backward ? "probe:hasPrevious" : "probe:hasNext",
      ),
    ],
    args,
    { resultMode: "many", decode },
  );
}

/** Extract a row's cursor value (the id for a single-id order, a tuple otherwise). */
function cursorOf(
  row: unknown,
  order: readonly { readonly field: string }[],
): unknown {
  if (row === undefined || row === null) return null;
  const record = row as Record<string, unknown>;
  if (order.length === 1 && order[0]?.field === "id") return record.id;
  const tuple: Record<string, unknown> = {};
  for (const entry of order) {
    if (!(entry.field in record))
      throw compileError(
        "ValidationError",
        `cursor: the decoded row is missing "${entry.field}" — include every orderBy field in "select" so the next cursor can be built.`,
        { operation: "cursor", field: entry.field },
      );
    tuple[entry.field] = record[entry.field];
  }
  return tuple;
}

/** `findUnique`: target the record (id) or filter by the unique field, then take the one row. */
function prepareUnique(
  meta: ModelMeta,
  ctx: DelegateContext,
  args: ReadArgs,
): PreparedRead {
  const target = uniqueTarget(meta, args.where);
  if (target.kind === "id")
    return prepare(
      meta,
      ctx,
      { ...args, where: undefined, only: true },
      "findUnique",
      {
        resultMode: "one",
        compile: { target: `ONLY ${escapeIdent(meta.name)}:${target.id}` },
      },
    );
  return prepare(
    meta,
    ctx,
    { ...args, where: { [target.field]: target.value } },
    "findUnique",
    { one: true },
  );
}

/** Run a prepared read (one round-trip) and decode its result. */
async function runPrepared(
  ctx: DelegateContext,
  prepared: PreparedRead,
): Promise<unknown> {
  const out = await execute(ctx.conn, {
    statements: prepared.statements.map((entry) => entry.statement),
    operation: prepared.operation,
    table: prepared.meta.name,
    debug: ctx.debug,
    ...contextOption(ctx, prepared.context),
  });
  return prepared.decode(out.rows);
}

/** Run `EXPLAIN` for every prepared statement (ONE round-trip) — never the real query. */
async function explainPrepared(
  ctx: DelegateContext,
  prepared: PreparedRead,
): Promise<ExplainResult> {
  const out = await execute(ctx.conn, {
    statements: prepared.statements.map(({ statement }) => ({
      sql: `EXPLAIN ${statement.sql}`,
      vars: statement.vars,
    })),
    operation: prepared.operation,
    table: prepared.meta.name,
    debug: ctx.debug,
    ...contextOption(ctx, prepared.context),
  });
  return {
    driver: "surrealdb",
    operation: prepared.operation,
    statements: prepared.statements.map(({ statement, key }, index) => ({
      key,
      surql: statement.sql,
      vars: statement.vars ?? {},
      plan: out.rows[index],
    })),
    ignoredOptions: [],
  };
}

/**
 * Finish a read: `explain: true` returns the plan instead of executing; otherwise the lazy result
 * gets `.explain()` attached (which runs EXPLAIN without starting the real statement).
 */
function finishRead(ctx: DelegateContext, prepared: PreparedRead): unknown {
  if (prepared.explain) return explainPrepared(ctx, prepared);
  const result =
    prepared.resultMode === "one"
      ? throwingPrepared(ctx, prepared)
      : lazyPrepared(ctx, prepared);
  return attachExplain(result, () => explainPrepared(ctx, prepared));
}

/** A lazy read (runs on await). */
function lazyPrepared(
  ctx: DelegateContext,
  prepared: PreparedRead,
): Promise<unknown> {
  return lazyResult(() => runPrepared(ctx, prepared));
}

/** A lazy read with `.throw()` attached (the miss carries `NotFoundInfo`). */
function throwingPrepared(
  ctx: DelegateContext,
  prepared: PreparedRead,
): ThrowingResult<unknown> {
  return attachThrow(lazyPrepared(ctx, prepared), () => ({
    table: prepared.meta.name,
    operation: prepared.operation,
    where: prepared.where,
    surql: prepared.statements[0]?.statement.sql,
    vars: ctx.debug ? prepared.statements[0]?.statement.vars : undefined,
  }));
}
