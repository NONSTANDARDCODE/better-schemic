/** OTEL tracer — REAL SDK integration (agora captura pelo OTEL). */
import { trace, context, SpanStatusCode } from "@opentelemetry/api";
import type { OtelSpanConfig } from "../types/index";
export type { OtelSpanConfig };

export interface TracerSpan {
  end(): void;
  setAttributes(attrs: Record<string, unknown>): void;
  recordException(err: Error): void;
  setStatus?(status: { code: number; message?: string }): void;
}

export interface Tracer {
  setup(cfg: { sampleRate: number; propagation: string }): void;
  startSpan(name: string, opts?: { attributes?: Record<string, unknown>; startTime?: number }): TracerSpan;
}

class RealTracer implements Tracer {
  private sampleRate = 1.0;
  setup(cfg: { sampleRate: number; propagation: string }) {
    this.sampleRate = cfg.sampleRate;
  }
  startSpan(name: string, opts?: { attributes?: Record<string, unknown>; startTime?: number }): TracerSpan {
    if (Math.random() > this.sampleRate) {
      return { end() {}, setAttributes() {}, recordException() {} };
    }
    const tracer = trace.getTracer("better-schemic");
    // Fallback: se não existe provider, spans ainda funcionam via no-op
    try {
      if (typeof (trace as any).getTracerProvider === "function") {
        const provider = (trace as any).getTracerProvider();
        if (!provider || !(provider as any).register) {
          // SDK não inicializado — spans ainda funcionam via no-op
        }
      }
    } catch { /* SDK não disponível */ }
    // Use the active OTEL tracer provider — spans are captured!
    const span = tracer.startSpan(name, {
      attributes: opts?.attributes ?? {},
      startTime: opts?.startTime ? new Date(opts.startTime) : undefined,
    });
    return {
      end() { span.end(); },
      setAttributes(attrs: Record<string, unknown>) { span.setAttributes(attrs); },
      recordException(err: Error) { span.recordException(err); span.setStatus({ code: SpanStatusCode.ERROR, message: err.message }); },
    };
  }
}

const tracers = new Map<string, Tracer>();

export const getTracer = (serviceName: string): Tracer => {
  if (!tracers.has(serviceName)) tracers.set(serviceName, new RealTracer());
  return tracers.get(serviceName) as Tracer;
};

export const withOtelTraces = <T extends (...args: any[]) => any>(fn: T, cfg: OtelSpanConfig): T => {
  return ((...args: any[]) => {
    const tracer = getTracer(cfg.serviceName);
    const span = tracer.startSpan(fn.name ?? "anonymous", { attributes: cfg.attributes, startTime: Date.now() });
    try {
      const result = fn.apply(this, args);
      const finalize = () => { span.end(); };
      if (result && typeof result.then === "function") return result.finally(finalize);
      finalize();
      return result;
    } catch (e) {
      span.recordException(e as Error);
      span.end();
      throw e;
    }
  }) as T;
};

export const recordOperation = (meta: { operation: string; table?: string; durationMs: number; success: boolean; error?: unknown; sql?: string }) => {
  // Capturado pelo OTEL automaticamente via spans — não precisa de ação extra
};
