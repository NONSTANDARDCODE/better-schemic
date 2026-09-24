/**
 * `@better-schemic/surrealdb/logger` runtime barrel — the pretty/compact/json query logger.
 *
 * ```ts
 * import { createQueryLogger } from "@better-schemic/surrealdb/logger";
 * import { betterSchemic } from "@better-schemic/surrealdb/orm";
 *
 * const client = betterSchemic(conn, { schema, logger: createQueryLogger({ slowMs: 50 }) });
 * // or the shorthand: betterSchemic(conn, { schema, logger: true }) / "json"
 * ```
 */

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
} from "../types/logger";
export { createQueryLogger, resolveLogger } from "./logger";
