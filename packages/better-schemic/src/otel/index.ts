/** OTEL instrumentation for better-schemic — plugin-based, zero-overhead when disabled. */
export { defineOtelInstrumentation, type OtelPluginConfig } from "./plugin/define-otel";
export { withOtelTraces, type OtelSpanConfig } from "./instrumentation/tracer";
export { otelConsoleExporter } from "./exporters/console";
export type { OtelOperationSpan } from "./types/index";
