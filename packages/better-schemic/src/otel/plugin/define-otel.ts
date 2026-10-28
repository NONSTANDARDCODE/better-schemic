/** OTEL instrumentation plugin — defines the instrumentation pipeline for ORM operations. */
import { definePlugin, type PluginSpec } from "../../surreal/orm/plugins";
import type { SchemaIndex } from "../../surreal/orm/meta";
import type { OperationKind, Hooks } from "../../surreal/orm/types/hooks";
import type { RuntimeOperation } from "../../surreal/orm/plugins";
import { OTEL_BRAND, type OtelPluginConfig } from "../types/index";
import { getTracer, recordOperation } from "../instrumentation/tracer";

export interface OtelInstrumentationSpec extends PluginSpec<OtelPluginConfig> {
  readonly [OTEL_BRAND]: true;
}

export const defineOtelInstrumentation = (
  config: OtelPluginConfig,
): OtelInstrumentationSpec => {
  if (!config.serviceName || typeof config.serviceName !== "string") {
    throw new Error(
      'OTEL instrumentação: "serviceName" é obrigatório (string não-vazio)',
    );
  }
  const enabled = config.enabled !== false; // default true when plugin is present
  const sampleRate = config.sampleRate ?? 1.0;

  return definePlugin({
    id: "@better-schemic/otel",
    config,

    setup({ index }: { index: SchemaIndex }) {
      if (!enabled) return;
      // Initialize tracer with service name — safe, lazy init
      const tracer = getTracer(config.serviceName);
      tracer.setup({ sampleRate, propagation: config.propagation ?? "traceparent" });
    },

    transform(op: RuntimeOperation) {
      if (!enabled) return;
      // Attach telemetry metadata to operation (non-breaking, typed)
      op.meta = { ...op.meta, [OTEL_BRAND]: true, otelConfig: config };
    },

    hooks: {
      before(op: RuntimeOperation, ctx?: unknown) {
        if (!enabled) return;
        const tracer = getTracer(config.serviceName);
        const sql = (op.meta as any)?.sql ?? (op.args?.sql ?? "");
        const spanName = `orm.${op.kind}`;
        const span = tracer.startSpan(spanName, {
          attributes: {
            "db.system": config.dbSystem ?? "surrealdb",
            "db.operation.name": op.kind,
            "db.collection.name": op.table,
            ...(config.dbNamespace ? { "db.namespace": config.dbNamespace } : {}),
            ...(config.dbName ? { "db.name": config.dbName } : {}),
            ...(sql ? { "db.statement": sql.substring(0, config.maxQueryTextLength ?? 1000) } : {}),
            "service.name": config.serviceName,
            ...(config.spanAttributes ?? {}),
          },
          startTime: Date.now(),
        });
        if (config.requestHook) {
          config.requestHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, vars: op.args?.vars });
        }
        const meta = (op.meta ??= {});
        meta[Symbol.for("better-schemic/otel/span")] = span;
        meta[Symbol.for("better-schemic/otel/request-start")] = Date.now();
        return op;
      },

      after(op: RuntimeOperation, result: unknown, ctx?: unknown) {
        if (!enabled) return;
        const meta = op.meta ?? {};
        const span = meta[Symbol.for("better-schemic/otel/span")];
        if (span) {
          const start = meta[Symbol.for("better-schemic/otel/request-start")] ?? Date.now();
          const durationMs = Date.now() - start;
          const sql = (op.meta as any)?.sql ?? "";
          span.setAttributes({ "db.success": true, "db.duration_ms": durationMs });
          if (sql) span.setAttributes({ "db.statement": sql.substring(0, config.maxQueryTextLength ?? 1000) });
          if (config.responseHook) {
            config.responseHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, durationMs, success: true, rows: Array.isArray(result) ? result.length : undefined });
          }
          span.end();
          recordOperation({ operation: op.kind, table: op.table, durationMs, success: true, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined });
        }
        return result;
      },

      error(op: RuntimeOperation, error: Error, ctx?: unknown) {
        if (!enabled) return;
        const meta = op.meta ?? {};
        const span = meta[Symbol.for("better-schemic/otel/span")];
        if (span) {
          const start = meta[Symbol.for("better-schemic/otel/request-start")] ?? Date.now();
          const durationMs = Date.now() - start;
          const sql = (op.meta as any)?.sql ?? "";
          span.setAttributes({ "db.success": false, "db.duration_ms": durationMs, "error.type": error.name });
          if (sql) span.setAttributes({ "db.statement": sql.substring(0, config.maxQueryTextLength ?? 1000) });
          span.recordException(error);
          span.setStatus({ code: 2, message: error.message }); // SpanStatusCode.ERROR
          if (config.responseHook) {
            config.responseHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, durationMs, success: false, error });
          }
          span.end();
          recordOperation({ operation: op.kind, table: op.table, durationMs, success: false, error, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined });
        }
        return error;
      },
    } satisfies Hooks,

    extendClient(ctx: unknown) {
      if (!enabled) return {};
      const tracer = getTracer(config.serviceName);
      return {
        $otelTrace: (opName: string) => tracer.startSpan(`client.${opName}`, { attributes: { "db.system": config.dbSystem ?? "surrealdb" } }),
      };
    },
  }) as OtelInstrumentationSpec;
};
