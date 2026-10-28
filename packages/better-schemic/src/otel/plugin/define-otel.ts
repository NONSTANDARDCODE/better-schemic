/** OTEL instrumentation plugin — defines the instrumentation pipeline for ORM operations. */
import { definePlugin } from "../../surreal/orm/plugins";
import type { PluginSpec } from "../../surreal/orm/types/plugins";
import type { SchemaIndex } from "../../surreal/orm/meta";
import type { OperationKind, Hooks } from "../../surreal/orm/types/hooks";
import type { RuntimeOperation } from "../../surreal/orm/plugins";
import { OTEL_BRAND, type OtelPluginConfig } from "../types/index";
import { getTracer, recordOperation } from "../instrumentation/tracer";
import type { TracerSpan } from "../instrumentation/tracer";

export type { OtelPluginConfig } from "../types/index";
export interface OtelInstrumentationSpec extends PluginSpec<OtelPluginConfig> {
  readonly [OTEL_BRAND]: true;
}

const SQL_MAP: Record<string, string> = {
  findMany: "SELECT", findFirst: "SELECT", findOne: "SELECT", findUnique: "SELECT",
  count: "SELECT", exists: "SELECT", aggregate: "SELECT", paginate: "SELECT", cursor: "SELECT",
  create: "INSERT", insert: "INSERT", insertMany: "INSERT",
  update: "UPDATE", updateMany: "UPDATE", updateEach: "UPDATE", patch: "UPDATE",
  delete: "DELETE", deleteMany: "DELETE",
  upsert: "UPSERT",
  relate: "RELATE", unrelate: "UNRELATE",
  createRelate: "CREATE RELATE",
};

function sqlOp(kind: string) { return SQL_MAP[kind] ?? kind; }

function extractSql(op: RuntimeOperation): string {
  const metaSql = (op.meta as Record<string, unknown> | undefined)?.sql;
  return typeof metaSql === "string" ? metaSql : (op.args?.sql ?? "") as string;
}

function buildSpanAttrs(config: OtelPluginConfig, op: RuntimeOperation, sql?: string) {
  const maxLen = config.maxQueryTextLength ?? 1000;
  return {
    "db.system": config.dbSystem ?? "surrealdb",
    "db.operation.name": sqlOp(op.kind),
    "db.collection.name": op.table,
    ...(config.dbNamespace ? { "db.namespace": config.dbNamespace } : {}),
    ...(config.dbName ? { "db.name": config.dbName } : {}),
    ...(sql ? { "db.statement": sql.substring(0, maxLen) } : {}),
    "service.name": config.serviceName,
    ...(config.spanAttributes ?? {}),
  };
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
        const sql = extractSql(op);
        const spanName = `db.${sqlOp(op.kind)}`.toLowerCase();
        const span: TracerSpan = tracer.startSpan(spanName, {
          attributes: buildSpanAttrs(config, op, sql),
          startTime: Date.now(),
        });
        if (config.requestHook) {
          config.requestHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, vars: (op.args?.vars as any) });
        }
        const meta = (op.meta ??= {}) as any;
        meta[Symbol.for("better-schemic/otel/span")] = span;
        meta[Symbol.for("better-schemic/otel/request-start")] = Date.now();
        return op;
      },

      after(op: RuntimeOperation, result: unknown, ctx?: unknown) {
        if (!enabled) return;
        const meta = (op.meta ?? {}) as any;
        const span = meta[Symbol.for("better-schemic/otel/span")] as TracerSpan | undefined;
        if (span) {
          const start = meta[Symbol.for("better-schemic/otel/request-start")] ?? Date.now();
          const durationMs = Date.now() - start;
          const sql = extractSql(op);
          span.setAttributes({ "db.success": true, "db.duration_ms": durationMs });
          if (sql) span.setAttributes({ "db.statement": sql.substring(0, config.maxQueryTextLength ?? 1000) });
          if (config.responseHook) {
            config.responseHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, durationMs, success: true, rows: Array.isArray(result) ? result.length : undefined });
          }
          if (span) span.end();
          recordOperation({ operation: op.kind, table: op.table, durationMs, success: true, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined });
        }
        return result;
      },

      error(op: RuntimeOperation, error: Error, ctx?: unknown) {
        if (!enabled) return;
        const meta = (op.meta ?? {}) as any;
        const span = meta[Symbol.for("better-schemic/otel/span")] as TracerSpan | undefined;
        if (span) {
          const start = meta[Symbol.for("better-schemic/otel/request-start")] ?? Date.now();
          const durationMs = Date.now() - start;
          const sql = extractSql(op);
          span.setAttributes({ "db.success": false, "db.duration_ms": durationMs, "error.type": error.name });
          if (sql) span.setAttributes({ "db.statement": sql.substring(0, config.maxQueryTextLength ?? 1000) });
          span.recordException(error);
          (span as any).setStatus({ code: 2, message: error.message }); // SpanStatusCode.ERROR
          if (config.responseHook) {
            config.responseHook({ operation: op.kind, table: op.table, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined, durationMs, success: false, error });
          }
          if (span) span.end();
          recordOperation({ operation: op.kind, table: op.table, durationMs, success: false, error, sql: sql ? sql.substring(0, config.maxQueryTextLength ?? 1000) : undefined });
        }
        return error;
      },
    } as any satisfies Hooks,

    extendClient(ctx: unknown) {
      if (!enabled) return {};
      const tracer = getTracer(config.serviceName);
      return {
        $otelTrace: (opName: string) => tracer.startSpan(`client.${opName}`, { attributes: { "db.system": config.dbSystem ?? "surrealdb" } }),
      };
    },
  }) as unknown as OtelInstrumentationSpec;
};
