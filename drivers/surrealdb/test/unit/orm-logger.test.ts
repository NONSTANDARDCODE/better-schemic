// The query logger: option/env resolution, level/format gating, the three renderers, auto-explain
// and the executor wiring (reads, writes, explain, raw, context, transactions, errors). Offline.
import { describe, expect, test } from "bun:test";
import type { QueryResponse } from "surrealdb";
import { RecordId, Uuid } from "surrealdb";
import { createQueryLogger, resolveLogger } from "../../src/logger";
import { betterSchemic, type Client } from "../../src/orm/client";
import { visibleWidth } from "../../src/orm/logger/colors";
import { defineSchema } from "../../src/orm/schema";
import type { QueryLogEvent } from "../../src/orm/types/logger";
import { defineTable, s } from "../../src/pure";

const User = defineTable("user", { name: s.string(), age: s.int() });
const schema = defineSchema({ users: User });
type C = Client<typeof schema>;

// --- fixtures ----------------------------------------------------------------------------------

const stat = (ms = 1) => ({
  duration: `${ms}ms`,
  recordsReceived: 0,
  bytesReceived: 0,
  recordsScanned: 0,
  bytesScanned: 0,
});
const okr = (result: unknown, ms = 1): QueryResponse<unknown> =>
  ({
    success: true,
    result,
    type: "other",
    stats: stat(ms),
  }) as unknown as QueryResponse<unknown>;
const failr = (code: string, message: string): QueryResponse<unknown> =>
  ({
    success: false,
    error: { code, message },
    stats: stat(2),
  }) as unknown as QueryResponse<unknown>;

function capture(options: Parameters<typeof createQueryLogger>[0]) {
  const lines: string[] = [];
  const logger = createQueryLogger({ ...options, write: (l) => lines.push(l) });
  return { logger, lines, out: () => lines.join("\n") };
}

const event = (over: Partial<QueryLogEvent> = {}): QueryLogEvent => ({
  phase: "run",
  operation: "findMany",
  table: "user",
  transactional: false,
  inTransaction: false,
  statements: [
    { sql: "SELECT * FROM user WHERE age >= $p0", vars: { p0: 18 } },
  ],
  results: [{ status: "OK", rows: 1, time: "0.2ms" }],
  durationMs: 12.4,
  time: Date.UTC(2025, 0, 1, 12, 34, 56, 789),
  ...over,
});

function connOf(
  handler: (
    sql: string,
    vars?: Record<string, unknown>,
  ) => QueryResponse<unknown>[],
) {
  const calls: { sql: string; vars?: Record<string, unknown> }[] = [];
  const conn = {
    query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return {
        responses: async (): Promise<QueryResponse<unknown>[]> =>
          handler(sql, vars),
      };
    },
    close() {
      return Promise.resolve();
    },
  } as never;
  return { conn, calls };
}

/** A capturing sink (the logger's `write`) to hand to the client option. */
const sinkOf = (c: ReturnType<typeof capture>): ((line: string) => void) =>
  c.logger.options.write;

// --- resolveLogger -----------------------------------------------------------------------------

describe("resolveLogger — the flag / env", () => {
  test("false disables; undefined without env is off", () => {
    expect(resolveLogger(false, {})).toBeUndefined();
    expect(resolveLogger(undefined, {})).toBeUndefined();
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "0" }),
    ).toBeUndefined();
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "false" }),
    ).toBeUndefined();
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG_LEVEL: "debug" }),
    ).toBeUndefined();
  });

  test("true / a preset / a config enable it", () => {
    expect(resolveLogger(true, {})?.enabled).toBe(true);
    expect(resolveLogger("json", {})?.options.format).toBe("json");
    expect(resolveLogger("compact", {})?.options.format).toBe("compact");
    expect(resolveLogger("silent", {})?.enabled).toBe(false);
    expect(resolveLogger({ slowMs: 5 }, {})?.options.slowMs).toBe(5);
  });

  test("env enables and selects the preset", () => {
    expect(resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "1" })?.enabled).toBe(
      true,
    );
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "yes" })?.enabled,
    ).toBe(true);
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "on" })?.enabled,
    ).toBe(true);
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "true" })?.enabled,
    ).toBe(true);
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "no" }),
    ).toBeUndefined();
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "off" }),
    ).toBeUndefined();
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "banana" })?.enabled,
    ).toBe(true);
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "json" })?.options.format,
    ).toBe("json");
  });

  test("env level/slowMs fill unset fields (input wins)", () => {
    const env = {
      BETTER_SCHEMIC_LOG_LEVEL: "info",
      BETTER_SCHEMIC_LOG_SLOW_MS: "5",
    };
    expect(resolveLogger(true, env)?.options.level).toBe("info");
    expect(resolveLogger(true, env)?.options.slowMs).toBe(5);
    expect(resolveLogger({ level: "warn" }, env)?.options.level).toBe("warn");
    expect(
      resolveLogger(true, { BETTER_SCHEMIC_LOG_LEVEL: "bogus" })?.options.level,
    ).toBe("debug");
    expect(
      resolveLogger(true, { BETTER_SCHEMIC_LOG_SLOW_MS: "-1" })?.options.slowMs,
    ).toBe(100);
    expect(
      resolveLogger(true, { BETTER_SCHEMIC_LOG_SLOW_MS: "nope" })?.options
        .slowMs,
    ).toBe(100);
    expect(resolveLogger("pretty", env)?.options.slowMs).toBe(5);
  });

  test("defaults are sane", () => {
    const o = createQueryLogger().options;
    expect(o.level).toBe("debug");
    expect(o.format).toBe("pretty");
    expect(o.icons).toBe(true);
    expect(o.time).toBe(true);
    expect(o.counter).toBe(true);
    expect(o.slowMs).toBe(100);
    expect(o.verbose).toBe(false);
    expect(o.maxRows).toBe(3);
    expect(o.maxValueLength).toBe(160);
    expect(o.prettySql).toBe(true);
    expect(o.explain).toBe(false);
    expect(o.stack).toBe(false);
    expect(typeof o.write).toBe("function");
  });

  test("the default write goes to console.log", () => {
    const original = console.log;
    const seen: unknown[] = [];
    console.log = ((line: unknown) => seen.push(line)) as typeof console.log;
    try {
      createQueryLogger({ format: "compact" }).emit(event());
    } finally {
      console.log = original;
    }
    expect(seen).toHaveLength(1);
  });
});

// --- gating ------------------------------------------------------------------------------------

describe("level / format gating", () => {
  test("debug logs every run; info only slow/errored; warn only errors; silent nothing", () => {
    const debug = capture({ level: "debug", format: "compact" });
    debug.logger.emit(event({ durationMs: 1 }));
    expect(debug.lines).toHaveLength(1);

    const info = capture({ level: "info", format: "compact", slowMs: 10 });
    info.logger.emit(event({ durationMs: 1 }));
    info.logger.emit(event({ durationMs: 20 }));
    info.logger.emit(event({ durationMs: 1, error: new Error("x") }));
    expect(info.lines).toHaveLength(2);

    const warn = capture({ level: "warn", format: "compact", slowMs: 10 });
    warn.logger.emit(event({ durationMs: 20 }));
    warn.logger.emit(event({ durationMs: 1, error: new Error("x") }));
    expect(warn.lines).toHaveLength(1);

    const silent = capture({ level: "silent" });
    expect(silent.logger.enabled).toBe(false);
    silent.logger.emit(event());
    expect(silent.lines).toHaveLength(0);
  });

  test("explain events always log (even at warn); format silent disables", () => {
    const warn = capture({ level: "warn", format: "compact" });
    warn.logger.emit(event({ phase: "explain", plans: ["plan"] }));
    expect(warn.lines).toHaveLength(1);
    const off = capture({ format: "silent" });
    expect(off.logger.enabled).toBe(false);
    off.logger.emit(event());
    expect(off.lines).toHaveLength(0);
  });

  test("the counter only advances on emitted events", () => {
    const { logger, out } = capture({ level: "info", slowMs: 10 });
    logger.emit(event({ durationMs: 1 })); // filtered
    logger.emit(event({ durationMs: 20 }));
    logger.emit(event({ durationMs: 30 }));
    expect(out()).toContain("#1");
    expect(out()).toContain("#2");
    expect(out()).not.toContain("#3");
  });
});

// --- pretty ------------------------------------------------------------------------------------

/** Assert the box invariants: two borders and a shared visible width. */
function expectBox(lines: string[]): void {
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(lines[0]?.startsWith("╭")).toBe(true);
  expect(lines[lines.length - 1]?.startsWith("╰")).toBe(true);
  const width = visibleWidth(lines[0] as string);
  for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

describe("pretty rendering", () => {
  test("frames the operation, SQL, binds and meta", () => {
    const { logger, lines } = capture({ colors: false });
    logger.emit(event());
    expectBox(lines);
    expect(lines[0]).toContain("🔍 findMany · user");
    expect(lines[1]?.startsWith("│ SELECT * FROM user")).toBe(true);
    expect(lines[1]?.endsWith("│")).toBe(true);
    expect(lines.join("\n")).toContain("WHERE age >= $p0");
    expect(lines.join("\n")).toContain("$p0 = 18");
    expect(lines[lines.length - 1]).toContain(
      "1 row · 12.4ms · #1 · 12:34:56.789",
    );
  });

  test("icons/time/counter can be turned off", () => {
    const { logger, lines } = capture({
      icons: false,
      time: false,
      counter: false,
    });
    logger.emit(event({ durationMs: 1 }));
    expect(lines[0]).not.toContain("🔍");
    expect(lines[0]).toContain("findMany");
    expect(lines[lines.length - 1]).toContain("1.00ms");
    expect(lines[lines.length - 1]).not.toContain("#");
    expect(lines.join("\n")).not.toContain("12:34:56");
  });

  test("slow events get a badge and red duration", () => {
    const slow = capture({ slowMs: 10 });
    slow.logger.emit(event({ durationMs: 44 }));
    expect(slow.out()).toContain("🐌 SLOW");
  });

  test("row labels cover 0/1/N and the count override", () => {
    const zero = capture({});
    zero.logger.emit(event({ results: [{ status: "OK", rows: 0 }] }));
    expect(zero.out()).toContain("0 rows");
    const many = capture({});
    many.logger.emit(
      event({
        results: [
          { status: "OK", rows: 3 },
          { status: "OK", rows: 2 },
        ],
      }),
    );
    expect(many.out()).toContain("5 rows");
    const counted = capture({});
    counted.logger.emit(
      event({
        operation: "count",
        results: [{ status: "OK", rows: 1, count: 42 }],
      }),
    );
    expect(counted.out()).toContain("count 42");
    const noRows = capture({});
    noRows.logger.emit(event({ results: [] }));
    expect(noRows.out()).not.toContain("row");
  });

  test("context, plan, preview, multi-statement and statement separator", () => {
    const { logger, lines } = capture({ prettySql: false });
    logger.emit(
      event({
        context: { namespace: "app", database: "main" },
        statements: [
          { sql: "SELECT * FROM user", vars: {} },
          { sql: "SELECT * FROM user WHERE x = $p0", vars: { p0: 1 } },
        ],
        results: [
          { status: "OK", rows: 1 },
          { status: "OK", rows: 1 },
        ],
        plans: [
          "SelectProject [ctx: Db]\n    TableScan [ctx: Db] [table: user]",
        ],
        preview: [{ id: "user:1", name: "A" }, { id: "user:2" }],
      }),
    );
    const out = lines.join("\n");
    expectBox(lines);
    expect(out).toContain("ns/app · db/main");
    expect(out).toContain("plan");
    expect(out).toContain("TableScan");
    expect(out).toContain("rows");
    expect(out).toContain("user:1");
  });

  test("bound values are typed, truncated and circular-safe", () => {
    const { logger, lines } = capture({ colors: false, maxValueLength: 30 });
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;
    logger.emit(
      event({
        statements: [
          {
            sql: "SELECT * FROM user",
            vars: {
              s: "x".repeat(60),
              n: 42,
              b: true,
              nil: null,
              und: undefined,
              big: 10n,
              date: new Date(Date.UTC(2020, 0, 2)),
              rid: new RecordId("user", "tobie"),
              uuid: Uuid.v4(),
              obj: { nested: 1 },
              arr: [1, 2],
              circ: circular,
            },
          },
        ],
      }),
    );
    const out = lines.join("\n");
    expect(out).toContain("…"); // truncation
    expect(out).toContain("42");
    expect(out).toContain("true");
    expect(out).toContain("null");
    expect(out).toContain("undefined");
    expect(out).toContain("10n");
    expect(out).toContain("2020-01-02");
    expect(out).toContain("user:tobie");
    expect(out).toContain("[circular]");
  });

  test("errors render with code, message and an optional stack", () => {
    const err = Object.assign(new Error("boom"), { code: "ParseError" });
    const bare = capture({ colors: false });
    bare.logger.emit(event({ results: [{ status: "ERR" }], error: err }));
    expect(bare.out()).toContain("⛔ [ParseError] boom");
    const stacked = capture({ stack: true, colors: false });
    stacked.logger.emit(event({ error: err }));
    expect(stacked.out()).toContain("⛔");
  });

  test("explain phase strips the EXPLAIN prefix and draws the plan", () => {
    const { logger, lines } = capture({ colors: false });
    logger.emit(
      event({
        phase: "explain",
        statements: [
          {
            sql: "EXPLAIN SELECT * FROM user WHERE active = $p0",
            vars: { p0: true },
          },
        ],
        plans: ["SelectProject [ctx: Db]"],
        results: [{ status: "OK" }],
      }),
    );
    const out = lines.join("\n");
    expect(out).toContain("EXPLAIN findMany · user");
    expect(out).toContain("SELECT * FROM user");
    expect(out).not.toContain("EXPLAIN SELECT");
  });
});

// --- compact / json ----------------------------------------------------------------------------

describe("compact rendering", () => {
  test("one line with operation, meta and SQL; slow + error suffixes", () => {
    const { logger, lines } = capture({ format: "compact", colors: false });
    logger.emit(event());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("🔍 findMany · user");
    expect(lines[0]).toContain("1 row");
    expect(lines[0]).toContain("12.4ms");
    expect(lines[0]).toContain("SELECT * FROM user WHERE age >= $p0");
    const slow = capture({ format: "compact", colors: false, slowMs: 1 });
    slow.logger.emit(event({ durationMs: 50 }));
    expect(slow.out()).toContain("🐌");
    const errored = capture({ format: "compact", colors: false });
    errored.logger.emit(
      event({
        error: Object.assign(new Error("nope"), { code: "DatabaseError" }),
      }),
    );
    expect(errored.out()).toContain("⛔ [DatabaseError] nope");
  });
});

describe("json rendering", () => {
  test("emits one parseable object with safe values and severity", () => {
    const { logger, lines } = capture({ format: "json", slowMs: 10 });
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;
    logger.emit(
      event({
        durationMs: 20,
        context: { namespace: "app", database: "main" },
        statements: [
          {
            sql: "SELECT * FROM user",
            vars: {
              rid: new RecordId("user", 1),
              circ: circular,
              date: new Date(Date.UTC(2020, 0, 1)),
            },
          },
        ],
        plans: ["plan"],
        preview: [{ id: "user:1" }],
      }),
    );
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed.level).toBe("warn"); // slow
    expect(parsed.phase).toBe("run");
    expect(parsed.operation).toBe("findMany");
    expect(parsed.context).toEqual({ namespace: "app", database: "main" });
    expect(parsed.rows).toBe("1 row");
    expect(parsed.plans).toEqual(["plan"]);
    expect(parsed.preview).toEqual([{ id: "user:1" }]);
    const vars = (parsed.statements as { vars: Record<string, unknown> }[])[0]
      ?.vars;
    expect(vars?.rid).toBe("user:1");
    expect((vars?.circ as { self: string } | undefined)?.self).toBe(
      "[circular]",
    );
    expect(vars?.date).toBe("2020-01-01T00:00:00.000Z");

    const errored = capture({ format: "json" });
    errored.logger.emit(
      event({ error: Object.assign(new Error("x"), { code: "E" }) }),
    );
    const errParsed = JSON.parse(errored.lines[0] as string) as {
      level: string;
      error: { name: string; code: string; message: string };
    };
    expect(errParsed.level).toBe("error");
    expect(errParsed.error).toEqual({ name: "Error", code: "E", message: "x" });
  });
});

// --- auto-explain ------------------------------------------------------------------------------

describe("planStatement", () => {
  const sql = "SELECT * FROM user WHERE age >= $p0";
  test("off by default, on with the policy", () => {
    expect(
      createQueryLogger({}).planStatement(sql, 999, "run"),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: "slow", slowMs: 10 }).planStatement(
        sql,
        5,
        "run",
      ),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: "slow", slowMs: 10 }).planStatement(
        sql,
        20,
        "run",
      ),
    ).toBe("EXPLAIN FORMAT JSON SELECT * FROM user WHERE age >= $p0;");
    expect(
      createQueryLogger({ explain: "all" }).planStatement(sql, 1, "run"),
    ).toBe("EXPLAIN FORMAT JSON SELECT * FROM user WHERE age >= $p0;");
    expect(
      createQueryLogger({ explain: "analyze" }).planStatement(sql, 1, "run"),
    ).toBe("EXPLAIN ANALYZE FORMAT JSON SELECT * FROM user WHERE age >= $p0;");
  });

  test("never explains non-SELECT / multi-statement / explain-phase / disabled", () => {
    expect(
      createQueryLogger({ explain: "all" }).planStatement(
        "UPDATE user SET x = 1",
        1,
        "run",
      ),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: "all" }).planStatement(
        "SELECT 1; SELECT 2;",
        1,
        "run",
      ),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: "all" }).planStatement(sql, 1, "explain"),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: "all", format: "silent" }).planStatement(
        sql,
        1,
        "run",
      ),
    ).toBeUndefined();
    expect(
      createQueryLogger({ explain: false }).planStatement(sql, 1, "run"),
    ).toBeUndefined();
  });
});

// --- client wiring -----------------------------------------------------------------------------

describe("client wiring (executor seam)", () => {
  test("logger on logs a read; logger: false logs nothing", async () => {
    const on = capture({ colors: false });
    const { conn } = connOf(() => [okr([])]);
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(on), colors: false },
    }) as unknown as C;
    await client.users.findMany({ where: { name: "A" } });
    expect(on.out()).toContain("findMany");
    expect(on.out()).toContain("SELECT * FROM user");

    const off = capture({});
    const { conn: conn2 } = connOf(() => [okr([])]);
    const c2 = betterSchemic(conn2, { schema, logger: false }) as unknown as C;
    await c2.users.findMany({});
    expect(off.lines).toHaveLength(0);
  });

  test("BETTER_SCHEMIC_LOG enables it via env", async () => {
    const saved = process.env.BETTER_SCHEMIC_LOG;
    const lines: string[] = [];
    const original = console.log;
    console.log = ((l: unknown) => lines.push(String(l))) as typeof console.log;
    process.env.BETTER_SCHEMIC_LOG = "compact";
    try {
      const { conn } = connOf(() => [okr([])]);
      const client = betterSchemic(conn, { schema }) as unknown as C;
      await client.users.findMany({});
    } finally {
      console.log = original;
      if (saved === undefined) delete process.env.BETTER_SCHEMIC_LOG;
      else process.env.BETTER_SCHEMIC_LOG = saved;
    }
    expect(lines.join("\n")).toContain("findMany");
  });

  test(".explain() logs the plan while firing no hooks", async () => {
    const sink = capture({ colors: false });
    const { conn } = connOf((sql) =>
      sql.startsWith("EXPLAIN")
        ? [
            okr(
              "SelectProject [ctx: Db]\n    TableScan [ctx: Db] [table: user]",
            ),
          ]
        : [okr([])],
    );
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.users.findMany({ where: { age: { gt: 1 } } }).explain();
    expect(sink.out()).toContain("EXPLAIN findMany");
    expect(sink.out()).toContain("TableScan");
  });

  test("explain: true logs the inline plan", async () => {
    const sink = capture({ colors: false });
    const { conn, calls } = connOf(() => [okr("SelectProject [ctx: Db]")]);
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.users.findMany({ where: { name: "A" }, explain: true });
    expect(calls[0]?.sql.startsWith("EXPLAIN SELECT")).toBe(true);
    expect(sink.out()).toContain("EXPLAIN findMany");
  });

  test("auto-explain 'slow' issues FORMAT JSON and renders the tree", async () => {
    const sink = capture({ colors: false, slowMs: 0, explain: "slow" });
    const { conn, calls } = connOf((sql) =>
      sql.startsWith("EXPLAIN")
        ? [
            okr(
              "SelectProject [ctx: Db]\n    TableScan [ctx: Db] [table: user]",
            ),
          ]
        : sql.split("\n").map(() => okr([])),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: {
        write: sinkOf(sink),
        colors: false,
        slowMs: 0,
        explain: "slow",
      },
    }) as unknown as C;
    await client.users.findMany({});
    expect(calls.some((c) => c.sql.startsWith("EXPLAIN FORMAT JSON"))).toBe(
      true,
    );
    expect(sink.out()).toContain("plan");
    expect(sink.out()).toContain("TableScan");
  });

  test("auto-explain 'analyze' uses ANALYZE FORMAT JSON", async () => {
    const sink = capture({
      format: "compact",
      colors: false,
      explain: "analyze",
    });
    const { conn, calls } = connOf((sql) =>
      sql.startsWith("EXPLAIN") ? [okr("Root [ctx: Db]")] : [okr([])],
    );
    const client = betterSchemic(conn, {
      schema,
      logger: {
        write: sinkOf(sink),
        format: "compact",
        colors: false,
        explain: "analyze",
      },
    }) as unknown as C;
    await client.users.findMany({});
    expect(
      calls.some((c) => c.sql.startsWith("EXPLAIN ANALYZE FORMAT JSON")),
    ).toBe(true);
  });

  test("a failing auto-explain is swallowed (the run still logs)", async () => {
    const sink = capture({ colors: false, slowMs: 0, explain: "slow" });
    const conn = {
      query(sql: string) {
        if (sql.startsWith("EXPLAIN")) throw new Error("explain down");
        return { responses: async () => [okr([])] };
      },
    } as never;
    const client = betterSchemic(conn, {
      schema,
      logger: {
        write: sinkOf(sink),
        colors: false,
        slowMs: 0,
        explain: "slow",
      },
    }) as unknown as C;
    await client.users.findMany({});
    expect(sink.out()).toContain("findMany");
  });

  test("statement errors and transport failures are logged", async () => {
    const stmt = capture({ colors: false });
    const { conn } = connOf(() => [failr("ParseError", "bad sql")]);
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(stmt), colors: false },
    }) as unknown as C;
    await client.users.findMany({}).catch(() => {});
    expect(stmt.out()).toContain("[ParseError]");

    const transport = capture({ colors: false });
    const boom = {
      query() {
        throw new Error("socket closed");
      },
    } as never;
    const c2 = betterSchemic(boom, {
      schema,
      logger: { write: sinkOf(transport), colors: false },
    }) as unknown as C;
    await c2.users.findMany({}).catch(() => {});
    expect(transport.out()).toContain("findMany");
  });

  test("$withContext logs the resolved ns/db scope", async () => {
    const sink = capture({ colors: false });
    const { conn } = connOf((sql) => sql.split("\n").map(() => okr([])));
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    const scoped = client.$withContext({ namespace: "app", database: "main" });
    await scoped.users.findMany({});
    expect(sink.out()).toContain("ns/app · db/main");
  });

  test("raw $raw and verbose previews are logged", async () => {
    const sink = capture({ colors: false, verbose: true, maxRows: 1 });
    const { conn } = connOf(() => [
      okr([{ id: "user:1", name: "A" }, { id: "user:2" }]),
    ]);
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false, verbose: true, maxRows: 1 },
    }) as unknown as C;
    await client.$raw`SELECT * FROM user`;
    expect(sink.out()).toContain("$raw");
    expect(sink.out()).toContain("rows");
    expect(sink.out()).toContain("user:1");
    expect(sink.out()).not.toContain("user:2");
  });

  test("the logger propagates into a transaction", async () => {
    const sink = capture({ colors: false });
    const tx = {
      query: () => ({ responses: async () => [okr([])] }),
      commit: () => Promise.resolve(),
      cancel: () => Promise.resolve(),
    };
    const conn = {
      query: () => ({ responses: async () => [okr([])] }),
      beginTransaction: () => Promise.resolve(tx),
    } as never;
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.transaction(async (t) => {
      await t.users.findMany({});
    });
    expect(sink.out()).toContain("findMany");
  });
});

// --- edge cases (branch coverage of the renderers) ---------------------------------------------

describe("rendering edge cases", () => {
  test("icons fall back through operation → verb → ▸", () => {
    const { operation, ...rest } = event();
    void operation;
    const byVerb = capture({ format: "compact", colors: false });
    byVerb.logger.emit({
      ...rest,
      statements: [{ sql: "INSERT INTO user [1]", vars: {} }],
    });
    expect(byVerb.out()).toContain("➕");
    const unknown = capture({ format: "compact", colors: false });
    unknown.logger.emit({
      ...rest,
      operation: "custom",
      statements: [{ sql: "FOO bar", vars: {} }],
    });
    expect(unknown.out()).toContain("▸");
    const empty = capture({ format: "compact", colors: false });
    empty.logger.emit({ ...rest, statements: [] });
    expect(empty.out()).toContain("▸");
  });

  test("duration formatting covers s/ms/one-decimal/two-decimal", () => {
    const out = (ms: number) => {
      const c = capture({ format: "compact", colors: false });
      c.logger.emit(event({ durationMs: ms }));
      return c.out();
    };
    expect(out(1200)).toContain("1.20s");
    expect(out(250)).toContain("250ms");
    expect(out(12.4)).toContain("12.4ms");
    expect(out(1.5)).toContain("1.50ms");
  });

  test("jsonSafe renders null/undefined/bigint/functions/record-like objects", () => {
    const c = capture({ format: "json" });
    const FakeTable = class Table {};
    const FakeDuration = class Duration {};
    const FakeDecimal = class Decimal {};
    const FakeBound = class BoundQuery {};
    c.logger.emit(
      event({
        statements: [
          {
            sql: "SELECT 1",
            vars: {
              nil: null,
              undef: undefined,
              big: 10n,
              fn: () => {},
              tbOnly: { tb: "user" },
              duck: { tb: "user", id: "x", toString: () => "user:x" },
              table: new FakeTable(),
              duration: new FakeDuration(),
              decimal: new FakeDecimal(),
              bound: new FakeBound(),
              list: [1, { deep: true }],
            },
          },
        ],
        plans: [],
        preview: [],
      }),
    );
    const parsed = JSON.parse(c.lines[0] as string) as {
      statements: { vars: Record<string, unknown> }[];
    };
    const vars = parsed.statements[0]?.vars as Record<string, unknown>;
    expect(vars.nil).toBeNull();
    expect(vars.big).toBe("10");
    expect(vars.tbOnly).toEqual({ tb: "user" });
    expect(vars.duck).toBe("user:x");
    expect(vars.table).toBe("[object Object]");
    expect(vars.list).toEqual([1, { deep: true }]);
    const obj = JSON.parse(c.lines[0] as string) as Record<string, unknown>;
    expect(obj.plans).toBeUndefined();
    expect(obj.preview).toBeUndefined();
  });

  test("pretty handles empty plan/preview arrays and a zero count", () => {
    const c = capture({ colors: false });
    c.logger.emit(
      event({
        operation: "count",
        plans: [],
        preview: [],
        results: [{ status: "OK", rows: 1, count: 0 }],
      }),
    );
    expect(c.out()).toContain("count 0");
  });

  test("pretty valueText covers functions and record-like objects", () => {
    const c = capture({ colors: false });
    const FakeGeometry = class Geometry {};
    c.logger.emit(
      event({
        statements: [
          {
            sql: "SELECT 1",
            vars: {
              fn: () => "x",
              geo: new FakeGeometry(),
              tbOnly: { tb: "u" },
            },
          },
        ],
      }),
    );
    const out = c.out();
    expect(out).toContain("$fn");
    expect(out).toContain("$geo");
    expect(out).toContain("$tbOnly");
  });

  test("errors without code/message/name render fallbacks", () => {
    const plain = capture({ colors: false });
    plain.logger.emit(event({ error: "plain boom" }));
    expect(plain.out()).toContain("⛔ [Error] plain boom");

    const noMessage = capture({ colors: false });
    noMessage.logger.emit(event({ error: { code: "X" } }));
    expect(noMessage.out()).toContain("[X]");

    const compactErr = capture({ format: "compact", colors: false });
    compactErr.logger.emit(event({ error: "nope" }));
    expect(compactErr.out()).toContain("⛔ [Error] nope");

    const jsonErr = capture({ format: "json" });
    jsonErr.logger.emit(event({ error: {} }));
    const parsed = JSON.parse(jsonErr.lines[0] as string) as {
      error: { name: string; message: string };
    };
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("[object Object]");
  });

  test("resolveLogger reads every preset/level from the env", () => {
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "pretty" })?.options
        .format,
    ).toBe("pretty");
    expect(
      resolveLogger(undefined, { BETTER_SCHEMIC_LOG: "silent" })?.enabled,
    ).toBe(false);
    for (const level of ["debug", "info", "warn", "silent"] as const)
      expect(
        resolveLogger(true, { BETTER_SCHEMIC_LOG_LEVEL: level })?.options.level,
      ).toBe(level);
  });

  test("createQueryLogger resolves every explicit option", () => {
    const lines: string[] = [];
    const logger = createQueryLogger({
      level: "info",
      format: "json",
      colors: true,
      icons: false,
      time: false,
      counter: false,
      slowMs: 1,
      verbose: true,
      maxRows: 1,
      maxValueLength: 5,
      prettySql: false,
      explain: "all",
      stack: true,
      write: (l) => lines.push(l),
    });
    expect(logger.options.icons).toBe(false);
    expect(logger.options.explain).toBe("all");
    expect(logger.options.write).toBeFunction();
    logger.emit(event({ durationMs: 5 }));
    expect(lines).toHaveLength(1);

    // The truthy side of every boolean default.
    const truthy = capture({
      level: "warn",
      format: "pretty",
      icons: true,
      time: true,
      counter: true,
      prettySql: true,
    });
    truthy.logger.emit(event({ durationMs: 5, error: "x" }));
    expect(truthy.out()).toContain("╭");
  });

  test("a null error renders a safe fallback", () => {
    const c = capture({ colors: false });
    c.logger.emit(event({ error: null }));
    expect(c.out()).toContain("⛔");
  });

  test("exists probes omit the row label", async () => {
    const sink = capture({ colors: false });
    const { conn } = connOf((sql) =>
      sql.split("\n").map(() => okr([{ id: "user:1" }])),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.users.exists({ where: { name: "A" } });
    expect(sink.out()).toContain("exists");
    expect(sink.out()).not.toContain("row");
  });

  test("count reports the scalar (not a row count)", async () => {
    const sink = capture({ colors: false });
    const { conn } = connOf((sql) =>
      sql.split("\n").map(() => okr([{ count: 42 }])),
    );
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.users.count({});
    expect(sink.out()).toContain("count 42");
  });

  test("raw control statements are stripped from the logged script", async () => {
    const sink = capture({ colors: false });
    const { conn } = connOf((sql) => sql.split("\n").map(() => okr([])));
    const client = betterSchemic(conn, {
      schema,
      logger: { write: sinkOf(sink), colors: false },
    }) as unknown as C;
    await client.$raw(
      "BEGIN TRANSACTION;\nSELECT * FROM user;\nCOMMIT TRANSACTION;",
    );
    const out = sink.out();
    expect(out).toContain("SELECT * FROM user");
    expect(out).not.toContain("BEGIN TRANSACTION");
  });
});
