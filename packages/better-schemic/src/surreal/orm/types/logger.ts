/**
 * The query-logger contract — the typed surface of `better-schemic/logger` and the
 * `logger` option on the ORM bootstrap.
 *
 * The logger observes the executor (the ONE place statements touch the connection), so it sees
 * EVERY round-trip: delegate reads/writes, `$raw`/`$query`/`$unsafe`, `fn`, admin, changes, live
 * setup and `.explain()` plans. it's a pure observer — it never changes args, results or control
 * flow. When absent, the runtime keeps its zero-overhead path (no event is ever built).
 */

/** Where an emitted event came from: a real execution, or an `EXPLAIN` plan. */
export type LogPhase = "explain" | "run"

/** One statement in a logged round-trip. */
export interface LogStatement {
  /** The SurrealQL text (control statements excluded). */
  readonly sql: string
  /** That statement's binds. */
  readonly vars: Record<string, unknown>
}

/** One statement's outcome in a logged round-trip. */
export interface LogStatementResult {
  /** The scalar a `count` statement returned (`[{ count: n }]`), when this was a `count` op. */
  readonly count?: number
  /** The raw failure (present iff `status === "ERR"`). */
  readonly error?: unknown
  /** Row count of the statement's result array, when it returned one. */
  readonly rows?: number
  readonly status: "ERR" | "OK"
  /** Server-reported execution time (e.g. `"1.2ms"`), when stats are available. */
  readonly time?: string
}

/** The scope a logged round-trip ran under (`USE NS … DB …`), when a context was in play. */
export interface LogContext {
  readonly database: string
  readonly namespace: string
}

/** Everything one logged round-trip carries. */
export interface QueryLogEvent {
  /** The namespace/database scope, when a context clone/per-call context uss it. */
  readonly context?: LogContext
  /** Wall-clock duration of the round-trip, in milliseconds. */
  readonly durationMs: number
  /** The transport/primary failure, when the round-trip failed. */
  readonly error?: unknown
  /** The batch rode an open transaction (no implicit wrapper). */
  readonly inTransaction: boolean
  /** The delegate operation (`findMany`, `create`, `$raw`, `info`, `changes`, …), when known. */
  readonly operation?: string
  /** `"run"` for a real execution, `"explain"` for the plans of `.explain()`/`explain: true`. */
  readonly phase: LogPhase
  /** The `EXPLAIN` plans (one per statement), for `phase: "explain"` or auto-explain. */
  readonly plans?: readonly unknown[]
  /** The first rows of the primary result, when the logger asked for a preview (`verbose`). */
  readonly preview?: readonly unknown[]
  /** One outcome per user statement. */
  readonly results: readonly LogStatementResult[]
  /** The user statements of the round-trip, in order. */
  readonly statements: readonly LogStatement[]
  /** The physical table/edge name, when known. */
  readonly table?: string
  /** Wall-clock epoch milliseconds (the event timestamp). */
  readonly time: number
  /** The batch wrapps it in `BEGIN/COMMIT TRANSACTION`. */
  readonly transactional: boolean
}

/** Emit threshold: `debug` logs everything, `info` slow/errored, `warn` errors. */
export type LoggerLevel = "debug" | "info" | "silent" | "warn"

/** Output format preset. `pretty` is the human terminal default; `json` is for log shippers. */
export type LogFormat = "compact" | "json" | "pretty" | "silent"

/** The shorthand presets accepted where {@link LoggerOptions} is (also a string `logger` option). */
export type LoggerPreset = LogFormat

/** Auto-`EXPLAIN` policy. `analyze` re-executes the query server-side (documented cost). */
export type ExplainPolicy = "all" | "analyze" | "slow" | false

/** The resolved logger options (every field defaulted). */
export interface ResolvedLoggerOptions {
  readonly colors: boolean
  readonly counter: boolean
  readonly explain: ExplainPolicy
  readonly format: LogFormat
  readonly icons: boolean
  readonly level: LoggerLevel
  readonly maxRows: number
  readonly maxValueLength: number
  readonly prettySql: boolean
  /** Mask bound values in the output (`$p0 = [redacted]`). */
  readonly redact: boolean
  readonly slowMs: number
  readonly stack: boolean
  readonly time: boolean
  readonly verbose: boolean
  readonly write: (line: string) => void
}

/** Options accepted by `createQueryLogger` / the `logger` client option. */
export interface LoggerOptions {
  /** ANSI colors: `true`/`false`/`"auto"` (TTY + `NO_COLOR`/`FORCE_COLOR`). Default `"auto"`. */
  readonly colors?: "auto" | boolean
  /** Show the `#n` round-trip counter. Default `true`. */
  readonly counter?: boolean
  /**
   * Auto-`EXPLAIN`: `false` (default)  renders explicit `.explain()` plans; `"slow"` explains
   * reads at/above `slowMs`; `"all"` explains every read; `"analyze"` runs `EXPLAIN ANALYZE`
   * (re-executes the query server-side — dev ).
   */
  readonly explain?: ExplainPolicy
  /** Output format. Default `"pretty"`. */
  readonly format?: LogFormat
  /** Show the per-verb emoji. Default `true`. */
  readonly icons?: boolean
  /** Emit threshold. Default `"debug"` (log every round-trip). */
  readonly level?: LoggerLevel
  /** How some rows to preview in `verbose`. Default `3`. */
  readonly maxRows?: number
  /** Truncate bound values/statements beyond this some chars. Default `160`. */
  readonly maxValueLength?: number
  /** Break long SurrealQL onto clause-aligned lines. Default `true`. */
  readonly prettySql?: boolean
  /**
   * Mask every bound VALUE in the emitted log (`$p0 = [redacted]`). Default `false`: the logger
   * prints binds verbatim, which is what makes it useful for debugging — but a password/token
   * written through the ORM would appear in the output, so turn this on for shared/CI logs.
   */
  readonly redact?: boolean
  /** A round-trip at or above this some ms marks it slow (and logged at `level: "info"`). Default `100`. */
  readonly slowMs?: number
  /** Include the error stack. Default `false`. */
  readonly stack?: boolean
  /** Show a per-line timestamp. Default `true`. */
  readonly time?: boolean
  /** Show a value preview of each statement's rows. Default `false` (count ). */
  readonly verbose?: boolean
  /** Sink for each rendered line. Default `console.log`. */
  readonly write?: (line: string) => void
}

/**
 * The `logger` option on `orm`/`createOrm`: a flag, a preset, an options bag,
 * or an already-built {@link QueryLogger} (e.g. `createOtelLogger(...)`), which the client uses
 * as-is.
 */
export type LoggerOption = boolean | LoggerOptions | LoggerPreset | QueryLogger

/**
 * The runtime logger threaded into the executor. Built by `createQueryLogger` (terminal rendering)
 * or `createOtelLogger` (`better-schemic/otel`); the runtime  calls {@link QueryLogger.emit}
 * (and reads {@link QueryLogger.enabled}/{@link QueryLogger.planStatement}).
 */
export interface QueryLogger {
  /** Render + write one event (respecting the level/format). */
  emit(event: QueryLogEvent): void
  /** `false` for the `"silent"` format/level — the executor then skips all event building. */
  readonly enabled: boolean
  /** The resolved options (defaults applied). */
  readonly options: ResolvedLoggerOptions
  /**
   * The `EXPLAIN …` statement to run for auto-explain, or `undefined` when the policy does not
   * want a plan for this `(sql, durationMs, phase)`.  a single `SELECT` is ever explained.
   */
  planStatement(sql: string, durationMs: number, phase: LogPhase): string | undefined
}
