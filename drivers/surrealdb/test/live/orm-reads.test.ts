// M1.2 — delegate reads against a REAL server: every clause the compiler emits, the decode of
// full/omitted/projected rows, and the `only`/`value` cardinality switches. Ephemeral server;
// skipped when no `surreal` binary is available.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s, surql } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-reads] `surreal` binary unavailable — skipping");

const User = defineTable("rd_user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  at: s.datetime(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string() }),
  contacts: s.array(s.object({ type: s.string(), value: s.string() })),
}).index("rd_idx_name", ["name"], { unique: true });
const schema = defineSchema({ users: User });

live("orm reads — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "orm_reads", database: "live" });
    await db.query(`
      REMOVE TABLE IF EXISTS rd_user;
      DEFINE TABLE rd_user SCHEMAFULL;
      DEFINE FIELD name ON rd_user TYPE string;
      DEFINE FIELD age ON rd_user TYPE int;
      DEFINE FIELD active ON rd_user TYPE bool DEFAULT true;
      DEFINE FIELD at ON rd_user TYPE datetime;
      DEFINE FIELD tags ON rd_user TYPE array<string>;
      DEFINE FIELD address ON rd_user TYPE object;
      DEFINE FIELD address.city ON rd_user TYPE string;
      DEFINE FIELD contacts ON rd_user TYPE array<object>;
      DEFINE FIELD contacts[*].type ON rd_user TYPE string;
      DEFINE FIELD contacts[*].value ON rd_user TYPE string;
      DEFINE INDEX rd_idx_age ON rd_user FIELDS age;
      DEFINE INDEX rd_idx_name ON rd_user FIELDS name UNIQUE;
      DEFINE ANALYZER rd_ascii TOKENIZERS blank,class FILTERS lowercase,ascii;
      DEFINE INDEX rd_idx_name_ft ON rd_user FIELDS name FULLTEXT ANALYZER rd_ascii BM25;

      CREATE rd_user:1 CONTENT { name: "Alice", age: 30, at: d'2025-01-01T00:00:00Z', tags: ["db", "graph"], address: { city: "SP" }, contacts: [{ type: "email", value: "a@x" }] };
      CREATE rd_user:2 CONTENT { name: "Bob", age: 25, active: false, at: d'2025-02-01T00:00:00Z', tags: ["db"], address: { city: "RJ" }, contacts: [{ type: "phone", value: "555" }] };
      CREATE rd_user:3 CONTENT { name: "Carol", age: 35, at: d'2025-03-01T00:00:00Z', tags: [], address: { city: "SP" }, contacts: [] };
    `);
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("findMany: where + orderBy + limit/start, decoded to app values", async () => {
    const rows = await client.users.findMany({
      where: { age: { gte: 25 }, active: true },
      orderBy: [{ age: "desc" }],
      limit: 1,
      start: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Carol");
    expect(rows[0]?.at).toBeInstanceOf(Date);
    expect(rows[0]?.at.toISOString()).toBe("2025-03-01T00:00:00.000Z");
    expect(rows[0]?.id).toBeInstanceOf(RecordId);
    expect(String(rows[0]?.id)).toBe("rd_user:3");
  });

  test("select: fields, paths, aliases and expressions", async () => {
    const rows = await client.users.findMany({
      select: {
        id: true,
        "address.city": true,
        city: "address.city",
        "contacts[*].type": true,
        bump: surql`age + ${1}`.as<number>(),
      },
      where: { id: new RecordId("rd_user", 1) },
    });
    expect(rows).toEqual([
      {
        id: new RecordId("rd_user", 1),
        address: { city: "SP" },
        city: "SP",
        contacts: { type: ["email"] },
        bump: 31,
      },
    ]);
  });

  test("omit drops fields without breaking the decode", async () => {
    const rows = await client.users.findMany({
      omit: ["age", "at", "tags", "address", "contacts"],
      where: { name: "Bob" },
    });
    expect(rows).toEqual([
      { id: new RecordId("rd_user", 2), name: "Bob", active: false },
    ]);
  });

  test("value returns raw values; only unwraps one object", async () => {
    const names = await client.users.findMany({
      select: { name: true },
      value: true,
      orderBy: [{ name: "asc" }],
    });
    expect(names).toEqual(["Alice", "Bob", "Carol"]);

    const one = await client.users.findMany({
      only: true,
      where: { id: new RecordId("rd_user", 1) },
    });
    expect(one?.name).toBe("Alice");
  });

  test("range targets the record range", async () => {
    const rows = await client.users.findMany({
      range: { start: "rd_user:1", end: "rd_user:2", inclusive: true },
      orderBy: [{ age: "asc" }],
    });
    expect(rows.map((r) => r.name)).toEqual(["Bob", "Alice"]);
  });

  test("split unfolds arrays into rows", async () => {
    const rows = await client.users.findMany({
      select: { name: true, tags: true },
      split: "tags",
      where: { age: { lt: 31 } },
      orderBy: [{ name: "asc" }],
    });
    expect(rows).toEqual([
      { name: "Alice", tags: "db" },
      { name: "Alice", tags: "graph" },
      { name: "Bob", tags: "db" },
    ]);
  });

  test("groupBy/groupAll with an aggregate expression", async () => {
    const grouped = await client.users.findMany({
      select: {
        city: "address.city",
        total: surql`math::sum(age)`.as<number>(),
      },
      groupBy: ["address.city"],
      orderBy: [{ city: "asc" }],
    });
    expect(grouped).toEqual([
      { city: "RJ", total: 25 },
      { city: "SP", total: 65 },
    ]);

    const all = await client.users.findMany({
      select: { total: surql`math::sum(age)`.as<number>() },
      groupAll: true,
    });
    expect(all).toEqual([{ total: 90 }]);
  });

  test("with index and timeout ride the statement", async () => {
    const rows = await client.users.findMany({
      where: { age: { gte: 30 } },
      with: { index: "rd_idx_age" },
      timeout: "5s",
      orderBy: [{ age: "desc" }],
    });
    expect(rows.map((r) => r.name)).toEqual(["Carol", "Alice"]);
  });

  test("findFirst misses with null; findOne returns the row", async () => {
    expect(await client.users.findFirst({ where: { age: 999 } })).toBeNull();
    const row = await client.users.findOne({
      where: { name: "Alice" },
      select: { name: true },
    });
    expect(row).toEqual({ name: "Alice" });
  });

  test("count and exists", async () => {
    expect(await client.users.count()).toBe(3);
    expect(await client.users.count({ where: { active: true } })).toBe(2);
    expect(
      await client.users.count({
        range: { start: "rd_user:1", end: "rd_user:2", inclusive: true },
      }),
    ).toBe(2);
    expect(await client.users.exists({ where: { name: "Alice" } })).toBe(true);
    expect(await client.users.exists({ where: { name: "Nobody" } })).toBe(
      false,
    );
  });

  test("aggregate: groupBy, _count, math::* and array::*", async () => {
    const byCity = await client.users.aggregate({
      select: {
        city: "address.city",
        _count: true,
        avgAge: { avg: "age" },
        minAge: { min: "age" },
        names: { collect: "name" },
      },
      groupBy: ["address.city"],
      orderBy: [{ city: "asc" }],
    });
    expect(byCity).toEqual([
      { city: "RJ", _count: 1, avgAge: 25, minAge: 25, names: ["Bob"] },
      {
        city: "SP",
        _count: 2,
        avgAge: 32.5,
        minAge: 30,
        names: ["Alice", "Carol"],
      },
    ]);

    const overall = await client.users.aggregate({
      select: {
        _count: true,
        total: { sum: "age" },
        maxAge: { max: "age" },
        distinctCities: { distinct: "address.city" },
      },
    });
    expect(overall).toEqual([
      {
        _count: 3,
        total: 90,
        maxAge: 35,
        distinctCities: ["SP", "RJ"],
      },
    ]);

    const thrown = (() => {
      try {
        client.users.aggregate({
          select: { _count: true },
          having: { _count: { gt: 1 } },
        } as never);
        return undefined;
      } catch (e) {
        return e as { code: string };
      }
    })();
    expect(thrown?.code).toBe("HavingUnsupported");
  });

  test("paginate: offset pages with total and the count:false probe", async () => {
    const first = await client.users.paginate({
      orderBy: [{ age: "asc" }],
      limit: 2,
      start: 0,
    });
    expect(first.data.map((row) => row.name)).toEqual(["Bob", "Alice"]);
    expect(first.pagination).toEqual({
      type: "offset",
      page: 1,
      perPage: 2,
      total: 3,
      pageCount: 2,
      hasNext: true,
      hasPrevious: false,
    });

    const second = await client.users.paginate({
      orderBy: [{ age: "asc" }],
      limit: 2,
      start: 2,
    });
    expect(second.data.map((row) => row.name)).toEqual(["Carol"]);
    expect(second.pagination).toMatchObject({
      page: 2,
      hasNext: false,
      hasPrevious: true,
    });

    const probed = await client.users.paginate({
      orderBy: [{ age: "asc" }],
      limit: 2,
      count: false,
    });
    expect(probed.data).toHaveLength(2);
    expect("total" in probed.pagination).toBe(false);
    expect(probed.pagination.hasNext).toBe(true);
  });

  test("cursor: forward pages via nextCursor and backward via before", async () => {
    const first = await client.users.cursor({ limit: 2 });
    expect(first.data.map((row) => String(row.id))).toEqual([
      "rd_user:1",
      "rd_user:2",
    ]);
    expect(first.pagination).toEqual({
      type: "cursor",
      hasNext: true,
      hasPrevious: false,
      nextCursor: new RecordId("rd_user", 2),
      previousCursor: null,
    });

    const second = await client.users.cursor({
      limit: 2,
      after: first.pagination.nextCursor as RecordId,
    });
    expect(second.data.map((row) => String(row.id))).toEqual(["rd_user:3"]);
    expect(second.pagination).toMatchObject({
      hasNext: false,
      hasPrevious: true,
    });

    const back = await client.users.cursor({
      limit: 1,
      before: new RecordId("rd_user", 3),
    });
    expect(back.data.map((row) => String(row.id))).toEqual(["rd_user:2"]);
    expect(back.pagination).toMatchObject({
      hasNext: true,
      hasPrevious: true,
    });
  });

  test("cursor: a tuple keyset over (age desc, id asc)", async () => {
    const first = await client.users.cursor({
      orderBy: [{ age: "desc" }, { id: "asc" }],
      limit: 2,
    });
    expect(first.data.map((row) => row.name)).toEqual(["Carol", "Alice"]);
    expect(first.pagination.nextCursor).toEqual({
      age: 30,
      id: new RecordId("rd_user", 1),
    });

    const second = await client.users.cursor({
      orderBy: [{ age: "desc" }, { id: "asc" }],
      limit: 2,
      after: first.pagination.nextCursor as Record<string, unknown>,
    });
    expect(second.data.map((row) => row.name)).toEqual(["Bob"]);
    expect(second.pagination.hasNext).toBe(false);
  });

  test("explain: true / .explain() return the server plan without executing", async () => {
    const plan = await client.users.findMany({
      where: { active: true },
      explain: true,
    });
    expect(plan.driver).toBe("surrealdb");
    expect(plan.operation).toBe("findMany");
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]?.key).toBe("data");
    expect(plan.statements[0]?.surql).toContain("WHERE active = $p0");
    expect(typeof plan.statements[0]?.plan).toBe("string");

    const lazy = await client.users
      .findMany({ where: { age: { gt: 1 } } })
      .explain();
    expect(lazy.operation).toBe("findMany");

    const pagePlan = await client.users.paginate({ limit: 2, explain: true });
    expect(pagePlan.statements.map((s) => s.key)).toEqual(["data", "total"]);

    const countPlan = await client.users.count({ explain: true });
    expect(countPlan.statements[0]?.key).toBe("count");
  });

  test("findUnique by id and by a UNIQUE column; .throw() guarantees the row", async () => {
    const byId = await client.users.findUnique({
      where: { id: new RecordId("rd_user", 2) },
    });
    expect(byId?.name).toBe("Bob");

    const byName = await client.users.findUnique({
      where: { name: "Carol" },
    });
    expect(byName?.age).toBe(35);

    const missed = await client.users.findUnique({
      where: { name: "Nobody" },
    });
    expect(missed).toBeNull();

    const thrown = (await client.users
      .findUnique({ where: { name: "Nobody" } })
      .throw()
      .catch((e: unknown) => e)) as { code: string };
    expect(thrown.code).toBe("ResultNotFound");

    const guaranteed = await client.users
      .findUnique({ where: { name: "Alice" } })
      .throw();
    expect(guaranteed.name).toBe("Alice");
  });

  test("where vocabulary end-to-end (strings/comparison/arrays/logical/paths)", async () => {
    const names = async (where: object) =>
      (
        await client.users.findMany({
          where: where as never,
          select: { name: true },
          orderBy: [{ name: "asc" }],
        })
      ).map((row) => row.name);

    // Strings (functions, not operators, where SurrealQL has none).
    expect(await names({ name: { startsWith: "A" } })).toEqual(["Alice"]);
    expect(await names({ name: { endsWith: "l" } })).toEqual(["Carol"]);
    expect(await names({ name: { contains: "ar" } })).toEqual(["Carol"]);
    expect(await names({ name: { eqInsensitive: "alice" } })).toEqual([
      "Alice",
    ]);
    expect(await names({ name: { containsInsensitive: "BO" } })).toEqual([
      "Bob",
    ]);
    expect(await names({ name: { matches: /^A/ } })).toEqual(["Alice"]);
    expect(await names({ name: { length: 5 } })).toEqual(["Alice", "Carol"]);

    // Comparison / sets.
    expect(await names({ age: { between: [25, 30] } })).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(await names({ age: { outside: [25, 30] } })).toEqual(["Carol"]);
    expect(await names({ age: { in: [25, 35] } })).toEqual(["Bob", "Carol"]);
    expect(await names({ age: { notIn: [25, 35] } })).toEqual(["Alice"]);

    // Arrays.
    expect(await names({ tags: { contains: "graph" } })).toEqual(["Alice"]);
    expect(await names({ tags: { containsAny: ["graph", "x"] } })).toEqual([
      "Alice",
    ]);
    expect(await names({ tags: { containsNone: ["db"] } })).toEqual(["Carol"]);
    expect(await names({ tags: { anyEquals: "db" } })).toEqual([
      "Alice",
      "Bob",
    ]);
    // `*=` (allEquals/all) is VACUOUSLY true on an empty array (Carol) — SurrealQL semantics.
    expect(await names({ tags: { allEquals: "db" } })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ tags: { any: { equals: "db" } } })).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(await names({ tags: { all: { equals: "db" } } })).toEqual([
      "Bob",
      "Carol",
    ]);

    // Logical + paths.
    expect(await names({ OR: [{ name: "Bob" }, { name: "Carol" }] })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ NOT: { name: "Bob" } })).toEqual(["Alice", "Carol"]);
    expect(await names({ name: { not: { contains: "o" } } })).toEqual([
      "Alice",
    ]);
    expect(await names({ "address.city": "RJ" })).toEqual(["Bob"]);
    expect(await names({ "contacts[*].type": "phone" })).toEqual(["Bob"]);
  });

  test("matchesFullText rides the full-text index (@@ and @n@)", async () => {
    const all = await client.users.findMany({
      where: { name: { matchesFullText: "alice" } },
      select: { name: true },
    });
    expect(all).toEqual([{ name: "Alice" }]);

    const indexed = await client.users.findMany({
      where: { name: { matchesFullText: { query: "bob", index: 0 } } },
      select: { name: true },
    });
    expect(indexed).toEqual([{ name: "Bob" }]);
  });

  test("aggregate: median/distinct/collect decode through field codecs", async () => {
    const rows = (await client.users.aggregate({
      select: {
        medianAge: { median: "age" },
        distinctCities: { distinct: "address.city" },
        ats: { collect: "at" },
      },
    })) as { medianAge: number; distinctCities: string[]; ats: Date[] }[];
    expect(rows[0]?.medianAge).toBe(30);
    expect([...(rows[0]?.distinctCities ?? [])].sort()).toEqual(["RJ", "SP"]);
    expect(rows[0]?.ats).toHaveLength(3);
    expect(rows[0]?.ats.every((at) => at instanceof Date)).toBe(true);
  });

  test("cursor + where, paginate group count, split full-row, value fragment, findUnique explain", async () => {
    const first = await client.users.cursor({
      where: { active: true },
      limit: 1,
    });
    expect(first.data.map((row) => String(row.id))).toEqual(["rd_user:1"]);

    const second = await client.users.cursor({
      where: { active: true },
      limit: 1,
      after: first.pagination.nextCursor as RecordId,
    });
    expect(second.data.map((row) => String(row.id))).toEqual(["rd_user:3"]);

    const grouped = await client.users.paginate({
      select: { city: "address.city" },
      groupBy: ["address.city"],
      limit: 10,
    });
    expect(grouped.pagination.total).toBe(2); // counts GROUPS
    expect(grouped.data).toHaveLength(2);

    const split = await client.users.findMany({
      split: "tags",
      where: { name: "Alice" },
      orderBy: [{ tags: "asc" }],
    });
    expect(split.map((row) => row.tags)).toEqual(["db", "graph"]);

    const doubled = await client.users.findMany({
      select: { d: surql`age * 2`.as<number>() },
      value: true,
    });
    expect([...(doubled as number[])].sort((a, b) => a - b)).toEqual([
      50, 60, 70,
    ]);

    const plan = await client.users.findUnique({
      where: { name: "Alice" },
      explain: true,
    });
    expect(plan.statements[0]?.key).toBe("data");
    expect(typeof plan.statements[0]?.plan).toBe("string");
  });
});
