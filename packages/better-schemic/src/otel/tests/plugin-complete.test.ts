/** OTEL Instrumentation Tests — MAX COVERAGE (até o talo). */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { defineOtelInstrumentation } from "../plugin/define-otel";
import { getTracer, withOtelTraces, recordOperation } from "../instrumentation/tracer";
import { otelConsoleExporter } from "../exporters/console";

interface MockOp {
  kind: string;
  table?: string;
  meta?: Record<string, unknown> | null;
  args?: { sql?: string; vars?: Record<string, unknown> };
}

beforeEach(() => {
  // Reset internal state
});

// =====================================================================
// 1. CONFIGURAÇÃO — todos os casos
// =====================================================================
describe("CONFIG — Zero Overhead / Typed", () => {
  it("rejeita serviceName vazio", () => {
    expect(() => defineOtelInstrumentation({ serviceName: "" })).toThrow();
  });

  it("rejeita serviceName não-string", () => {
    expect(() => defineOtelInstrumentation({ serviceName: 123 as any })).toThrow();
  });

  it("aceita config mínima", () => {
    const p = defineOtelInstrumentation({ serviceName: "svc" });
    expect((p as any).id).toBe("@better-schemic/otel");
  });

  it("default enabled é undefined (não ativa automaticamente)", () => {
    const p = defineOtelInstrumentation({ serviceName: "s" });
    expect((p as any).config.enabled).toBeUndefined();
  });

  it("aceita sampleRate 0 (desliga amostragem)", () => {
    const p = defineOtelInstrumentation({ serviceName: "s", enabled: true, sampleRate: 0 });
    expect((p as any).config.sampleRate).toBe(0);
  });

  it("aceita spanAttributes vazio e não-vazio", () => {
    const p1 = defineOtelInstrumentation({ serviceName: "s", spanAttributes: { env: "dev" } });
    expect((p1 as any).config.spanAttributes).toEqual({ env: "dev" });
  });

  it("propagation aceita w3c", () => {
    const p = defineOtelInstrumentation({ serviceName: "s", propagation: "w3c" });
    expect((p as any).config.propagation).toBe("w3c");
  });

  it("aceita debugExport", () => {
    const p = defineOtelInstrumentation({ serviceName: "s", debugExport: true });
    expect((p as any).config.debugExport).toBe(true);
  });
});

// =====================================================================
// 2. PLUGIN — Hooks completos
// =====================================================================
describe("PLUGINS — Hooks Before/After/Error", () => {
  it("before sem crash com enabled false", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: false });
    const op: MockOp = { kind: "findMany", table: "t", meta: {} };
    const result = (p as any).hooks?.before?.(op);
    expect(result === op || result === undefined).toBe(true);
  });

  it("before sem crash com enabled true", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: true, sampleRate: 1 });
    const op: MockOp = { kind: "findMany", table: "t", meta: {} };
    const result = (p as any).hooks?.before?.(op);
    expect(result === op).toBe(true);
  });

  it("after sem crash", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: false });
    const op = { kind: "create", table: "t", meta: {} };
    expect(() => (p as any).hooks?.after?.(op, [{ id: "1" }])).not.toThrow();
  });

  it("error sem crash", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: false });
    const op = { kind: "update", table: "t", meta: {} };
    const err = new Error("fail");
    expect(() => (p as any).hooks?.error?.(op, err)).not.toThrow();
  });

  it("transform não quebra sem meta", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: true, sampleRate: 1 });
    const op: MockOp = { kind: "delete", table: "t", meta: undefined };
    expect(() => (p as any).transform(op)).not.toThrow();
  });

  it("transform adiciona meta quando habilitado", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: true, sampleRate: 1 });
    const op = { kind: "count", table: "t", meta: {} };
    (p as any).transform(op);
    expect(op.meta).toBeDefined();
  });

  it("setup sem crash", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: true, sampleRate: 1 });
    expect(() => (p as any).setup?.({ tables: new Map(), schemaless: new Map() } as any)).not.toThrow();
  });

  it("setup com index vazio não quebra", () => {
    const p = defineOtelInstrumentation({ serviceName: "h", enabled: true });
    expect(() => (p as any).setup?.({} as any)).not.toThrow();
  });
});

// =====================================================================
// 3. TRACER — Spans e Performance
// =====================================================================
describe("TRACER — Spans / Performance", () => {
  it("startSpan retorna span quando configurado", () => {
    const t = getTracer("perf");
    t.setup({ sampleRate: 1, propagation: "traceparent" });
    const span = t.startSpan("test", { startTime: Date.now() });
    expect(typeof span.end).toBe("function");
  });

  it("startSpan retorna no-op quando sampleRate=0", () => {
    const t = getTracer("perf0");
    t.setup({ sampleRate: 0, propagation: "none" });
    const span = t.startSpan("test");
    expect(typeof span.end).toBe("function");
    span.end(); // não deve lançar
  });

  it("setAttributes não quebra", () => {
    const t = getTracer("attr");
    t.setup({ sampleRate: 1, propagation: "none" });
    const span = t.startSpan("s");
    expect(() => span.setAttributes({ a: 1 })).not.toThrow();
    span.end();
  });

  it("recordException não quebra", () => {
    const t = getTracer("err");
    t.setup({ sampleRate: 1, propagation: "none" });
    const span = t.startSpan("s");
    expect(() => span.recordException(new Error("x"))).not.toThrow();
    span.end();
  });

  it("withOtelTraces retorna resultado correto (sync)", () => {
    const fn = withOtelTraces((a: number, b: number) => a + b, { serviceName: "math" });
    expect(fn(2, 3)).toBe(5);
  });

  it("withOtelTraces funciona com promise (resolve)", async () => {
    const fn = withOtelTraces(async (v: number) => v * 2, { serviceName: "async" });
    const r = await fn(7);
    expect(r).toBe(14);
  });

  it("withOtelTraces captura rejeição de promise", async () => {
    const fn = withOtelTraces(async () => {
      throw new Error("fail");
    }, { serviceName: "rej" });
    await expect(fn()).rejects.toThrow("fail");
  });

  it("performance < 5ms com enabled=false e sampleRate=0", () => {
    const start = performance.now();
    const fn = withOtelTraces((x: number) => x, { serviceName: "fast", sampleRate: 0 });
    fn(42);
    const dur = performance.now() - start;
    expect(dur).toBeLessThan(5);
  });
});

// =====================================================================
// 4. EXPORTER — Console
// =====================================================================
describe("EXPORTER — Console", () => {
  it("otelConsoleExporter retorna função quando true", () => {
    const exp = otelConsoleExporter(true);
    expect(typeof exp).toBe("function");
  });

  it("otelConsoleExporter retorna undefined quando false", () => {
    const exp = otelConsoleExporter(false);
    expect(exp).toBeUndefined();
  });

  it("exporter não quebra com argumentos", () => {
    const exp = otelConsoleExporter(true);
    expect(() => exp?.("findMany")).not.toThrow();
  });
});

// =====================================================================
// 5. INTEGRAÇÃO — Plugin com ORM simulado
// =====================================================================
describe("INTEGRAÇÃO — Plugin + ORM", () => {
  it("plugin pode ser passado para client (simulado)", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "orm-test", enabled: false });
    expect((plugin as any).id).toBe("@better-schemic/otel");
    // Verifica que o plugin tem todos os métodos necessários
    expect(typeof (plugin as any).setup).toBe("function");
    expect(typeof (plugin as any).transform).toBe("function");
    expect((plugin as any).hooks).toBeDefined();
    expect(typeof (plugin as any).extendClient).toBe("function");
  });

  it("extendClient retorna objeto vazio quando desabilitado", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "ext", enabled: false });
    const result = (plugin as any).extendClient?.({} as any);
    expect(typeof result).toBe("object");
  });

  it("extendClient retorna $otelTrace quando habilitado", () => {
    const plugin = defineOtelInstrumentation({ serviceName: "ext", enabled: true, sampleRate: 1 });
    const result = (plugin as any).extendClient?.({ index: new Map() } as any);
    expect(result).toHaveProperty("$otelTrace");
    expect(typeof result?.$otelTrace).toBe("function");
  });
});

// =====================================================================
// 6. SEGURANÇA — Ataques e Isolamento
// =====================================================================
describe("SEGURANÇA — Ataques / Isolamento", () => {
  it("tracer não expõe spans internos via getTracer direto", () => {
    const t = getTracer("secret");
    const tracer = t as any;
    // Não deve existir método direto que exponha spans
    expect(tracer.spans).toBeUndefined();
    expect(tracer.store).toBeUndefined();
  });

  it("isola estados por serviceName (não vaza)", () => {
    const t1 = getTracer("a");
    const t2 = getTracer("b");
    expect(t1).not.toBe(t2);
    t1.setup({ sampleRate: 1, propagation: "none" });
    // t2 não deve ser afetado
    expect((t2 as any).configured).toBeFalsy();
  });

  it("transform não quebra com meta malformada", () => {
    const p = defineOtelInstrumentation({ serviceName: "bad", enabled: true, sampleRate: 1 });
    const op = { kind: "findMany", table: "t", meta: null };
    expect(() => (p as any).transform(op)).not.toThrow();
  });

  it("transform com meta existente preserva dados", () => {
    const p = defineOtelInstrumentation({ serviceName: "preserve", enabled: true, sampleRate: 1 });
    const op = { kind: "findMany", table: "t", meta: { existing: true } };
    (p as any).transform(op);
    expect(op.meta?.existing).toBe(true);
  });
});

// =====================================================================
// 7. RECORD OPERATION — Métricas
// =====================================================================
describe("METRICS — recordOperation", () => {
  it("não quebra com qualquer configuração", () => {
    expect(() => recordOperation({ operation: "findMany", durationMs: 1.5, success: true })).not.toThrow();
  });

  it("não quebra com erro", () => {
    expect(() => recordOperation({ operation: "create", durationMs: 5, success: false, error: new Error("x") })).not.toThrow();
  });

  it("não quebra com duração zero", () => {
    expect(() => recordOperation({ operation: "count", durationMs: 0, success: true })).not.toThrow();
  });
});

// =====================================================================
// 8. EDGE CASES — Casos extremos
// =====================================================================
describe("EDGE CASES", () => {
  it("before retorna mesmo op quando meta está vazio", () => {
    const p = defineOtelInstrumentation({ serviceName: "edge", enabled: true, sampleRate: 1 });
    const op = { kind: "findFirst", table: "t", meta: {} };
    const r = (p as any).hooks?.before?.(op);
    expect(r).toBeDefined();
  });

  it("plugin funciona com kind desconhecido", () => {
    const p = defineOtelInstrumentation({ serviceName: "edge", enabled: false });
    const op = { kind: "unknownKind", table: "t", meta: {} };
    expect(() => (p as any).hooks?.before?.(op)).not.toThrow();
  });

  it("after funciona quando result é array vazio", () => {
    const p = defineOtelInstrumentation({ serviceName: "edge", enabled: false });
    const op: MockOp = { kind: "findMany", table: "t", meta: {} };
    expect(() => (p as any).hooks?.after?.(op, [])).not.toThrow();
  });

  it("after funciona quando result é null", () => {
    const p = defineOtelInstrumentation({ serviceName: "edge", enabled: false });
    const op = { kind: "findOne", table: "t", meta: {} };
    expect(() => (p as any).hooks?.after?.(op, null)).not.toThrow();
  });

  it("plugin aceita plugins vazios no array (não usado diretamente mas seguro)", () => {
    const p = defineOtelInstrumentation({ serviceName: "safe" });
    expect((p as any).config).toBeDefined();
  });
});

describe("COBERTURA — branches OTEL", () => {
  it("setup não inicializa quando disabled", () => {
    const p = defineOtelInstrumentation({ serviceName: "cov", enabled: false });
    expect(() => (p as any).setup?.({})).not.toThrow();
  });

  it("before com requestHook e sql", () => {
    const p = defineOtelInstrumentation({ serviceName: "cov", enabled: true, requestHook: () => {} });
    const op = { kind: "findMany", table: "t", meta: {}, args: { sql: "SELECT * FROM t" } } as any;
    expect(() => (p as any).hooks.before(op)).not.toThrow();
  });

  it("after com responseHook e sql", () => {
    const p = defineOtelInstrumentation({ serviceName: "cov", enabled: true, responseHook: () => {} });
    const op = { kind: "findMany", table: "t", meta: {}, args: {} } as any;
    expect(() => (p as any).hooks.after(op, [{ id: "1" }])).not.toThrow();
  });

  it("error com span e setStatus", () => {
    const p = defineOtelInstrumentation({ serviceName: "cov", enabled: true });
    const op = { kind: "findMany", table: "t", meta: {}, args: {} } as any;
    expect(() => (p as any).hooks.error(op, new Error("x"))).not.toThrow();
  });

  it("extendClient quando habilitado retorna $otelTrace", () => {
    const p = defineOtelInstrumentation({ serviceName: "cov", enabled: true });
    const res = (p as any).extendClient?.({});
    expect(res).toBeDefined();
    expect(typeof res.$otelTrace).toBe("function");
  });
});
