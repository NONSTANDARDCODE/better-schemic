/**
 * `better-schemic/logger` runtime barrel — the pretty/compact/json query logger.
 *
 * ```ts
 * import { createQueryLogger } from "better-schemic/logger";
 * import { orm } from "better-schemic/orm";
 *
 * const client = orm(conn, { schema, logger: createQueryLogger({ slowMs: 50 }) });
 * // or the shorthand: orm(conn, { schema, logger: true }) / "json"
 * ```
 */

export { createQueryLogger, resolveLogger } from "./logger"
