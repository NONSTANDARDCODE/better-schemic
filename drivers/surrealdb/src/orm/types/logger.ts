/**
 * The query-logger contract — the typed surface of `@better-schemic/surrealdb/logger` and the
 * `logger` option on the ORM bootstrap.
 *
 * The logger observes the executor (the ONE place statements touch the connection), so it sees
 * EVERY round-trip: delegate reads/writes, `$raw`/`$query`/`$unsafe`, `fn`, admin, changes, live
 * setup and `.explain()` plans. It is a pure observer — it never changes args, results or control
 * flow. When absent, the runtime keeps its zero-overhead path (no event is ever built).
 */

/** Where an emitted event came from: a real execution, or an `EXPLAIN` plan. */
export type LogPhase = "run" | "explain";

/** One statement in a logged round-trip. */
export interface LogStatement {
  /** The SurrealQL text (control statements excluded). */
  readonly sql: string;
  /** That statement's binds. */
  readonly vars: Record<string, unknown>;
}

/** One statement's outcome in a logged round-trip. */
export interface LogStatementResult {
  readonly status: "OK" | "ERR";
  /** Row count of the statement's result array, when it returned one. */
  readonly rows?: number;
  /** The scalar a `count` statement returned (`[{ count: n }]`), when this was a `count` op. */
  readonly count?: number;
  /** Server-reported execution time (e.g. `"1.2ms"`), when stats are available. */
  readonly time?: string;
  /** The raw failure (present iff `status === "ERR"`). */
  readonly error?: unknown;
}

/** The scope a logged round-trip ran under (`USE NS … DB …`), when a context was in play. */
export interface LogContext {
  readonly namespace: string;
  readonly database: string;
}

/** Everything one logged round-trip carries. */
export interface QueryLogEvent {
  /** `"run"` for a real execution, `"explain"` for the plans of `.explain()`/`explain: true`. */
  readonly phase: LogPhase;
  /** The delegate operation (`findMany`, `create`, `$raw`, `info`, `changes`, …), when known. */
  readonly operation?: string;
  /** The physical table/edge name, when known. */
  readonly table?: string;
  /** The batch was wrapped in `BEGIN/COMMIT TRANSACTION`. */
  readonly transactional: boolean;
  /** The batch rode an open transaction (no implicit wrapper). */
  readonly inTransaction: boolean;
  /** The namespace/database scope, when a context clone/per-call context was used. */
  readonly context?: LogContext;
  /** The user statements of the round-trip, in order. */
  readonly statements: readonly LogStatement[];
  /** One outcome per user statement. */
  readonly results: readonly LogStatementResult[];
  /** Wall-clock duration of the round-trip, in milliseconds. */
  readonly durationMs: number;
  /** The transport/primary failure, when the round-trip failed. */
  readonly error?: unknown;
  /** The `EXPLAIN` plans (one per statement), for `phase: "explain"` or auto-explain. */
  readonly plans?: readonly unknown[];
  /** The first rows of the primary result, when the logger asked for a preview (`verbose`). */
  readonly preview?: readonly unknown[];
  /** Wall-clock epoch milliseconds (the event timestamp). */
  readonly time: number;
}

/** Emit threshold: `debug` logs everything, `info` only slow/errored, `warn` only errors. */
export type LoggerLevel = "debug" | "info" | "warn" | "silent";

/** Output format preset. `pretty` is the human terminal default; `json` is for log shippers. */
export type LogFormat = "pretty" | "json" | "compact" | "silent";

/** The shorthand presets accepted where {@link LoggerOptions} is (also a string `logger` option). */
export type LoggerPreset = LogFormat;

/** Auto-`EXPLAIN` policy. `analyze` re-executes the query server-side (documented cost). */
export type ExplainPolicy = false | "slow" | "all" | "analyze";

/** The resolved logger options (every field defaulted). */
export interface ResolvedLoggerOptions {
  readonly level: LoggerLevel;
  readonly format: LogFormat;
  readonly colors: boolean;
  readonly icons: boolean;
  readonly time: boolean;
  readonly counter: boolean;
  readonly slowMs: number;
  readonly verbose: boolean;
  readonly maxRows: number;
  readonly maxValueLength: number;
  readonly prettySql: boolean;
  readonly explain: ExplainPolicy;
  readonly stack: boolean;
  readonly write: (line: string) => void;
}

/** Options accepted by `createQueryLogger` / the `logger` client option. */
export interface LoggerOptions {
  /** Emit threshold. Default `"debug"` (log every round-trip). */
  readonly level?: LoggerLevel;
  /** Output format. Default `"pretty"`. */
  readonly format?: LogFormat;
  /** ANSI colors: `true`/`false`/`"auto"` (TTY + `NO_COLOR`/`FORCE_COLOR`). Default `"auto"`. */
  readonly colors?: boolean | "auto";
  /** Show the per-verb emoji. Default `true`. */
  readonly icons?: boolean;
  /** Show a per-line timestamp. Default `true`. */
  readonly time?: boolean;
  /** Show the `#n` round-trip counter. Default `true`. */
  readonly counter?: boolean;
  /** A round-trip at or above this many ms is marked slow (and logged at `level: "info"`). Default `100`. */
  readonly slowMs?: number;
  /** Show a value preview of each statement's rows. Default `false` (count only). */
  readonly verbose?: boolean;
  /** How many rows to preview in `verbose`. Default `3`. */
  readonly maxRows?: number;
  /** Truncate bound values/statements beyond this many chars. Default `160`. */
  readonly maxValueLength?: number;
  /** Break long SurrealQL onto clause-aligned lines. Default `true`. */
  readonly prettySql?: boolean;
  /**
   * Auto-`EXPLAIN`: `false` (default) only renders explicit `.explain()` plans; `"slow"` explains
   * reads at/above `slowMs`; `"all"` explains every read; `"analyze"` runs `EXPLAIN ANALYZE`
   * (re-executes the query server-side — dev only).
   */
  readonly explain?: ExplainPolicy;
  /** Include the error stack. Default `false`. */
  readonly stack?: boolean;
  /** Sink for each rendered line. Default `console.log`. */
  readonly write?: (line: string) => void;
}

/** The `logger` option on `betterSchemic`/`createBetterSchemic`: a preset, a config, or a flag. */
export type LoggerOption = boolean | LoggerPreset | LoggerOptions;

/**
 * The runtime logger threaded into the executor. Built by {@link createQueryLogger}; the runtime
 * only calls {@link QueryLogger.emit} (and reads {@link QueryLogger.enabled}/{@link QueryLogger.planStatement}).
 */
export interface QueryLogger {
  /** `false` for the `"silent"` format/level — the executor then skips all event building. */
  readonly enabled: boolean;
  /** The resolved options (defaults applied). */
  readonly options: ResolvedLoggerOptions;
  /** Render + write one event (respecting the level/format). */
  emit(event: QueryLogEvent): void;
  /**
   * The `EXPLAIN …` statement to run for auto-explain, or `undefined` when the policy does not
   * want a plan for this `(sql, durationMs, phase)`. Only a single `SELECT` is ever explained.
   */
  planStatement(
    sql: string,
    durationMs: number,
    phase: LogPhase,
  ): string | undefined;
}
