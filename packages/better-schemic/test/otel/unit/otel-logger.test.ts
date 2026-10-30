// OTEL integration — the logger observes the executor (the ONE round-trip seam), so these tests
// drive the real client and assert on the spans an in-memory SDK exporter receives. No mocks of
// the OTEL API: a regression in the wiring (a logger that never fires) fails here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Attributes,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import type { QueryResponse } from "surrealdb";
import { createOtelLogger } from "../../../src/otel/logger";
import { defineTable, s } from "../../../src/surreal";
import { betterSchemic } from "../../../src/surreal/orm/client";
import { defineSchema } from "../../../src/surreal/orm/schema";
import { caught, fakeConn, lines, ok } from "../../surreal/orm-fixtures";

const User = defineTable("user", { name: s.string(), age: s.int() });
const schema = defineSchema({ users: User });

let exporter: InMemorySpanExporter;
let provider: TracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  trace.disable();
  await provider.shutdown();
});

const failr = (code: string, message: string): QueryResponse<unknown> =>
  ({
    success: false,
    error: { code, message },
  }) as unknown as QueryResponse<unknown>;

/** The only finished span (fails loudly when the wiring emitted none). */
function onlySpan(): ReadableSpan {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
}

/** HrTime → milliseconds (the exporter reports `[seconds, nanoseconds]`). */
const ms = (time: readonly [number, number]): number =>
  time[0] * 1000 + time[1] / 1_000_000;

describe("createOtelLogger — executor wiring", () => {
  test("a findMany emits one CLIENT span with the DB semconv attributes", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    await client.users.findMany({ where: { age: { gte: 18 } } });

    expect(calls).toHaveLength(1);
    const span = onlySpan();
    expect(span.name).toBe("SELECT user");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.instrumentationScope.name).toBe("better-schemic");
    const attrs = span.attributes as Attributes;
    expect(attrs["db.system.name"]).toBe("surrealdb");
    expect(attrs["db.operation.name"]).toBe("SELECT");
    expect(attrs["db.collection.name"]).toBe("user");
    expect(attrs["db.query.text"]).toContain("SELECT * FROM user");
    expect(attrs["db.query.text"]).toContain("$p0");
    // Binds are NEVER captured (they can carry PII).
    expect(JSON.stringify(attrs)).not.toContain("18");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("the span duration is the real round-trip, not the attribute-building time", async () => {
    const conn = {
      query() {
        return {
          responses: async () => {
            await Bun.sleep(5);
            return [ok([])];
          },
        };
      },
      close: () => Promise.resolve(),
    };
    const client = betterSchemic(conn as never, {
      schema,
      logger: createOtelLogger(),
    });

    await client.users.findMany();

    const span = onlySpan();
    expect(ms(span.duration)).toBeGreaterThanOrEqual(4);
    expect(ms(span.startTime)).toBeLessThan(ms(span.endTime));
  });

  test("context namespaces are joined (ns|db) and control statements are excluded from the text", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.users.findMany();

    const attrs = onlySpan().attributes as Attributes;
    expect(attrs["db.namespace"]).toBe("tenant_a|app");
    expect(attrs["db.query.text"]).not.toContain("USE NS");
  });

  test("a multi-statement round-trip is a BATCH span", async () => {
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 3 }]) : ok([]),
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    await client.users.paginate({ limit: 10, start: 0 });

    expect(calls).toHaveLength(1); // one round-trip, two statements
    const span = onlySpan();
    expect(span.name).toBe("BATCH SELECT user");
    const attrs = span.attributes as Attributes;
    expect(attrs["db.operation.name"]).toBe("BATCH SELECT");
    expect(attrs["db.operation.batch.size"]).toBe(2);
    expect(attrs["db.query.text"]).toContain("; ");
  });

  test("an explicit .explain() emits an EXPLAIN span", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ plan: "TableScan" }])),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    await client.users.findMany().explain();

    const span = onlySpan();
    expect(span.name).toBe("EXPLAIN user");
    const attrs = span.attributes as Attributes;
    expect(attrs["db.operation.name"]).toBe("EXPLAIN");
    expect(attrs["db.query.text"]).toContain("EXPLAIN");
  });
});

describe("createOtelLogger — security & config", () => {
  test("captureQueryText: false never sets db.query.text", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger({ captureQueryText: false }),
    });

    await client.users.findMany({ where: { name: "secret@example.com" } });

    const attrs = onlySpan().attributes as Attributes;
    expect(attrs["db.query.text"]).toBeUndefined();
    expect(attrs["db.operation.name"]).toBe("SELECT");
  });

  test("maxQueryTextLength truncates the captured SQL", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger({ maxQueryTextLength: 8 }),
    });

    await client.users.findMany();

    expect((onlySpan().attributes as Attributes)["db.query.text"]).toBe(
      "SELECT *",
    );
  });

  test("an invalid maxQueryTextLength fails fast at construction", () => {
    expect(() => createOtelLogger({ maxQueryTextLength: 0 })).toThrow(
      TypeError,
    );
    expect(() => createOtelLogger({ maxQueryTextLength: 1.5 })).toThrow(
      TypeError,
    );
  });

  test("static attributes are merged; computed attributes win a clash", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger({
        attributes: {
          "deployment.environment.name": "test",
          "db.system.name": "wrong",
        },
      }),
    });

    await client.users.findMany();

    const attrs = onlySpan().attributes as Attributes;
    expect(attrs["deployment.environment.name"]).toBe("test");
    expect(attrs["db.system.name"]).toBe("surrealdb");
  });

  test("tracerName selects the instrumentation scope", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger({ tracerName: "my-app" }),
    });

    await client.users.findMany();

    expect(onlySpan().instrumentationScope.name).toBe("my-app");
  });

  test("a telemetry failure never fails the query it observed", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const logger = createOtelLogger({
      // A throwing getter is the cheapest stand-in for a broken exporter/attribute.
      attributes: {
        get boom(): never {
          throw new Error("telemetry broke");
        },
      } as Attributes,
    });
    const client = betterSchemic(conn, { schema, logger });

    const rows = await client.users.findMany();
    expect(rows).toEqual([]);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("enabled: false keeps the executor on its no-logger fast path", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const logger = createOtelLogger({ enabled: false });
    expect(logger.enabled).toBe(false);
    const client = betterSchemic(conn, { schema, logger });

    await client.users.findMany();

    expect(calls).toHaveLength(1); // the operation still ran
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("createOtelLogger — failures", () => {
  test("a failed statement sets ERROR + error.type + the SurrealDB code", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => failr("ERR_LOCKED", "the table is locked")),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    const error = await caught(() => client.users.findMany());
    expect(error).not.toBeNull();

    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("the table is locked");
    const attrs = span.attributes as Attributes;
    expect(attrs["error.type"]).toBe("ERR_LOCKED");
    expect(attrs["db.response.status_code"]).toBe("ERR_LOCKED");
    const exception = span.events.find((event) => event.name === "exception");
    expect(exception).toBeDefined();
    expect(exception?.attributes?.["exception.message"]).toContain(
      "the table is locked",
    );
  });

  test("a thrown string is a message, not a high-cardinality error.type", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(
        () =>
          ({
            success: false,
            error: "the table is locked",
          }) as unknown as QueryResponse<unknown>,
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: createOtelLogger(),
    });

    await caught(() => client.users.findMany());

    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("the table is locked");
    expect((span.attributes as Attributes)["error.type"]).toBe("Error");
    const exception = span.events.find((event) => event.name === "exception");
    expect(exception?.attributes?.["exception.message"]).toBe(
      "the table is locked",
    );
  });

  test("a transport rejection still ends an ERROR span", async () => {
    const conn = {
      query() {
        throw new Error("socket closed");
      },
      close: () => Promise.resolve(),
    };
    const client = betterSchemic(conn as never, {
      schema,
      logger: createOtelLogger(),
    });

    await caught(() => client.users.findMany());

    const span = onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("socket closed");
    expect((span.attributes as Attributes)["error.type"]).toBeDefined();
  });
});
