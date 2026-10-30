/**
 * `better-schemic/otel` — OpenTelemetry tracing for every ORM round-trip.
 *
 * ```ts
 * import { createOtelLogger } from "better-schemic/otel";
 * const client = betterSchemic(db, { schema, logger: createOtelLogger() });
 * ```
 *
 * `@opentelemetry/api` is an optional peer dependency: install it only when you use this subpath.
 */
export { createOtelLogger, type OtelLoggerConfig } from "./logger";
