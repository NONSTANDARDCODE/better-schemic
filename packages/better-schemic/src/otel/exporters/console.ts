/** OTLP console exporter — dev debugging only, non-fatal. */
import type { TracerSpan } from "../instrumentation/tracer";
import type { OtelOperationSpan } from "../types/index";

export const otelConsoleExporter = (enabled: boolean = false) => {
  if (!enabled) return;
  return (operation: string, span?: TracerSpan | OtelOperationSpan) => {
    console.log(JSON.stringify({
      otel: true,
      spanId: typeof span === "object" ? "binary" : String(span),
      operation,
      timestamp: Date.now(),
    }, null, 2));
  };
};
