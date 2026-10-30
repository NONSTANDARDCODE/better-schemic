/**
 * OpenTelemetry tracing for the ORM — implemented as a {@link QueryLogger} on the executor seam.
 *
 * The executor (`runScript`) is the ONE place statements touch the connection, so this logger sees
 * every round-trip exactly once: delegate reads/writes, `$raw`/`$query`/`$unsafe`, `fn`, admin,
 * changes, live setup and `.explain()` plans. One `QueryLogEvent` becomes one client span, with the
 * span started at `time - durationMs` so its duration is the real round-trip (including transport),
 * not just the time spent building attributes.
 *
 * ```ts
 * import { createOtelLogger } from "better-schemic/otel";
 * const client = betterSchemic(db, { schema, logger: createOtelLogger() });
 * ```
 *
 * Zero cost when unused: the module only loads through `better-schemic/otel`, and the executor
 * skips event building entirely when no logger is attached. `enabled: false` keeps the option in
 * place (e.g. a feature flag) while the executor's `enabled` check skips every event.
 *
 * `service.name` is a RESOURCE attribute, not a span attribute: register it once in the app's SDK
 * (`resourceFromAttributes({ "service.name": "my-app" })`). This logger never sets it.
 *
 * Telemetry is best-effort: a failure inside span assembly/export is reported through the OTel
 * `diag` logger and never changes the result or the error of the query being observed.
 */
import {
  type Attributes,
  diag,
  type Exception,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { resolveLoggerOptions } from "../surreal/orm/logger/options";
import type { QueryLogEvent, QueryLogger } from "../surreal/orm/types/logger";

export interface OtelLoggerConfig {
  /**
   * Instrumentation-scope name passed to `trace.getTracer` (shows up as
   * `instrumentation_scope.name`). Default `"better-schemic"`.
   */
  readonly tracerName?: string;
  /** `false` keeps the option attached but makes the executor skip every event. Default `true`. */
  readonly enabled?: boolean;
  /**
   * Capture `db.query.text` (the compiled SurrealQL, never the `$bind` values). Default `true`.
   * Turn it off when statements may contain literals with PII — see the README security note.
   */
  readonly captureQueryText?: boolean;
  /** Truncate captured query text to this many characters. Default `1000`. */
  readonly maxQueryTextLength?: number;
  /** Static attributes added to every span. Computed attributes win on a key clash. */
  readonly attributes?: Attributes;
}

/** The DBMS identifier (semconv: lowercase product name, no version). */
const DB_SYSTEM = "surrealdb";

/** The default query-text cap — long enough for real statements, short enough for a span. */
const DEFAULT_MAX_QUERY_TEXT = 1000;

/** Truncate a span-status message (OTel exporters reject unbounded descriptions). */
const MAX_STATUS_MESSAGE = 512;

/** The first SQL verb of a statement (`SELECT`, `INSERT`, …). */
function firstVerb(sql: string | undefined): string | undefined {
  return /^\s*([A-Za-z]+)/.exec(sql ?? "")?.[1]?.toUpperCase();
}

/**
 * The operation name. A one-statement round-trip uses its verb (`SELECT`); a multi-statement batch
 * follows semconv (`BATCH SELECT` when every statement shares a verb, otherwise `BATCH`). An
 * `EXPLAIN` probe is its own operation.
 */
function operationOf(event: QueryLogEvent): string {
  if (event.phase === "explain") return "EXPLAIN";
  const verbs = new Set<string>();
  for (const statement of event.statements) {
    const verb = firstVerb(statement.sql);
    if (verb !== undefined) verbs.add(verb);
  }
  if (event.statements.length > 1) {
    return verbs.size === 1 ? `BATCH ${[...verbs][0]}` : "BATCH";
  }
  return [...verbs][0] ?? event.operation?.toUpperCase() ?? "QUERY";
}

/** The span name: `{operation} {table}` (semconv's `{db.operation.name} {target}`). */
function spanNameOf(event: QueryLogEvent, operation: string): string {
  return event.table ? `${operation} ${event.table}` : operation;
}

/** The query text for the span: every statement, joined; truncated to the configured cap. */
function queryTextOf(event: QueryLogEvent, maxLength: number): string {
  const text = event.statements.map((statement) => statement.sql).join("; ");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** The first failure of a round-trip: a transport error, or the first failed statement. */
function failureOf(event: QueryLogEvent): unknown {
  if (event.error !== undefined) return event.error;
  return event.results.find((result) => result.status === "ERR")?.error;
}

/**
 * The SurrealDB error class (`kind`: `"Thrown"`, `"Validation"`, `"Internal"`, ...), when the SDK
 * error carries one. This is the natural, low-cardinality `error.type`.
 */
function kindOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.length > 0 ? kind : undefined;
}

/** The `cause` an error wraps (a normalized `BetterSchemicError` carries the raw SDK error there). */
function causeOf(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return (error as { cause?: unknown }).cause;
}

/** A non-empty STRING code on one error object (`ERR_LOCKED`, `ParseError`, ...). */
function symbolicCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** A NON-ZERO numeric code on one error object (JSON-RPC codes like `-32000`); `0` means "none". */
function numericCodeOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" && code !== 0 ? code : undefined;
}

/**
 * Semconv `error.type` — the class of error (low cardinality): the SDK `kind`, else a STRING code
 * (the normalized `BetterSchemicError.code`, or a raw server code), else a numeric code, else the
 * class name. A thrown string is a message, not a type — never emit it as `error.type`.
 */
function errorTypeOf(error: unknown): string {
  const kind = kindOf(error);
  if (kind !== undefined) return kind;
  const symbolic = symbolicCodeOf(error);
  if (symbolic !== undefined) return symbolic;
  const numeric = numericCodeOf(error);
  if (numeric !== undefined) return String(numeric);
  if (error instanceof Error) return error.name;
  if (error !== null && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "Error";
}

/**
 * Semconv `db.response.status_code`: the raw server code. The numeric SurrealDB code wins — from
 * the error itself, or from the `cause` of a normalized wrapper; a bare `0` is "no code". A raw
 * string code is used only when nothing was normalized around it.
 */
function statusCodeOf(error: unknown): string | undefined {
  const numeric = numericCodeOf(error) ?? numericCodeOf(causeOf(error));
  if (numeric !== undefined) return String(numeric);
  if (causeOf(error) === undefined) return symbolicCodeOf(error);
  return undefined;
}

/** A readable error message (status description + exception recording). */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Normalize the SDK's error shapes into an OTel `Exception` (string or structured). */
function exceptionOf(error: unknown): Exception {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error;
  if (error !== null && typeof error === "object") {
    const record = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    const code = statusCodeOf(error);
    return {
      message: messageOf(error),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(typeof record.stack === "string" ? { stack: record.stack } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  return String(error);
}

/** Build the span attributes for one event (static config first, computed values win). */
function attributesOf(
  event: QueryLogEvent,
  config: OtelLoggerConfig,
  operation: string,
  maxQueryTextLength: number,
): Attributes {
  const attributes: Attributes = {
    ...config.attributes,
    "db.system.name": DB_SYSTEM,
    "db.operation.name": operation,
  };
  if (event.table !== undefined) attributes["db.collection.name"] = event.table;
  if (event.context !== undefined)
    // SurrealDB nests a database inside a namespace; semconv joins components with `|`.
    attributes["db.namespace"] =
      `${event.context.namespace}|${event.context.database}`;
  if (event.statements.length > 1)
    attributes["db.operation.batch.size"] = event.statements.length;
  if (config.captureQueryText !== false) {
    const text = queryTextOf(event, maxQueryTextLength);
    if (text.length > 0) attributes["db.query.text"] = text;
  }
  if (event.transactional) attributes["surrealdb.transactional"] = true;
  if (event.inTransaction) attributes["surrealdb.in_transaction"] = true;
  return attributes;
}

/** Fail fast on a config that would silently produce useless spans. */
function validatedMaxText(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_QUERY_TEXT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      "createOtelLogger: maxQueryTextLength must be a positive integer",
    );
  }
  return value;
}

/**
 * Build a {@link QueryLogger} that emits one OpenTelemetry client span per executor round-trip.
 *
 * ```ts
 * const client = betterSchemic(db, {
 *   schema,
 *   logger: createOtelLogger({ captureQueryText: true }),
 * });
 * ```
 */
export function createOtelLogger(config: OtelLoggerConfig = {}): QueryLogger {
  const enabled = config.enabled !== false;
  const maxQueryTextLength = validatedMaxText(config.maxQueryTextLength);
  const tracerName = config.tracerName?.trim() || "better-schemic";

  return {
    enabled,
    // Rendering defaults are irrelevant here, but the executor reads `options.verbose` to decide
    // whether to build a result preview — an observer never wants one.
    options: resolveLoggerOptions({ colors: false, verbose: false }),
    emit(event: QueryLogEvent): void {
      if (!enabled) return;
      let span: Span | undefined;
      try {
        const operation = operationOf(event);
        const attributes = attributesOf(
          event,
          config,
          operation,
          maxQueryTextLength,
        );
        span = trace
          .getTracer(tracerName)
          .startSpan(spanNameOf(event, operation), {
            kind: SpanKind.CLIENT,
            attributes,
            startTime: event.time - Math.max(0, event.durationMs),
          });

        const failure = failureOf(event);
        if (failure !== undefined) {
          const message = messageOf(failure).slice(0, MAX_STATUS_MESSAGE);
          const statusCode = statusCodeOf(failure);
          span.setAttribute("error.type", errorTypeOf(failure));
          if (statusCode !== undefined)
            span.setAttribute("db.response.status_code", statusCode);
          span.recordException(exceptionOf(failure), event.time);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        }
      } catch (error) {
        // Telemetry is best-effort: a broken exporter must never fail the query it observed.
        diag.error("better-schemic/otel: failed to assemble a span", error);
      } finally {
        // A span that started must always end, even when one of its attributes blew up.
        if (span !== undefined) {
          try {
            span.end(event.time);
          } catch (error) {
            diag.error("better-schemic/otel: failed to end a span", error);
          }
        }
      }
    },
    // OTEL never auto-explains: an explicit `.explain()` still produces a span (phase "explain").
    planStatement: () => undefined,
  };
}
