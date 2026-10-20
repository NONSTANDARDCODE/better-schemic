/**
 * The executor — the ONE place statements touch the connection. It turns a list of statements into a
 * single `conn.query(...)` round-trip, reads per-statement outcomes with `responses()` (which never
 * throws on a failed statement), and attributes the first failure to its statement.
 *
 * Atomicity (`transactional: true`, the default for batches): the statements are wrapped in a SQL
 * transaction (`BEGIN TRANSACTION; … COMMIT TRANSACTION;`). Live-probed on 3.2.0: a failing statement
 * ABORTS the transaction (`COMMIT` then returns "Cannot COMMIT: the transaction was aborted due to a
 * prior error") and nothing from the batch persists — so the wrapper is atomic in one round-trip.
 * Inside `client.transaction` the caller passes `inTransaction: true` and the wrapper is skipped
 * (the surrounding transaction already owns atomicity).
 *
 * Binds are merged across statements and must be UNIQUE: two statements reusing a name for different
 * values is a compiler bug, caught here as a `ParseError` instead of silently binding the wrong data.
 */
import type { QueryResponse, Surreal } from "surrealdb";
import { contextPrefix } from "./context";
import { BetterSchemicError, normalizeError } from "./errors";
import { emitRoundTrip } from "./logger/emit";
import { type StatementResult, statementResult } from "./results";
import type { ResolvedContext } from "./types/context";
import type { LogPhase, QueryLogger } from "./types/logger";

/** Anything the executor can run statements on — the SDK `Surreal` or a `SurrealSession`. */
export type Queryable = Pick<Surreal, "query">;

/** One statement of a batch. `vars` are that statement's binds (names must be unique in the batch). */
export interface Statement {
  /** The SurrealQL text (a trailing `;` is added when missing). */
  readonly sql: string;
  /** Binds used by this statement. */
  readonly vars?: Record<string, unknown>;
}

/** Options for {@link execute}. */
export interface ExecuteOptions {
  /** The statements to run, in order. */
  readonly statements: readonly Statement[];
  /** Wrap in `BEGIN/COMMIT TRANSACTION` unless already inside a transaction. Default `false`. */
  readonly transactional?: boolean;
  /** The caller is inside `client.transaction` — skip the implicit wrapper. */
  readonly inTransaction?: boolean;
  /** Operation name attached to failures, e.g. `"createMany"`. */
  readonly operation?: string;
  /** Table/edge name attached to failures. */
  readonly table?: string;
  /** Throw the first statement failure (default). `false` returns every `StatementResult`. */
  readonly throwOnError?: boolean;
  /** Include the failing statement's `vars` in the error (client `debug: true`). */
  readonly debug?: boolean;
  /**
   * Scope this batch with `USE NS … DB …;` (context clones / per-call `context`). The prefix is a
   * control statement: it runs in the SAME round-trip and is never exposed as a result.
   */
  readonly context?: ResolvedContext;
  /** Query logger sink (absent = zero-overhead). */
  readonly logger?: QueryLogger;
  /** `"explain"` when the statements are `EXPLAIN` probes (log the plans, not a real run). */
  readonly phase?: LogPhase;
}

/** The outcome of one {@link execute} call. */
export interface ExecuteResult<T = unknown> {
  /** One result per USER statement, in order (control statements are not exposed). */
  readonly responses: readonly StatementResult<T>[];
  /** Convenience view: the successful results by statement index (`undefined` where one failed). */
  readonly rows: readonly (T | undefined)[];
  /** True when the executor wrapped the batch in a transaction. */
  readonly transactional: boolean;
}

/** Ensure a statement ends with `;` (SurrealDB requires the separator in a batch). */
export const terminate = (sql: string): string => {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

/** Options for {@link runScript}. */
export interface RunScriptOptions {
  /** Binds for the script. */
  readonly vars?: Record<string, unknown>;
  /** Scope the script with `USE NS … DB …;` (a control statement, never a result). */
  readonly context?: ResolvedContext;
  /** Operation name attached to failures. */
  readonly operation?: string;
  /** Table/edge name attached to failures. */
  readonly table?: string;
  /** Include the script's `vars` in the error (client `debug: true`). */
  readonly debug?: boolean;
  /** Query logger sink (absent = zero-overhead). */
  readonly logger?: QueryLogger;
  /** `"explain"` when the script is an `EXPLAIN` probe (auto-explain skips itself). */
  readonly phase?: LogPhase;
  /** The user statements (in order) an `execute` batch compiled, for accurate logging. */
  readonly statements?: readonly Statement[];
  /** Control responses at the HEAD of `raw` to skip when aligning {@link statements} (e.g. `BEGIN`). */
  readonly offset?: number;
  /** The batch was wrapped in `BEGIN/COMMIT TRANSACTION` (logging only). */
  readonly transactional?: boolean;
  /** The batch rode an open transaction (logging only). */
  readonly inTransaction?: boolean;
}

/**
 * Run ONE script string and return the server's per-statement responses (the `USE` control
 * statement is sliced off). This is the low-level primitive {@link execute} and the raw/admin
 * escape hatches share, so prefixing, transport-error normalization and offset handling live in
 * exactly one place. Unlike {@link execute}, the response count is NOT checked — a script may hold
 * any number of statements.
 */
export async function runScript(
  conn: Queryable,
  script: string,
  options: RunScriptOptions = {},
): Promise<readonly QueryResponse<unknown>[]> {
  const prefix = contextPrefix(options.context);
  const full = prefix ? `${prefix}\n${script}` : script;
  const logger = options.logger?.enabled ? options.logger : undefined;
  const started = logger ? performance.now() : 0;
  let raw: QueryResponse<unknown>[];
  try {
    raw = (await conn
      .query(full, options.vars)
      .responses()) as QueryResponse<unknown>[];
  } catch (e) {
    // A transport/connection rejection (not a per-statement failure) — normalize with context.
    const error = normalizeError(e, {
      operation: options.operation,
      table: options.table,
      surql: full,
      vars: options.debug ? options.vars : undefined,
    });
    if (logger)
      await emitRoundTrip(conn, {
        ...options,
        logger,
        script,
        responses: [],
        durationMs: performance.now() - started,
        error,
      });
    throw error;
  }
  const sliced = prefix ? raw.slice(1) : raw;
  if (logger)
    await emitRoundTrip(conn, {
      ...options,
      logger,
      script,
      responses: sliced,
      durationMs: performance.now() - started,
    });
  return sliced;
}

/** Merge every statement's binds, rejecting a name reused with a DIFFERENT value. */
function mergeVars(statements: readonly Statement[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [i, statement] of statements.entries()) {
    for (const [name, value] of Object.entries(statement.vars ?? {})) {
      if (name in merged && !Object.is(merged[name], value))
        throw new BetterSchemicError(
          "ParseError",
          `duplicate bind "$${name}" used with different values (statement ${i}) — binds must be unique across a batch.`,
          { statementIndex: i, surql: statement.sql },
        );
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * Run statements in one round-trip and map the per-statement outcomes.
 *
 * ```ts
 * const { rows } = await execute(conn, {
 *   statements: [{ sql: "SELECT * FROM user", vars: { p0: true } }],
 *   operation: "findMany",
 * });
 * ```
 */
export async function execute<T = unknown>(
  conn: Queryable,
  options: ExecuteOptions,
): Promise<ExecuteResult<T>> {
  const { statements } = options;
  if (statements.length === 0)
    return { responses: [], rows: [], transactional: false };

  const wrapping =
    options.transactional === true && options.inTransaction !== true;
  // The wrapper flanks the batch, so each user statement sits at `offset + i`.
  const offset = wrapping ? 1 : 0;
  const body = statements.map((statement) => terminate(statement.sql));
  const parts = wrapping
    ? ["BEGIN TRANSACTION;", ...body, "COMMIT TRANSACTION;"]
    : body;

  const vars = mergeVars(statements);
  const script = parts.join("\n");

  const raw = await runScript(conn, script, {
    vars,
    ...(options.context ? { context: options.context } : {}),
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.table ? { table: options.table } : {}),
    debug: options.debug === true,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.phase ? { phase: options.phase } : {}),
    statements,
    offset,
    transactional: wrapping,
    inTransaction: options.inTransaction === true,
  });

  // The server answers every statement (control statements included); a mismatch is a protocol
  // surprise, surfaced with the script rather than silently mis-indexed.
  if (raw.length !== parts.length)
    throw new BetterSchemicError(
      "DatabaseError",
      `expected ${parts.length} statement responses, got ${raw.length}.`,
      { operation: options.operation, table: options.table, surql: script },
    );

  const responses = statements.map((statement, i) =>
    statementResult<T>(raw[offset + i] as QueryResponse<T>, {
      operation: options.operation,
      table: options.table,
      statementIndex: i,
      surql: statement.sql,
      vars: options.debug ? statement.vars : undefined,
    }),
  );

  if (options.throwOnError !== false) {
    // In an aborted transaction the server marks the OTHER statements as "not executed due to a
    // failed transaction" — including ones that ran BEFORE the failure. Those normalize to
    // `TransactionRollback`; the genuine cause (e.g. an AlreadyExists) is the failure to report.
    const failures = responses
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === "ERR");
    const primary =
      failures.find(({ r }) => r.error?.code !== "TransactionRollback") ??
      failures[0];
    if (primary) throw primary.r.error;
  }

  return {
    responses,
    rows: responses.map((r) => (r.status === "OK" ? r.result : undefined)),
    transactional: wrapping,
  };
}
