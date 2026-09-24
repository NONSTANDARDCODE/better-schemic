/**
 * Executor → logger bridge. `runScript` (the ONE place statements touch the connection) calls
 * {@link emitRoundTrip} once per round-trip when a logger is enabled; this module owns the event
 * assembly, the per-statement outcome mapping, the driver-control stripping and the opt-in
 * auto-`EXPLAIN`. Keeping it OUT of `execute.ts` keeps the core executor small and its decision
 * budget flat (logging is a separate concern with its own coverage ratchet).
 */
import type { QueryResponse } from "surrealdb";
import type { Statement } from "../execute";
import type { ResolvedContext } from "../types/context";
import type {
  LogPhase,
  LogStatement,
  LogStatementResult,
  QueryLogger,
} from "../types/logger";

/** The minimal connection surface the auto-EXPLAIN probe needs. */
interface Explainable {
  query(
    sql: string,
    vars?: Record<string, unknown>,
  ): { responses(): Promise<QueryResponse<unknown>[]> };
}

/** Everything one logged round-trip needs (a superset of the executor's script options). */
export interface RoundTripLog {
  readonly logger: QueryLogger;
  /** The executed script (control statements may be included for `execute` batches). */
  readonly script: string;
  /** The user statements, when the caller can supply them (accurate display). */
  readonly statements?: readonly Statement[];
  readonly vars?: Record<string, unknown>;
  /** Control responses at the head of `responses` to skip (e.g. the `BEGIN` wrapper). */
  readonly offset?: number;
  readonly phase?: LogPhase;
  readonly operation?: string;
  readonly table?: string;
  readonly transactional?: boolean;
  readonly inTransaction?: boolean;
  readonly context?: ResolvedContext;
  readonly responses: readonly QueryResponse<unknown>[];
  readonly durationMs: number;
  readonly error?: unknown;
}

/** Drop the driver's own control statements (`USE`/`BEGIN`/`COMMIT`) from a logged script. */
const CONTROL_LINE =
  /^\s*(USE\s+NS\s.*;|BEGIN\s+TRANSACTION;|COMMIT\s+TRANSACTION;|CANCEL\s+TRANSACTION;)\s*$/;
function stripControl(script: string): string {
  return script
    .split("\n")
    .filter((line) => !CONTROL_LINE.test(line))
    .join("\n")
    .trim();
}

/** Map one raw SDK response to a logged statement outcome. */
function responseToResult(
  response: QueryResponse<unknown> | undefined,
  operation: string | undefined,
): LogStatementResult {
  if (!response) return { status: "ERR" };
  const time =
    response.stats?.duration !== undefined
      ? { time: String(response.stats.duration) }
      : {};
  if (!response.success)
    return { status: "ERR", error: response.error, ...time };
  const rows = Array.isArray(response.result)
    ? response.result.length
    : undefined;
  // A `count` op returns `[{ count: n }]` — report the scalar, not "1 row".
  if (operation === "count" && rows === 1) {
    const first = (response.result as unknown[])[0] as
      | { count?: unknown }
      | undefined;
    if (typeof first?.count === "number")
      return { status: "OK", rows, count: first.count, ...time };
  }
  // An `exists` probe returns `[id]` (or `[]`) — a row count would be misleading.
  const showRows = operation !== "exists" && rows !== undefined ? { rows } : {};
  return { status: "OK", ...showRows, ...time };
}

/**
 * Assemble and emit one round-trip event. Auto-explain (opt-in) is the only side effect: for a
 * single `SELECT` the logger's policy may ask for an `EXPLAIN …`, which runs here WITHOUT a logger
 * (so it never recurses).
 */
export async function emitRoundTrip(
  conn: Explainable,
  log: RoundTripLog,
): Promise<void> {
  const { logger } = log;
  const statements: LogStatement[] = log.statements
    ? log.statements.map((s) => ({ sql: s.sql, vars: s.vars ?? {} }))
    : [{ sql: stripControl(log.script), vars: log.vars ?? {} }];
  const offset = log.offset ?? 0;
  const userResponses = log.statements
    ? log.statements.map((_, index) => log.responses[offset + index])
    : log.responses;
  const results = userResponses.map((r) => responseToResult(r, log.operation));

  let plans: unknown[] | undefined;
  const single = statements.length === 1 ? statements[0] : undefined;
  if (log.phase === "explain") {
    // An EXPLAIN probe: the responses' results ARE the plans.
    plans = userResponses.map((r) => (r?.success ? r.result : undefined));
  } else if (log.error === undefined && single !== undefined) {
    // Auto-explain (opt-in): the logger decides whether a plan is wanted for this round-trip.
    const planSql = logger.planStatement(single.sql, log.durationMs, "run");
    if (planSql) {
      try {
        const planResponses = await conn
          .query(planSql, single.vars)
          .responses();
        plans = planResponses.map((r) => (r.success ? r.result : undefined));
      } catch {
        // Best-effort: a failed EXPLAIN never fails the operation it observed.
      }
    }
  }

  const statementError =
    log.error ??
    userResponses.find((r) => r !== undefined && !r.success)?.error;

  // `verbose` previews the primary result's first rows (bounded by `maxRows`).
  let preview: unknown[] | undefined;
  if (logger.options.verbose) {
    for (const response of userResponses) {
      if (
        response?.success &&
        Array.isArray(response.result) &&
        response.result.length > 0
      ) {
        preview = (response.result as unknown[]).slice(
          0,
          logger.options.maxRows,
        );
        break;
      }
    }
  }

  logger.emit({
    phase: log.phase ?? "run",
    ...(log.operation !== undefined ? { operation: log.operation } : {}),
    ...(log.table !== undefined ? { table: log.table } : {}),
    transactional: log.transactional === true,
    inTransaction: log.inTransaction === true,
    ...(log.context
      ? {
          context: {
            namespace: log.context.namespace,
            database: log.context.database,
          },
        }
      : {}),
    statements,
    results,
    durationMs: log.durationMs,
    ...(statementError !== undefined ? { error: statementError } : {}),
    ...(plans ? { plans } : {}),
    ...(preview ? { preview } : {}),
    time: Date.now(),
  });
}
