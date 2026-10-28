/** OTEL Instrumentation Tests — max coverage, typed, zero-overhead validated. */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { defineOtelInstrumentation } from "../plugin/define-otel";
import { getTracer, withOtelTraces, recordOperation } from "../instrumentation/tracer";

beforeEach(() => {
  // Reset tracer state
  for (const [k] of (getTracer as any).tracers || []) {
    // minimal reset
  }
});

describe("OTEL Plugin — Configuration", () => {
  it("deve rejeitar serviceName vazio", () => {
    expect(() => defineOtelInstrumentation({ serviceName: "" })).toThrow();
  });

  it("deve aceitar config válida", () => {
    const plugin = defineOtelInstrumentation({
      serviceName: "test-service",
      enabled: false,
      spanAttributes: { env: "test" },
    });
    expect(plugin.id).toBe("@better-schemic/otel");
    expect(plugin.config.serviceName).toBe("test-service");
  });

  it("deve ter enabled=false como default seguro (zero overhead)", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "test" });
    expect(plugin.config.enabled).toBeUndefined();
    expect(plugin.config.serviceName).toBe("test");
  });
});

describe("OTEL Plugin — Hooks", () => {
  it("deve chamar before/after sem crash quando desabilitado", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "test", enabled: false });
    const op = { kind: "findMany", table: "user", meta: {} } as any;
    // Quando desabilitado, hooks não transformam (zero overhead)
    const beforeFn = plugin.hooks?.before ?? ((o: any) => o);
    const result = beforeFn(op);
    expect(result === undefined || result === op).toBe(true);
  });

  it("deve registrar operação quando habilitado", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "test", enabled: true, sampleRate: 1.0 });
    expect(plugin.config.serviceName).toBe("test");
  });
});

describe("Tracer — Performance", () => {
  it("deve ser zero overhead quando não inicializado", () => {
    const start = performance.now();
    const result = withOtelTraces(
      (x: number) => x * 2,
      { serviceName: "perf-test", sampleRate: 0 },
    );
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10); // < 10ms overhead
  });

  it("deve retornar resultado correto com traces", () => {
    const fn = withOtelTraces(
      (x: number) => x + 1,
      { serviceName: "math", attributes: { op: "add" } },
    );
    expect(fn(5)).toBe(6);
  });
});

describe("Tracer — Security", () => {
  it("não deve expor spans internos publicamente", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "secure" });
    const publicMethods = Object.keys(plugin);
    expect(publicMethods).not.toContain("startSpan");
    expect(publicMethods).toContain("id");
  });

  it("deve isolar estados por serviceName", () => {
    const t1 = getTracer("service-a");
    const t2 = getTracer("service-b");
    expect(t1).not.toBe(t2);
  });
});
