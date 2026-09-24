/**
 * `@better-schemic/surrealdb/logger` subpath entry — a beautiful, zero-dependency query logger for
 * the ORM. Enable it with the `logger` option (`betterSchemic(conn, { schema, logger: true })`) or
 * construct one here and pass it as `logger`.
 *
 * Presets: `"pretty"` (framed terminal box), `"compact"` (one line), `"json"` (log shippers),
 * `"silent"`. Options cover colors, icons, timestamps, the slow-query threshold, bound-value
 * truncation and auto-`EXPLAIN` (`explain: "slow" | "all" | "analyze"`).
 */
export { createQueryLogger, resolveLogger } from "./orm/logger";
export type {
  ExplainPolicy,
  LogContext,
  LogFormat,
  LoggerLevel,
  LoggerOption,
  LoggerOptions,
  LoggerPreset,
  LogPhase,
  LogStatement,
  LogStatementResult,
  QueryLogEvent,
  QueryLogger,
  ResolvedLoggerOptions,
} from "./orm/types/logger";
