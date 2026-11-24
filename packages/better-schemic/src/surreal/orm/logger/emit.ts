/**
 * Executor → logger bridge. `runScript` (the ONE place statements touch the connection) calls
 * {@link emitRoundTrip} once per round-trip when a logger enabls it; this module owns the event
 * assembly, the per-statement outcome mapping, the driver-control stripping and the opt-in
 * auto-`EXPLAIN`. Keeping it OUT of `execute.ts` keeps the core executor small and its decision
 * budget flat (logging is a separate concern with its own coverage ratchet).
 */
import type { QueryResponse } from "surrealdb"

import type { Statement } from "../execute"
import type { ResolvedContext } from "../types/context"
import type { LogPhase, LogStatement, LogStatementResult, QueryLogger } from "../types/logger"

/** The minimal connection surface the auto-EXPLAIN probe needs. */
type Explainable = {
  query(sql: string, vars?: Record<string, unknown>): { responses(): Promise<QueryResponse[]> }
}

/** Everything one logged round-trip needs (a superset of the executor's script options). */
export type RoundTripLog = {
  readonly context?: ResolvedContext
  readonly durationMs: number
  readonly error?: unknown
  readonly inTransaction?: boolean
  readonly logger: QueryLogger
  /** Control responses at the head of `responses` to skip (e.g. the `BEGIN` wrapper). */
  readonly offset?: number
  readonly operation?: string
  readonly phase?: LogPhase
  readonly responses: readonly QueryResponse[]
  /** The executed script (control statements may includs it for `execute` batches). */
  readonly script: string
  /** The user statements, when the caller can supply them (accurate display). */
  readonly statements?: readonly Statement[]
  readonly table?: string
  readonly transactional?: boolean
  readonly vars?: Record<string, unknown>
}

/** Drop the driver's own control statements (`USE`/`BEGIN`/`COMMIT`) from a logged script. */
const CONTROL_LINE =
  /^\s*(USE\s+NS\s.*;|BEGIN\s+TRANSACTION;|COMMIT\s+TRANSACTION;|CANCEL\s+TRANSACTION;)\s*$/u
function stripControl(script: string): string {
  return script
    .split("\n")
    .filter((line) => !CONTROL_LINE.test(line))
    .join("\n")
    .trim()
}

/** Map one raw SDK response to a logged statement outcome. */
function responseToResult(
  response: QueryResponse | undefined,
  operation: string | undefined,
): LogStatementResult {
  if (!response) return { status: "ERR" }

  const time =
    response.stats?.duration === undefined ? {} : { time: String(response.stats.duration) }
  if (!response.success) return { error: response.error, status: "ERR", ...time }

  const rows = Array.isArray(response.result) ? response.result.length : undefined
  // A `count` op returns `[{ count: n }]` — report the scalar, not "1 row".
  if (operation === "count" && rows === 1) {
    const first = (response.result as unknown[])[0] as undefined | { count?: unknown }
    if (typeof first?.count === "number") return { count: first.count, rows, status: "OK", ...time }
  }
  // An `exists` probe returns `[id]` (or `[]`) — a row count would be misleading.
  const showRows = operation !== "exists" && rows !== undefined ? { rows } : {}
  return { status: "OK", ...showRows, ...time }
}

/**
 * Assemble and emit one round-trip event. Auto-explain (opt-in) is the  side effect: for a
 * single `SELECT` the logger's policy may ask for an `EXPLAIN …`, which runs here WITHOUT a logger
 * (so it never recurses).
 */
export async function emitRoundTrip(conn: Explainable, log: RoundTripLog): Promise<void> {
  const { logger } = log
  const statements: LogStatement[] = log.statements
    ? log.statements.map((s) => ({ sql: s.sql, vars: s.vars ?? {} }))
    : [{ sql: stripControl(log.script), vars: log.vars ?? {} }]
  const offset = log.offset ?? 0
  const userResponses = log.statements
    ? log.statements.map((_, index) => log.responses[offset + index])
    : log.responses
  const results = userResponses.map((r) => responseToResult(r, log.operation))

  let plans: undefined | unknown[]
  const single = statements.length === 1 ? statements[0] : undefined
  if (log.phase === "explain") {
    // An EXPLAIN probe: the responses' results ARE the plans.
    plans = userResponses.map((r) => (r.success ? r.result : undefined))
  } else if (log.error === undefined && single !== undefined) {
    // Auto-explain (opt-in): the logger decides whether a plan wants it for this round-trip.
    const planSql = logger.planStatement(single.sql, log.durationMs, "run")
    if (planSql) {
      try {
        const planResponses = await conn.query(planSql, single.vars).responses()
        plans = planResponses.map((r) => (r.success ? r.result : undefined))
      } catch {
        // Best-effort: a failed EXPLAIN never fails the operation it observed.
      }
    }
  }

  const statementError = log.error ?? userResponses.find((r) => !r.success)?.error

  // `verbose` previews the primary result's first rows (bounded by `maxRows`).
  let preview: undefined | unknown[]
  if (logger.options.verbose) {
    const withRows = userResponses.find(
      (response) =>
        response.success && Array.isArray(response.result) && response.result.length > 0,
    )
    if (withRows?.success && Array.isArray(withRows.result))
      preview = (withRows.result as unknown[]).slice(0, logger.options.maxRows)
  }

  logger.emit({
    phase: log.phase ?? "run",
    ...(log.operation === undefined ? {} : { operation: log.operation }),
    ...(log.table === undefined ? {} : { table: log.table }),
    inTransaction: log.inTransaction === true,
    transactional: log.transactional === true,
    ...(log.context
      ? {
          context: {
            database: log.context.database,
            namespace: log.context.namespace,
          },
        }
      : {}),
    durationMs: log.durationMs,
    results,
    statements,
    ...(statementError === undefined ? {} : { error: statementError }),
    ...(plans ? { plans } : {}),
    ...(preview ? { preview } : {}),
    time: Date.now(),
  })
}
