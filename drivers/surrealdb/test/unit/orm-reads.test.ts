// M1.2 — the read compiler and the delegate: golden args -> exact `{ sql, vars }`, projection
// decode (full/omit/select/value/only), lazy execution and the teaching guards. Offline.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { compileRead, type ReadArgs } from "../../src/orm/compiler/select";
import { createBinds } from "../../src/orm/compiler/shared";
import type { BetterSchemicError } from "../../src/orm/errors";
import type { TableMeta } from "../../src/orm/meta";
import { buildSchemaIndex } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  at: s.datetime(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
  contacts: s.array(s.object({ type: s.string(), value: s.string() })),
});

const index = buildSchemaIndex({ users: User });
const meta = index.tables.get("users") as TableMeta;

/** Compile a read and capture its statement text + binds. */
function compile(args: ReadArgs, table: TableMeta = meta) {
  const binds = createBinds();
  const read = compileRead(table, args, binds);
  return { sql: read.sql, vars: binds.vars, spec: read.projection };
}

/** Normalize the SDK tag's counted `bind__N` names for stable fragment goldens. */
function stable({ sql, vars }: { sql: string; vars: Record<string, unknown> }) {
  const aliases = new Map<string, string>();
  const text = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!name.startsWith("bind__")) return `$${name}`;
    let alias = aliases.get(name);
    if (!alias) {
      alias = `frag${aliases.size}`;
      aliases.set(name, alias);
    }
    return `$${alias}`;
  });
  const outVars: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(vars))
    outVars[aliases.get(name) ?? name] = value;
  return { sql: text, vars: outVars };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}

describe("read compiler — projection forms", () => {
  test("no select is SELECT *", () => {
    expect(compile({})).toEqual({
      sql: "SELECT * FROM user",
      vars: {},
      spec: { star: true, fields: [], omit: [], value: false },
    });
  });

  test("field lists (object and array)", () => {
    expect(compile({ select: { id: true, name: true } }).sql).toBe(
      "SELECT id, name FROM user",
    );
    expect(compile({ select: ["id", "name"] }).sql).toBe(
      "SELECT id, name FROM user",
    );
  });

  test("paths, nested sub-objects and aliases", () => {
    expect(compile({ select: { "address.city": true } }).sql).toBe(
      "SELECT address.city FROM user",
    );
    expect(
      compile({ select: { address: { city: true, country: true } } }).sql,
    ).toBe("SELECT address.city, address.country FROM user");
    expect(compile({ select: { authorName: "address.city" } }).sql).toBe(
      "SELECT address.city AS authorName FROM user",
    );
  });

  test("star + expression", () => {
    expect(
      stable(compile({ select: { "*": true, score: surql`age + ${1}` } })),
    ).toEqual({
      sql: "SELECT *, (age + $frag0) AS score FROM user",
      vars: { frag0: 1 },
    });
  });

  test("omit (without select)", () => {
    expect(compile({ omit: ["age", "at"] }).sql).toBe(
      "SELECT * OMIT age, at FROM user",
    );
  });

  test("value projects one expression", () => {
    expect(compile({ select: { name: true }, value: true }).sql).toBe(
      "SELECT VALUE name FROM user",
    );
  });

  test("only targets FROM ONLY", () => {
    expect(compile({ only: true }).sql).toBe("SELECT * FROM ONLY user");
  });
});

describe("read compiler — clause order (live-verified)", () => {
  test("where/limit/start", () => {
    expect(
      compile({ where: { age: { gte: 18 } }, limit: 10, start: 5 }),
    ).toEqual({
      sql: "SELECT * FROM user WHERE age >= $p0 LIMIT $p1 START $p2",
      vars: { p0: 18, p1: 10, p2: 5 },
      spec: { star: true, fields: [], omit: [], value: false },
    });
  });

  test("with comes before where", () => {
    expect(
      compile({ with: { index: "idx_name" }, where: { name: "A" } }).sql,
    ).toBe("SELECT * FROM user WITH INDEX idx_name WHERE name = $p0");
    expect(compile({ with: { noIndex: true } }).sql).toBe(
      "SELECT * FROM user WITH NOINDEX",
    );
    expect(compile({ with: { index: ["idx_a", "idx_b"] } }).sql).toBe(
      "SELECT * FROM user WITH INDEX idx_a, idx_b",
    );
  });

  test("split after where, before order", () => {
    expect(
      compile({ where: { age: 1 }, split: "tags", orderBy: [{ tags: "asc" }] })
        .sql,
    ).toBe("SELECT * FROM user WHERE age = $p0 SPLIT tags ORDER BY tags ASC");
  });

  test("group by / group all require a projection", () => {
    expect(compile({ select: { active: true }, groupBy: ["active"] }).sql).toBe(
      "SELECT active FROM user GROUP BY active",
    );
    expect(
      compile({
        select: { active: true, tags: true },
        groupBy: ["active", "tags"],
      }).sql,
    ).toBe("SELECT active, tags FROM user GROUP BY active, tags");
    expect(compile({ select: { active: true }, groupAll: true }).sql).toBe(
      "SELECT active FROM user GROUP ALL",
    );
  });

  test("version precedes timeout", () => {
    expect(
      compile({
        version: "2025-01-01T00:00:00Z",
        timeout: "5s",
        limit: 1,
      }).sql,
    ).toBe(
      "SELECT * FROM user LIMIT $p0 VERSION d'2025-01-01T00:00:00Z' TIMEOUT 5s",
    );
    expect(compile({ timeout: 500 }).sql).toBe(
      "SELECT * FROM user TIMEOUT 500ms",
    );
  });

  test("range targets the record range with the id suffix", () => {
    expect(compile({ range: { start: "user:1", end: "user:100" } }).sql).toBe(
      "SELECT * FROM user:1..100",
    );
    expect(
      compile({
        range: { start: "user:1", end: "user:100", inclusive: true },
      }).sql,
    ).toBe("SELECT * FROM user:1..=100");
    expect(compile({ range: { start: "user:abc", end: "user:xyz" } }).sql).toBe(
      "SELECT * FROM user:abc..xyz",
    );
  });

  test("orderBy fields, aliases and fragments", () => {
    expect(compile({ orderBy: [{ name: "desc" }, { age: "asc" }] }).sql).toBe(
      "SELECT * FROM user ORDER BY name DESC, age ASC",
    );
    expect(compile({ orderBy: [{ _count: "desc" }] }).sql).toBe(
      "SELECT * FROM user ORDER BY _count DESC",
    );
    expect(compile({ orderBy: [surql`rand()`] }).sql).toBe(
      "SELECT * FROM user ORDER BY rand()",
    );
  });

  test("the full clause chain keeps the accepted order", () => {
    expect(
      compile({
        select: { id: true },
        with: { index: "idx_name" },
        where: { age: { gte: 18 } },
        orderBy: [{ name: "desc" }],
        limit: 5,
        start: 0,
        timeout: "5s",
      }),
    ).toEqual({
      sql: "SELECT id FROM user WITH INDEX idx_name WHERE age >= $p0 ORDER BY name DESC LIMIT $p1 START $p2 TIMEOUT 5s",
      vars: { p0: 18, p1: 5, p2: 0 },
      spec: {
        star: false,
        fields: [
          {
            out: ["id"],
            source: ["id"],
            expr: "id",
            each: false,
            schema: expect.anything(),
          },
        ],
        omit: [],
        value: false,
      },
    });
  });
});

describe("read compiler — teaching guards", () => {
  test("parallel/take/skip are rejected", () => {
    expect(codeOf(() => compile({ parallel: true }))).toBe(
      "UnsupportedCapability",
    );
    expect(codeOf(() => compile({ take: 10 }))).toBe("ValidationError");
    expect(codeOf(() => compile({ skip: 10 }))).toBe("ValidationError");
  });

  test("mutually exclusive clauses", () => {
    expect(codeOf(() => compile({ split: "tags", groupAll: true }))).toBe(
      "ClauseNotSupported",
    );
    expect(
      codeOf(() =>
        compile({
          select: { active: true },
          groupBy: ["active"],
          groupAll: true,
        }),
      ),
    ).toBe("ClauseNotSupported");
    expect(
      codeOf(() =>
        compile({ only: true, range: { start: "user:1", end: "user:2" } }),
      ),
    ).toBe("ClauseNotSupported");
    expect(codeOf(() => compile({ with: { index: "i", noIndex: true } }))).toBe(
      "ClauseNotSupported",
    );
  });

  test("groupBy without select is rejected with a pointer to aggregate", () => {
    const err = (() => {
      try {
        compile({ groupBy: ["active"] });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain("aggregate()");
  });

  test("bad literal args", () => {
    expect(codeOf(() => compile({ limit: -1 }))).toBe("ValidationError");
    expect(codeOf(() => compile({ start: 1.5 }))).toBe("ValidationError");
    expect(codeOf(() => compile({ timeout: "5" }))).toBe("ValidationError");
    expect(codeOf(() => compile({ version: "yesterday" }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ orderBy: [{ name: "up" }] }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ value: true }))).toBe("ValidationError");
    expect(
      codeOf(() => compile({ select: { name: true, age: true }, value: true })),
    ).toBe("ValidationError");
  });
});

describe("read compiler — guards (2)", () => {
  test("range bounds must belong to the delegate's table", () => {
    expect(
      codeOf(() => compile({ range: { start: "post:1", end: "post:2" } })),
    ).toBe("ValidationError");
    expect(codeOf(() => compile({ range: "1..2" }))).toBe("ValidationError");
    expect(
      codeOf(() => compile({ range: { start: "user:1", end: "user:2" } })),
    ).toBeUndefined();
  });

  test("with rejects an empty/invalid index and a missing mode", () => {
    expect(codeOf(() => compile({ with: {} }))).toBe("ValidationError");
    expect(codeOf(() => compile({ with: { index: [] } }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ with: { index: [""] } }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compile({ with: "idx" }))).toBe("ValidationError");
  });

  test("omit/select shapes are validated", () => {
    expect(codeOf(() => compile({ omit: "age" }))).toBe("ValidationError");
    expect(codeOf(() => compile({ select: [] }))).toBe("ValidationError");
    expect(codeOf(() => compile({ select: [42] }))).toBe("ValidationError");
    expect(codeOf(() => compile({ select: { "*": false } }))).toBe(
      "ValidationError",
    );
  });

  test("groupBy accepts a single string and rejects non-paths", () => {
    expect(compile({ select: { active: true }, groupBy: "active" }).sql).toBe(
      "SELECT active FROM user GROUP BY active",
    );
    expect(
      codeOf(() => compile({ select: { active: true }, groupBy: [42] })),
    ).toBe("ValidationError");
  });

  test("timeout/version accept their documented value forms", () => {
    expect(
      compile({ version: new Date("2025-01-01T00:00:00Z") }).sql,
    ).toContain("VERSION d'2025-01-01T00:00:00.000Z'");
    expect(codeOf(() => compile({ timeout: -1 }))).toBe("ValidationError");
    expect(codeOf(() => compile({ version: 42 }))).toBe("ValidationError");
  });

  test("orderBy accepts fragments bare and as a field value", () => {
    expect(compile({ orderBy: [surql`rand()`] }).sql).toBe(
      "SELECT * FROM user ORDER BY rand()",
    );
    expect(compile({ orderBy: [{ score: surql`rand()` }] }).sql).toBe(
      "SELECT * FROM user ORDER BY rand()",
    );
  });

  test("value projects the expression and drops a top-level alias", () => {
    expect(compile({ select: { city: "address.city" }, value: true }).sql).toBe(
      "SELECT VALUE address.city FROM user",
    );
  });

  test("split must be a field path (or fragment), not a number", () => {
    expect(codeOf(() => compile({ split: 42 }))).toBe("ValidationError");
  });
});

/** A complete raw row (every required field) for full-row decode tests. */
const fullUser = (id: string, over: Record<string, unknown> = {}) => ({
  id: new RecordId("user", id),
  name: "Alice",
  age: 30,
  active: true,
  at: new DateTime(new Date("2025-01-02T03:04:05Z")),
  tags: ["a"],
  address: { city: "SP", country: "BR" },
  contacts: [{ type: "email", value: "x" }],
  ...over,
});

describe("delegate — findMany", () => {
  const { conn, calls } = fakeConn((sql) =>
    sql.includes("FROM user") ? [ok([fullUser("u1", { name: "Alice" })])] : [],
  );
  const client = betterSchemic(conn, { schema: { users: User } });

  test("compiles, executes once and decodes the rows", async () => {
    const rows = await client.users.findMany({
      where: { age: { gte: 18 } },
      select: { id: true, name: true },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe("SELECT id, name FROM user WHERE age >= $p0;");
    expect(calls[0]?.vars).toEqual({ p0: 18 });
    expect(rows).toEqual([{ id: new RecordId("user", "u1"), name: "Alice" }]);
  });

  test("is lazy — nothing runs until awaited", async () => {
    const { conn: c2, calls: c2calls } = fakeConn(() => [ok([])]);
    const lazyClient = betterSchemic(c2, { schema: { users: User } });
    const pending = lazyClient.users.findMany({ where: { active: true } });
    expect(c2calls).toHaveLength(0);
    await pending;
    expect(c2calls).toHaveLength(1);
  });

  test("decodes a full row through the table codec (datetime -> Date)", async () => {
    const { conn: c3 } = fakeConn(() => [
      ok([fullUser("u2", { name: "Bob" })]),
    ]);
    const c = betterSchemic(c3, { schema: { users: User } });
    const [row] = (await c.users.findMany()) as { at: Date; id: RecordId }[];
    expect(row?.at).toBeInstanceOf(Date);
    expect(row?.at.toISOString()).toBe("2025-01-02T03:04:05.000Z");
    expect(String(row?.id)).toBe("user:u2");
  });

  test("omit decodes the remaining fields (missing required field is fine)", async () => {
    const { conn: c4, calls: c4calls } = fakeConn(() => [
      ok([fullUser("u3", { name: "Carol" })]),
    ]);
    const c = betterSchemic(c4, { schema: { users: User } });
    const rows = await c.users.findMany({ omit: ["age", "at"] });
    expect(c4calls[0]?.sql).toBe("SELECT * OMIT age, at FROM user;");
    expect(rows).toEqual([
      expect.objectContaining({
        id: new RecordId("user", "u3"),
        name: "Carol",
        active: true,
      }),
    ]);
    const keys = Object.keys(rows[0] as object);
    expect(keys).toContain("tags");
    expect(keys).not.toContain("age");
    expect(keys).not.toContain("at");
  });

  test("a path projection decodes per leaf and nests like the server", async () => {
    const { conn: c5 } = fakeConn(() => [
      ok([
        {
          address: { city: "SP" },
          contacts: { type: ["email", "phone"] },
        },
      ]),
    ]);
    const c = betterSchemic(c5, { schema: { users: User } });
    const rows = await c.users.findMany({
      select: { "address.city": true, "contacts[*].type": true },
    });
    expect(rows).toEqual([
      { address: { city: "SP" }, contacts: { type: ["email", "phone"] } },
    ]);
  });

  test("only unwraps a single object", async () => {
    const { conn: c6 } = fakeConn(() => [ok(fullUser("u4", { name: "Dan" }))]);
    const c = betterSchemic(c6, { schema: { users: User } });
    const row = await c.users.findMany({ only: true });
    expect(String((row as { id: RecordId }).id)).toBe("user:u4");
  });

  test("a schemaless delegate passes rows through", async () => {
    const { conn: c7 } = fakeConn(() => [ok([{ anything: 1 }])]);
    const c = betterSchemic(c7, { schema: { audit: "audit_log" } });
    expect(await c.audit.findMany({ where: { anything: 1 } })).toEqual([
      { anything: 1 },
    ]);
  });
});

describe("delegate — findFirst/findOne", () => {
  test("forces LIMIT and resolves null on a miss", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const missing = await client.users.findFirst({ where: { age: 99 } });
    expect(missing).toBeNull();
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE age = $p0 LIMIT $p1;");
    expect(calls[0]?.vars).toEqual({ p0: 99, p1: 1 });
  });

  test("findOne returns the first decoded row", async () => {
    const { conn } = fakeConn(() => [ok([fullUser("u5", { name: "Eve" })])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const row = await client.users.findOne({ where: { name: "Eve" } });
    expect(row?.name).toBe("Eve");
  });

  test(".throw() resolves the row when it exists", async () => {
    const { conn } = fakeConn(() => [ok([fullUser("u6", { name: "Fay" })])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const row = await client.users
      .findFirst({ where: { name: "Fay" } })
      .throw();
    expect(row.name).toBe("Fay");
  });

  test(".throw() on a miss throws ResultNotFound with NotFoundInfo", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const pending = client.users.findFirst({ where: { name: "Nobody" } });
    expect(calls).toHaveLength(0); // still lazy before .throw()
    const err = (await pending.throw().catch((e: unknown) => e)) as Error & {
      code: string;
      table: string;
      operation: string;
    };
    expect(err.code).toBe("ResultNotFound");
    expect(err.table).toBe("user");
    expect(err.operation).toBe("findFirst");
    expect(err.message).toContain("Nobody");
    expect(calls).toHaveLength(1);
  });

  test(".throw(factory) receives the NotFoundInfo", async () => {
    const { conn } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (await client.users
      .findOne({ where: { name: "Ghost" } })
      .throw((info) => new Error(`custom:${info.table}:${info.operation}`))
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("custom:user:findOne");
  });
});

/** A complete raw account row. */
const fullAccount = (id: string, over: Record<string, unknown> = {}) => ({
  id: new RecordId("account", id),
  email: `${id}@x`,
  handle: id,
  org: "acme",
  ...over,
});

describe("delegate — findUnique", () => {
  const Account = defineTable("account", {
    email: s.string(),
    handle: s.string(),
    org: s.string(),
  })
    .index("idx_account_email", ["email"], { unique: true })
    .index("idx_account_handle", ["handle"], { unique: true })
    .index("idx_account_org_handle", ["org", "handle"], { unique: true });
  const accountSchema = { accounts: Account };

  const uniqueConn = (rows: unknown[]) => fakeConn(() => [ok(rows)]).conn;

  test("by id compiles FROM ONLY <record> and unwraps the object", async () => {
    const { conn, calls } = fakeConn(() => [ok(fullAccount("a1"))]);
    const client = betterSchemic(conn, { schema: accountSchema });
    const row = await client.accounts.findUnique({
      where: { id: "account:a1" },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM ONLY account:a1;");
    expect(row?.email).toBe("a1@x");
  });

  test("by id accepts a RecordId and an { equals } wrapper", async () => {
    const { conn, calls } = fakeConn(() => [ok(fullAccount("a2"))]);
    const client = betterSchemic(conn, { schema: accountSchema });
    await client.accounts.findUnique({
      where: { id: new RecordId("account", "a2") },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM ONLY account:a2;");
    await client.accounts.findUnique({
      where: { id: { equals: "account:a3" } },
    });
    expect(calls[1]?.sql).toBe("SELECT * FROM ONLY account:a3;");
  });

  test("by a single-field UNIQUE column compiles WHERE + LIMIT 1", async () => {
    const { conn, calls } = fakeConn(() => [ok([fullAccount("a4")])]);
    const client = betterSchemic(conn, { schema: accountSchema });
    const row = await client.accounts.findUnique({
      where: { email: "a4@x" },
    });
    expect(calls[0]?.sql).toBe(
      "SELECT * FROM account WHERE email = $p0 LIMIT $p1;",
    );
    expect(calls[0]?.vars).toEqual({ p0: "a4@x", p1: 1 });
    expect(row?.email).toBe("a4@x");
  });

  test("a miss resolves null", async () => {
    const client = betterSchemic(uniqueConn([]), { schema: accountSchema });
    expect(
      await client.accounts.findUnique({ where: { email: "nope@x" } }),
    ).toBeNull();
  });

  test("UniqueTargetRequired for non-unique fields, composite indexes and bad shapes", () => {
    const client = betterSchemic(uniqueConn([]), { schema: accountSchema });
    const code = (args: unknown) => {
      try {
        client.accounts.findUnique(args as never);
        return undefined;
      } catch (e) {
        return (e as BetterSchemicError).code;
      }
    };
    expect(code({})).toBe("UniqueTargetRequired");
    expect(code({ where: {} })).toBe("UniqueTargetRequired");
    expect(code({ where: { org: "acme" } })).toBe("UniqueTargetRequired");
    expect(code({ where: { email: "x", handle: "y" } })).toBe(
      "UniqueTargetRequired",
    );
    expect(code({ where: { email: { contains: "@" } } })).toBe(
      "UniqueTargetRequired",
    );
    expect(code({ where: { id: "other:a1" } })).toBe("ValidationError");
  });

  test(".throw() on a findUnique miss throws ResultNotFound", async () => {
    const client = betterSchemic(uniqueConn([]), { schema: accountSchema });
    const err = (await client.accounts
      .findUnique({ where: { handle: "ghost" } })
      .throw()
      .catch((e: unknown) => e)) as BetterSchemicError;
    expect(err.code).toBe("ResultNotFound");
    expect(err.operation).toBe("findUnique");
  });
});

describe("delegate — count/exists", () => {
  test("count compiles GROUP ALL and reads the count", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ count: 3 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(await client.users.count({ where: { age: { gte: 18 } } })).toBe(3);
    expect(calls[0]?.sql).toBe(
      "SELECT count() FROM user WHERE age >= $p0 GROUP ALL;",
    );
    expect(calls[0]?.vars).toEqual({ p0: 18 });
  });

  test("count without a filter and with a range", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ count: 0 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    await client.users.count();
    expect(calls[0]?.sql).toBe("SELECT count() FROM user GROUP ALL;");
    await client.users.count({
      range: { start: "user:1", end: "user:2", inclusive: true },
    });
    expect(calls[1]?.sql).toBe("SELECT count() FROM user:1..=2 GROUP ALL;");
  });

  test("exists compiles the VALUE id probe", async () => {
    const { conn, calls } = fakeConn(() => [ok([new RecordId("user", "u1")])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(await client.users.exists({ where: { name: "Alice" } })).toBe(true);
    expect(calls[0]?.sql).toBe(
      "SELECT VALUE id FROM user WHERE name = $p0 LIMIT $p1;",
    );
    expect(calls[0]?.vars).toEqual({ p0: "Alice", p1: 1 });
  });

  test("exists is false when the probe is empty", async () => {
    const { conn } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(await client.users.exists({ where: { age: 999 } })).toBe(false);
  });

  test("count/exists reject removed args", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(() => client.users.count({ parallel: true } as never)).toThrow(
      /parallel/,
    );
    expect(() => client.users.exists({ take: 1 } as never)).toThrow(/take/);
  });

  test("count of an empty response is 0", async () => {
    const { conn } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(await client.users.count()).toBe(0);
  });

  test("only resolves null on a miss", async () => {
    const { conn } = fakeConn(() => [ok(undefined)]);
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(await client.users.findMany({ only: true })).toBeNull();
  });
});

describe("delegate — aggregate", () => {
  test("_count alone implies GROUP ALL", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ _count: 3 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const rows = await client.users.aggregate({ select: { _count: true } });
    expect(calls[0]?.sql).toBe("SELECT count() AS _count FROM user GROUP ALL;");
    expect(rows).toEqual([{ _count: 3 }]);
  });

  test("groupBy compiles the aggregators and keeps clause order", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([{ city: "SP", _count: 2, avgAge: 30, minAge: 20, names: ["a"] }]),
    ]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const rows = await client.users.aggregate({
      where: { active: true },
      select: {
        city: "address.city",
        _count: true,
        avgAge: { avg: "age" },
        minAge: { min: "age" },
        names: { collect: "name" },
      },
      groupBy: ["address.city"],
      orderBy: [{ _count: "desc" }],
      limit: 10,
      start: 0,
    });
    expect(calls[0]?.sql).toBe(
      "SELECT address.city AS city, count() AS _count, math::mean(age) AS avgAge, math::min(age) AS minAge, array::group(name) AS names FROM user WHERE active = $p0 GROUP BY address.city ORDER BY _count DESC LIMIT $p1 START $p2;",
    );
    expect(calls[0]?.vars).toEqual({ p0: true, p1: 10, p2: 0 });
    expect(rows).toEqual([
      { city: "SP", _count: 2, avgAge: 30, minAge: 20, names: ["a"] },
    ]);
  });

  test("distinct uses array::distinct; math::median/stddev/variance are supported", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    await client.users.aggregate({
      select: {
        tags: { distinct: "tags" },
        m: { median: "age" },
        s: { stddev: "age" },
        v: { variance: "age" },
      },
    });
    expect(calls[0]?.sql).toBe(
      "SELECT array::distinct(tags) AS tags, math::median(age) AS m, math::stddev(age) AS s, math::variance(age) AS v FROM user GROUP ALL;",
    );
  });

  test("collect decodes each element through the field codec", async () => {
    const { conn } = fakeConn(() => [
      ok([
        {
          names: ["Alice", "Bob"],
          ats: [
            new DateTime(new Date("2025-01-01T00:00:00Z")),
            new DateTime(new Date("2025-02-01T00:00:00Z")),
          ],
        },
      ]),
    ]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const rows = (await client.users.aggregate({
      select: { names: { collect: "name" }, ats: { collect: "at" } },
    })) as { names: string[]; ats: Date[] }[];
    expect(rows[0]?.names).toEqual(["Alice", "Bob"]);
    expect(rows[0]?.ats[0]).toBeInstanceOf(Date);
  });

  test("having is rejected as HavingUnsupported", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (() => {
      try {
        client.users.aggregate({
          select: { _count: true },
          having: { _count: { gt: 1 } },
        } as never);
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("HavingUnsupported");
    expect(err?.message).toContain("subquery");
  });

  test("split is rejected (SPLIT and GROUP are mutually exclusive)", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(() =>
      client.users.aggregate({
        select: { _count: true },
        split: "tags",
      } as never),
    ).toThrow(/mutually exclusive/);
  });

  test("a groupBy key missing from select fails with a teaching error", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (() => {
      try {
        client.users.aggregate({
          select: { _count: true },
          groupBy: ["active"],
        });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain('active: "active"');
  });

  test("unknown aggregators and multi-op entries are rejected", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(() =>
      client.users.aggregate({
        select: { x: { nope: "age" } },
      } as never),
    ).toThrow(/unknown aggregator/);
    expect(() =>
      client.users.aggregate({
        select: { x: { sum: "age", avg: "age" } },
      } as never),
    ).toThrow(/one aggregator/);
    expect(() => client.users.aggregate({ select: {} } as never)).toThrow(
      /non-empty/,
    );
  });
});

describe("explain", () => {
  test(".explain() runs EXPLAIN and never the real query", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.startsWith("EXPLAIN") ? [ok("plan-string")] : [ok([fullUser("u1")])],
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const pending = client.users.findMany({ where: { age: { gte: 18 } } });
    expect(calls).toHaveLength(0);
    const explained = await pending.explain();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe("EXPLAIN SELECT * FROM user WHERE age >= $p0;");
    expect(explained).toEqual({
      driver: "surrealdb",
      operation: "findMany",
      statements: [
        {
          key: "data",
          surql: "SELECT * FROM user WHERE age >= $p0",
          vars: { p0: 18 },
          plan: "plan-string",
        },
      ],
      ignoredOptions: [],
    });
  });

  test("explain: true returns the plan inline", async () => {
    const { conn, calls } = fakeConn(() => [ok("plan")]);
    const client = betterSchemic(conn, { schema: { users: User } });
    const plan = await client.users.findMany({ explain: true });
    expect(plan.operation).toBe("findMany");
    expect(calls[0]?.sql).toContain("EXPLAIN SELECT * FROM user");
  });

  test("count/exists/paginate/cursor expose their statement keys", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok("plan")));
    const client = betterSchemic(conn, { schema: { users: User } });
    const countPlan = await client.users.count({ explain: true });
    expect(countPlan.statements[0]?.key).toBe("count");
    const existsPlan = await client.users.exists({ explain: true });
    expect(existsPlan.statements[0]?.key).toBe("exists");

    const paginated = await client.users.paginate({ limit: 5, explain: true });
    expect(paginated.statements.map((s) => s.key)).toEqual(["data", "total"]);
    expect(calls.at(-1)?.sql.split("\n")).toHaveLength(2);

    const cursorPlan = await client.users.cursor({ limit: 5, explain: true });
    expect(cursorPlan.statements[0]?.key).toBe("probe:hasNext");
  });

  test("findFirst keeps .throw() and gains .explain()", async () => {
    const { conn } = fakeConn((sql) =>
      sql.startsWith("EXPLAIN") ? [ok("plan")] : [ok([])],
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const pending = client.users.findFirst({ where: { age: 1 } });
    expect(typeof pending.throw).toBe("function");
    expect(typeof pending.explain).toBe("function");
    const plan = await pending.explain();
    expect(plan.statements[0]?.key).toBe("data");
    expect(await pending).toBeNull();
  });
});
