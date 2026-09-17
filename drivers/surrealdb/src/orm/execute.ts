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
import { BetterSchemicError, normalizeError } from "./errors";
import { type StatementResult, statementResult } from "./results";

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
const terminate = (sql: string): string => {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

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

  // Assemble the script, remembering where each USER statement landed.
  const parts: string[] = [];
  if (wrapping) parts.push("BEGIN TRANSACTION;");
  const offsets: number[] = [];
  for (const statement of statements) {
    offsets.push(parts.length);
    parts.push(terminate(statement.sql));
  }
  if (wrapping) parts.push("COMMIT TRANSACTION;");

  const vars = mergeVars(statements);
  const script = parts.join("\n");

  let raw: QueryResponse<unknown>[];
  try {
    raw = (await conn
      .query(script, vars)
      .responses()) as QueryResponse<unknown>[];
  } catch (e) {
    // A transport/connection rejection (not a per-statement failure) — normalize with context.
    throw normalizeError(e, {
      operation: options.operation,
      table: options.table,
      surql: script,
      vars: options.debug ? vars : undefined,
    });
  }

  // The server answers every statement (control statements included); a mismatch is a protocol
  // surprise, surfaced with the script rather than silently mis-indexed.
  if (raw.length !== parts.length)
    throw new BetterSchemicError(
      "DatabaseError",
      `expected ${parts.length} statement responses, got ${raw.length}.`,
      { operation: options.operation, table: options.table, surql: script },
    );

  const responses = statements.map((statement, i) => {
    const response = raw[offsets[i]];
    if (!response)
      throw new BetterSchemicError(
        "DatabaseError",
        `missing response for statement ${i} (${raw.length} responses for ${parts.length} statements).`,
        {
          operation: options.operation,
          table: options.table,
          statementIndex: i,
        },
      );
    return statementResult<T>(response as QueryResponse<T>, {
      operation: options.operation,
      table: options.table,
      statementIndex: i,
      surql: statement.sql,
      vars: options.debug ? statement.vars : undefined,
    });
  });

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
