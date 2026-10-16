// M1.2 — the read compiler and the delegate: golden args -> exact `{ sql, vars }`, projection
// decode (full/omit/select/value/only), lazy execution and the teaching guards. Offline.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileOrderBy,
  compileRead,
  type ReadArgs,
} from "../../src/orm/compiler/select";
import {
  compileAggregate,
  compileCount,
  compileExists,
} from "../../src/orm/compiler/aggregate";
import { createBinds } from "../../src/orm/compiler/shared";
import {
  requireUniqueField,
  uniqueTarget,
} from "../../src/orm/compiler/unique";
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
      spec: { star: true, fields: [], omit: [], value: false, includes: [] },
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
      spec: { star: true, fields: [], omit: [], value: false, includes: [] },
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
        includes: [],
      },
    });
  });
});

describe("read compiler — plugin scope", () => {
  const scope = { active: { equals: true } };
  const scopedSql = (
    args: ReadArgs,
    options?: Parameters<typeof compileRead>[4],
  ): string => compileRead(meta, args, createBinds(), "findUnique", options).sql;

  test("findMany ANDs the scope into the caller's where", () => {
    expect(compile({ where: { name: "A" }, scope }).sql).toBe(
      "SELECT * FROM user WHERE (name = $p0 AND active = $p1)",
    );
  });

  test("a null/absent where still gets the scope; an empty scope is a no-op", () => {
    expect(compile({ where: null, scope }).sql).toBe(
      "SELECT * FROM user WHERE active = $p0",
    );
    expect(compile({ scope }).sql).toBe("SELECT * FROM user WHERE active = $p0");
    // An empty scope bag never reaches the compiler as an AND branch.
    expect(compile({ where: { name: "A" }, scope: {} }).sql).toBe(
      "SELECT * FROM user WHERE name = $p0",
    );
  });

  test("a fragment where is ANDed with the scope", () => {
    expect(compile({ where: surql`name = "A"`, scope }).sql).toBe(
      'SELECT * FROM user WHERE ((name = "A") AND active = $p0)',
    );
  });

  test("count/exists/aggregate scope their own WHERE", () => {
    expect(compileCount(meta, { scope }, createBinds(), "count", {})).toBe(
      "SELECT count() FROM user WHERE active = $p0 GROUP ALL",
    );
    expect(compileExists(meta, { scope }, createBinds(), "exists", {})).toBe(
      "SELECT VALUE id FROM user WHERE active = $p0 LIMIT $p1",
    );
    expect(
      compileAggregate(
        meta,
        { select: { _count: true }, scope },
        createBinds(),
        "aggregate",
        {},
      ).sql,
    ).toBe("SELECT count() AS _count FROM user WHERE active = $p0 GROUP ALL");
  });

  test("findUnique scopes BOTH the id target and the unique-field target", () => {
    expect(
      scopedSql(
        { where: undefined, only: true, scope },
        { target: "ONLY user:1" },
      ),
    ).toBe("SELECT * FROM ONLY user:1 WHERE active = $p0");
    expect(scopedSql({ where: { name: "A" }, scope, limit: 1 })).toBe(
      "SELECT * FROM user WHERE (name = $p0 AND active = $p1) LIMIT $p2",
    );
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

describe("read compiler — projection edge paths", () => {
  test("array/object path descent marks `each`", () => {
    expect(compile({ select: { "tags[*]": true } }).spec.fields[0]?.each).toBe(
      true,
    );
    expect(
      compile({ select: { "contacts.value": true } }).spec.fields[0]?.each,
    ).toBe(true);
    expect(compile({ select: { "tags[0]": true } }).spec.fields[0]?.each).toBe(
      false,
    );
    expect(
      compile({ select: { "address.city": true } }).spec.fields[0]?.each,
    ).toBe(false);
  });

  test("select array + value projects the expression", () => {
    expect(compile({ select: ["name"], value: true }).sql).toBe(
      "SELECT VALUE name FROM user",
    );
  });

  test("star guards: '*' must be true; value can't combine with '*'", () => {
    expect(codeOf(() => compile({ select: { "*": 5 } }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() => compile({ select: { "*": true }, value: true })),
    ).toBe("ValidationError");
  });

  test("split on a non-array field fails", () => {
    expect(codeOf(() => compile({ split: "name" }))).toBe("ValidationError");
  });

  test("nested select guards: alias, expression, invalid entry", () => {
    expect(codeOf(() => compile({ select: { address: { city: "x" } } }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() => compile({ select: { address: { city: surql`1` } } })),
    ).toBe("ValidationError");
    expect(codeOf(() => compile({ select: { name: 5 } }))).toBe(
      "ValidationError",
    );
  });

  test("a nested child set to false is skipped", () => {
    expect(
      compile({ select: { address: { city: false, country: true } } }).sql,
    ).toBe("SELECT address.country FROM user");
  });

  test("omit entries must be field names", () => {
    expect(codeOf(() => compile({ omit: [5] }))).toBe("ValidationError");
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

describe("compileOrderBy guards", () => {
  test("empty, skipped, non-object and bad directions are rejected", () => {
    const b = createBinds();
    expect(codeOf(() => compileOrderBy([], b, "op"))).toBe("ValidationError");
    expect(codeOf(() => compileOrderBy([undefined], b, "op"))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileOrderBy([5], b, "op"))).toBe("ValidationError");
    expect(codeOf(() => compileOrderBy([{ a: "up" }], b, "op"))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileOrderBy([{ a: undefined }], b, "op"))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileOrderBy([{ a: 5 }], b, "op"))).toBe(
      "ValidationError",
    );
  });

  test("fragments (bare and as a direction) and plain fields", () => {
    const b = createBinds();
    expect(compileOrderBy([surql`rand()`], b, "op")).toBe("ORDER BY rand()");
    expect(compileOrderBy([{ a: surql`rand()` }], b, "op")).toBe(
      "ORDER BY rand()",
    );
    expect(compileOrderBy([{ a: "desc" }], b, "op")).toBe("ORDER BY a DESC");
  });
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

  test("a field-list path resolves its value from the nested raw row", async () => {
    const { conn } = fakeConn(() => [
      ok([
        {
          address: { city: "SP" },
          contacts: { type: ["email", "phone"] },
        },
      ]),
    ]);
    const c = betterSchemic(conn, { schema: { users: User } });
    // A dotted/bracketed array entry is off the typed surface (`keyof App[]`), but the decoder
    // must still find the value the server returns NESTED for the projected path.
    const rows = await c.users.findMany({
      select: ["address.city", "contacts[*].type"] as never,
    });
    expect(rows as unknown).toEqual([
      { "address.city": "SP", "contacts[*].type": ["email", "phone"] },
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

  test("by a single-field UNIQUE column accepts an { equals } wrapper", async () => {
    const { conn, calls } = fakeConn(() => [ok([fullAccount("a5")])]);
    const client = betterSchemic(conn, { schema: accountSchema });
    await client.accounts.findUnique({
      where: { email: { equals: "a5@x" } },
    });
    expect(calls[0]?.vars).toEqual({ p0: "a5@x", p1: 1 });
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
    // A single unique field with MORE than one operator is not a pure equality.
    expect(code({ where: { email: { equals: "x", gt: "y" } } })).toBe(
      "UniqueTargetRequired",
    );
    expect(code({ where: { id: "other:a1" } })).toBe("ValidationError");
    // A malformed id value (empty object / nested equals object) is not a record id.
    expect(code({ where: { id: {} } })).toBe("UniqueTargetRequired");
    expect(code({ where: { id: { equals: {} } } })).toBe("UniqueTargetRequired");
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

  test("count supports with/version/timeout clauses", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ count: 1 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    await client.users.count({
      with: { index: "i" },
      version: new Date("2025-01-01T00:00:00Z"),
      timeout: 5,
    } as never);
    expect(calls[0]?.sql).toContain("WITH INDEX i");
    expect(calls[0]?.sql).toContain("VERSION");
    expect(calls[0]?.sql).toContain("TIMEOUT");
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

  test("split is the UNWIND+GROUP lowering (SPLIT itself moves into a subquery)", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ _count: 3 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    // SurrealDB rejects `SPLIT … GROUP ALL` in one SELECT, so the split runs in an inner subquery
    // and the grouping happens over its rows — see `compileSplitAggregate`.
    const rows = await client.users.aggregate({
      select: { _count: true },
      split: "tags",
    });
    expect(calls[0]?.sql).toBe(
      "SELECT count() AS _count FROM (SELECT tags AS _split_tags FROM user SPLIT tags) GROUP ALL;",
    );
    expect(rows).toEqual([{ _count: 3 }]);
  });

  test("split + groupBy still groups the OUTER query", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(() =>
      client.users.aggregate({
        select: { name: "name", _count: true },
        split: "tags",
        groupBy: ["name"],
      } as never),
    ).not.toThrow();
    expect(() =>
      client.users.aggregate({
        select: { name: "name", _count: true },
        split: "tags",
        groupAll: true,
        groupBy: ["name"],
      } as never),
    ).toThrow(/OR "groupAll"/);
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

  test("aggregate supports with/version/timeout and expression entries", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ _count: 1, x: 2 }])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    await client.users.aggregate({
      select: { _count: true, x: surql`count() + 1` },
      with: { index: "i" },
      version: new Date("2025-01-01T00:00:00Z"),
      timeout: 5,
    } as never);
    expect(calls[0]?.sql).toContain("WITH INDEX i");
    expect(calls[0]?.sql).toContain("VERSION");
    expect(calls[0]?.sql).toContain("TIMEOUT");
    expect(calls[0]?.sql).toContain("(count() + 1) AS x");
  });

  test("groupBy + groupAll together is rejected", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    expect(() =>
      client.users.aggregate({
        select: { _count: true },
        groupBy: ["active"],
        groupAll: true,
      } as never),
    ).toThrow(/ClauseNotSupported|mutually|groupBy/);
  });
});

describe("delegate — aggregate aliases and operand guards", () => {
  const Shop = defineTable("shop", {
    name: s.string(),
    revenue: s.decimal(),
    owner: s.recordId("user"),
    products: s.array(s.recordId("product")),
    seats: s.array(s.string()),
  });
  const shopSchema = { shops: Shop };

  test("groupBy accepts the ALIAS a select entry created (and the path behind it)", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ name: "Ana", _count: 1 }])]);
    const client = betterSchemic(conn, { schema: shopSchema });
    const rows = await client.shops.aggregate({
      select: { name: "name", _count: true },
      groupBy: ["name"],
    });
    expect(calls[0]?.sql).toBe(
      "SELECT name AS name, count() AS _count FROM shop GROUP BY name;",
    );
    expect(rows).toEqual([{ name: "Ana", _count: 1 }]);
  });

  test("groupBy accepts a nested path projected under an alias", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { users: User } });
    await client.users.aggregate({
      select: { city: "address.city", _count: true },
      groupBy: ["city"],
    });
    expect(calls[0]?.sql).toContain("GROUP BY city");
  });

  test("a non-numeric operand is refused instead of silently answering 0", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (() => {
      try {
        client.users.aggregate({ select: { total: { sum: "name" } } });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain("only aggregates NUMBERS");
    expect(err?.message).toContain("would answer 0");
  });

  test("sum through a link or an array points at split", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: shopSchema });
    const message = (args: unknown) => {
      try {
        client.shops.aggregate(args as never);
        return "";
      } catch (e) {
        return (e as BetterSchemicError).message ?? "";
      }
    };
    expect(message({ select: { t: { sum: "owner.name" } } })).toContain(
      "record link",
    );
    expect(message({ select: { t: { sum: "products[*].name" } } })).toContain(
      "list of record link",
    );
    expect(message({ select: { t: { sum: "seats" } } })).toContain(
      "an array field",
    );
    expect(message({ select: { t: { sum: "products[*].quantity" } } })).toContain(
      "split",
    );
  });

  test("min/max stay numeric-only (the server answers null for a string/datetime)", async () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    // Live 3.3.4: math::min/max(string | datetime | bool) -> null, with no error — the same silent
    // lie as sum(0). The teaching error points at array::min(array::group(…)).
    for (const [args, answer] of [
      [{ select: { oldest: { max: "name" } } }, "null"],
      [{ select: { earliest: { min: "at" } } }, "null"],
    ] as const) {
      const err = (() => {
        try {
          client.users.aggregate(args as never);
          return undefined;
        } catch (e) {
          return e as BetterSchemicError;
        }
      })();
      expect(err?.code).toBe("ValidationError");
      expect(err?.message).toContain("only aggregates NUMBERS");
      expect(err?.message).toContain(answer);
      expect(err?.message).toContain("array::");
    }
    // The numeric form still compiles.
    const { conn: c2, calls: c2calls } = fakeConn(() => [ok([])]);
    const client2 = betterSchemic(c2, { schema: { users: User } });
    await client2.users.aggregate({ select: { oldest: { max: "age" } } });
    expect(c2calls[0]?.sql).toContain("math::max(age) AS oldest");
  });

  test("an unknown field teaches the field list", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (() => {
      try {
        client.users.aggregate({ select: { t: { sum: "nope.x" } } });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.message).toContain('"nope" is not a field of "user"');
    expect(err?.message).toContain("Known fields");
  });

  test("collect/distinct still accept arrays and links (they are value ops, not math)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: shopSchema });
    await client.shops.aggregate({
      select: { seats: { collect: "seats" }, owners: { distinct: "owner" } },
    });
    expect(calls[0]?.sql).toContain("array::group(seats) AS seats");
    expect(calls[0]?.sql).toContain("array::distinct(owner) AS owners");
  });
});

describe("delegate — aggregate over split (UNWIND + GROUP)", () => {
  const Line = defineTable("line_item", {
    label: s.string(),
    quantity: s.int(),
    price: s.decimal(),
  });
  const Cart = defineTable("cart", {
    name: s.string(),
    tenant: s.string(),
    lines: s.array(s.recordId(() => Line)),
  });
  const cartSchema = { carts: Cart, lines: Line };

  const cartClient = () => betterSchemic(fakeConn().conn, { schema: cartSchema });
  type CartAggregate = Parameters<
    ReturnType<typeof cartClient>["carts"]["aggregate"]
  >[0];
  const perCart = async <R = unknown>(args: CartAggregate, rows: unknown[] = []) => {
    const { conn, calls } = fakeConn(() => [ok(rows)]);
    const client = betterSchemic(conn, { schema: cartSchema });
    const out = (await client.carts.aggregate(args)) as R;
    return { sql: calls[0]?.sql as string, rows: out };
  };

  test("group all over a split lowers to UNWIND-then-GROUP", async () => {
    const { sql } = await perCart({
      split: "lines",
      select: { _count: true, total: { sum: "lines[*].quantity" } },
    });
    expect(sql).toBe(
      "SELECT count() AS _count, math::sum(_split_lines_quantity) AS total " +
        "FROM (SELECT lines AS _split_lines, lines[*].quantity AS _split_lines_quantity FROM cart SPLIT lines) " +
        "GROUP ALL;",
    );
  });

  test("a group key keeps its call-site name so groupBy/decoding agree", async () => {
    const { sql, rows } = await perCart(
      {
        split: "lines",
        select: {
          customerName: "name",
          total: { sum: "lines[*].price" },
        },
        groupBy: ["customerName"],
        orderBy: [{ total: "desc" }],
        limit: 5,
      },
      [{ customerName: "Ana", total: "13.75" }],
    );
    expect(sql).toBe(
      "SELECT customerName, math::sum(_split_lines_price) AS total " +
        "FROM (SELECT lines AS _split_lines, name AS customerName, lines[*].price AS _split_lines_price FROM cart SPLIT lines) " +
        "GROUP BY customerName ORDER BY total DESC LIMIT $p0;",
    );
    expect(rows).toEqual([{ customerName: "Ana", total: "13.75" }]);
  });

  test("collect/min read the element columns and decode them", async () => {
    const { sql, rows } = await perCart(
      {
        split: "lines",
        select: {
          name: "name",
          labels: { collect: "lines[*].label" },
          cheapest: { min: "lines[*].price" },
        },
        groupBy: ["name"],
      },
      [{ name: "Ana", labels: ["a", "b"], cheapest: "3.25" }],
    );
    expect(sql).toContain("array::group(_split_lines_label) AS labels");
    expect(sql).toContain("math::min(_split_lines_price) AS cheapest");
    expect(rows).toEqual([
      { name: "Ana", labels: ["a", "b"], cheapest: "3.25" },
    ]);
  });

  test("the where filters the PARENT rows and rides inside the subquery", async () => {
    const { sql } = await perCart({
      split: "lines",
      where: { tenant: "t1" },
      select: { name: "name", _count: true },
      groupBy: ["name"],
    });
    expect(sql).toBe(
      "SELECT name, count() AS _count " +
        "FROM (SELECT lines AS _split_lines, name AS name FROM cart WHERE tenant = $p0 SPLIT lines) " +
        "GROUP BY name;",
    );
  });

  test("a groupBy key missing from select is still a teaching error", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: cartSchema });
    expect(() =>
      client.carts.aggregate({
        split: "lines",
        select: { _count: true },
        groupBy: ["name"],
      } as never),
    ).toThrow(/missing from select/);
  });

  test("a non-string split is refused (an expression has no idiom to satisfy)", () => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: cartSchema });
    expect(() =>
      client.carts.aggregate({
        split: surql`array::distinct(lines)`,
        select: { _count: true },
      } as never),
    ).toThrow(/must be a field path/);
  });

  test("an aggregate over a plain column is untouched by the split path", async () => {
    const { sql } = await perCart({
      split: "lines",
      select: { name: "name", total: { sum: "lines[*].quantity" } },
    });
    // No groupBy -> GROUP ALL over the split rows.
    expect(sql).toContain("GROUP ALL");
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

describe("composite UNIQUE targets", () => {
  const Account = defineTable("acct", {
    org: s.string(),
    handle: s.string(),
    email: s.string(),
  })
    .index("acct_idx_email", ["email"], { unique: true })
    .index("acct_idx_org_handle", ["org", "handle"], { unique: true });
  const accountSchema = { accts: Account };
  const conn = () => fakeConn(() => [ok([])]).conn;

  test("findUnique by every field of a composite index compiles the conjunction", async () => {
    const { conn: c, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(c, { schema: accountSchema });
    await client.accts.findUnique({ where: { org: "acme", handle: "ana" } });
    expect(calls[0]?.sql).toBe(
      "SELECT * FROM acct WHERE org = $p0 AND handle = $p1 LIMIT $p2;",
    );
    expect(calls[0]?.vars).toEqual({ p0: "acme", p1: "ana", p2: 1 });
  });

  test("a partial composite where still teaches (it can match many rows)", () => {
    const client = betterSchemic(conn(), { schema: accountSchema });
    const message = (where: unknown) => {
      try {
        client.accts.findUnique({ where } as never);
        return "";
      } catch (e) {
        return (e as BetterSchemicError).message;
      }
    };
    // A composite field alone: unique only together with its partner — and the message says so.
    expect(message({ org: "acme" })).toContain("not unique");
    expect(message({ org: "acme" })).toContain("[org, handle]");
    // Two fields that are NOT the index together: one of them IS in a composite group, so the
    // message points at the group — that is the near-miss worth teaching.
    expect(message({ handle: "ana", email: "a@x" })).toContain("not a unique target");
  });

  test("upsert targets a composite index (the multi-tenant case)", async () => {
    const { conn: c, calls } = fakeConn(() => [
      ok([{ id: new RecordId("acct", "1"), org: "acme", handle: "ana", email: "a@x" }]),
    ]);
    const client = betterSchemic(c, { schema: accountSchema });
    await client.accts.upsert({
      where: { org: "acme", handle: "ana" },
      data: { email: "a@x" },
      onMissing: "create",
    });
    const sql = calls[0]?.sql as string;
    expect(sql).toContain("org = $p");
    expect(sql).toContain("handle = $p");
    expect(sql).toMatch(/WHERE[^;]*org[^;]*handle/);
  });
});

describe("split idiom — the reserved alias decision table", () => {
  const Item = defineTable("idiom_item", {
    label: s.string(),
    tags: s.array(s.string()),
  });
  const typed = buildSchemaIndex({ items: Item });
  const table = typed.tables.get("items") as TableMeta;
  const schemaless = buildSchemaIndex({ things: "thing" }).schemaless.get(
    "things",
  ) as unknown as TableMeta;

  const aliasOf = (args: Record<string, unknown>, meta: TableMeta = table) => {
    const binds = createBinds();
    const read = compileRead(meta, args as never, binds);
    return { sql: read.sql, hidden: read.projection.hidden ?? [] };
  };

  test("a select that does NOT project the split field gets the reserved column", () => {
    const { hidden, sql } = aliasOf({ select: { label: true }, split: "tags" });
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT label, tags AS _split_tags FROM idiom_item SPLIT tags");
  });

  test("a select that already projects it, or a bare `*`, need no injection", () => {
    expect(aliasOf({ select: { tags: true }, split: "tags" }).hidden).toEqual([]);
    expect(aliasOf({ split: "tags" }).hidden).toEqual([]);
  });

  test("a `*` that OMITS the split field still needs the idiom", () => {
    const { hidden, sql } = aliasOf({ omit: ["tags"], split: "tags" });
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT *, tags AS _split_tags OMIT tags FROM idiom_item SPLIT tags");
  });

  test("a schemaless entry still gets the column (it has no shape to collide with)", () => {
    const { hidden, sql } = aliasOf(
      { select: { label: true }, split: "tags" },
      schemaless,
    );
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT label, tags AS _split_tags FROM thing SPLIT tags");
  });

  test("a non-string split is rejected before the alias decision", () => {
    expect(() => aliasOf({ split: ["tags"], groupBy: ["label"] })).toThrow();
  });

  test("a cursor column already holding the reserved name blocks the injection", () => {
    const binds = createBinds();
    const read = compileRead(
      table,
      { select: { label: true }, split: "tags" } as never,
      binds,
      "findMany",
      // A caller-supplied alias set (the keyset columns) that already claims the name.
      { aliases: [{ alias: "_split_tags", path: "label" }] },
    );
    // The alias is taken by the caller's own column, so no SECOND copy is appended — and the
    // caller's column is not marked hidden either (the stripper only owns what IT appended).
    expect(read.projection.hidden).toBeUndefined();
    expect(read.sql).toBe("SELECT label, label AS _split_tags FROM idiom_item SPLIT tags");
  });
});

describe("composite UNIQUE — the where-shape decision table", () => {
  const multi = () =>
    defineTable("multi", {
      org: s.string(),
      handle: s.string(),
      email: s.string(),
    })
      .index("multi_email", ["email"], { unique: true })
      .index("multi_org_handle", ["org", "handle"], { unique: true });

  const resolve = (where: unknown) => {
    const meta = buildSchemaIndex({ t: multi() }).tables.get("t") as TableMeta;
    return uniqueTarget(meta, where, "test");
  };

  test("an exact cover resolves; a partial or a foreign pair is refused", () => {
    expect(resolve({ org: "a", handle: "b" })).toEqual({
      kind: "index",
      index: "org_handle",
      entries: [
        ["org", "a"],
        ["handle", "b"],
      ],
    });
    // a partial where (the field IS unique only together with its partner)
    expect(() => resolve({ org: "a" })).toThrow(/not unique/);
    // a pair that is NOT the index
    expect(() => resolve({ email: "a@x", handle: "h" })).toThrow(
      /not a unique target/,
    );
    // an empty where
    expect(() => resolve({})).toThrow(/must target/);
    // an operator is not a pure equality
    expect(() => resolve({ org: "a", handle: { contains: "b" } })).toThrow();
    // a non-object where
    expect(() => resolve("nope")).toThrow(/must target/);
    expect(() => resolve(["org", "handle"])).toThrow(/must target/);
    expect(() => resolve(null)).toThrow(/must target/);
  });

  test("the composite hint appears only when EVERY provided field is in a group", () => {
    const two = defineTable("hint_two", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
    })
      .index("hint_ab", ["a", "b"], { unique: true })
      .index("hint_ac", ["a", "c"], { unique: true });
    const meta = buildSchemaIndex({ t: two }).tables.get("t") as TableMeta;
    // both fields are in a group -> the message says so
    let text = "";
    try {
      uniqueTarget(meta, { a: "1", b: "2" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // … it resolves, so the two-group case above must use a field pair that is NOT a group
    const three = defineTable("hint_three", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
    }).index("hint_ac", ["a", "c"], { unique: true });
    const meta3 = buildSchemaIndex({ t: three }).tables.get("t") as TableMeta;
    try {
      uniqueTarget(meta3, { a: "1", b: "2" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // `a` is in a group, `b` is not -> the generic message (no composite hint)
    expect(text).not.toContain("COMPOSITE unique index");
    expect(text).toContain("not a unique target");
  });

  test("requireUniqueField (the upsertMany conflict target) still takes a SINGLE field", () => {
    const def = defineTable("conflict", { email: s.string(), org: s.string() })
      .index("conflict_email", ["email"], { unique: true })
      .index("conflict_org_email", ["org", "email"], { unique: true });
    const meta = buildSchemaIndex({ t: def }).tables.get("t") as TableMeta;
    expect(() => requireUniqueField(meta, "email", "upsertMany")).not.toThrow();
    // A composite group is not a conflict target: the ON DUPLICATE key needs ONE column.
    expect(() => requireUniqueField(meta, "org", "upsertMany")).toThrow(
      /not unique/,
    );
    expect(() => requireUniqueField(meta, "nope", "upsertMany")).toThrow(
      /not unique/,
    );
  });

  test("a MIXED where names the composite only when every field belongs to one", () => {
    // `a` is in [a,b], `c` is in [c,d], `e` is in no group: two of three are grouped, so the
    // hint does NOT claim "they belong to a COMPOSITE index" — only SOME of them do.
    const mixed = defineTable("mixed_group", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
      d: s.string(),
      e: s.string(),
    })
      .index("mixed_ab", ["a", "b"], { unique: true })
      .index("mixed_cd", ["c", "d"], { unique: true });
    const meta = buildSchemaIndex({ t: mixed }).tables.get("t") as TableMeta;
    let text = "";
    try {
      uniqueTarget(meta, { a: "1", c: "2", e: "3" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("not a unique target");
    expect(text).not.toContain("COMPOSITE unique index");

    // ALL fields in groups, but no single group covers them -> the hint fires.
    let all = "";
    try {
      uniqueTarget(meta, { a: "1", c: "2" } as never, "test");
    } catch (e) {
      all = (e as BetterSchemicError).message ?? "";
    }
    expect(all).toContain("COMPOSITE unique index");
  });

  test("a schemaless entry has no composite groups (nothing to resolve)", () => {
    const schemaless = buildSchemaIndex({ things: "thing" });
    const meta = schemaless.schemaless.get("things") as unknown as TableMeta;
    expect(() => uniqueTarget(meta, { a: 1, b: 2 }, "test")).toThrow(
      /must target/,
    );
    expect(uniqueTarget(meta, { id: "thing:1" }, "test")).toEqual({
      kind: "id",
      id: "1",
    });
  });
});

describe("aggregate operand guard — the permissive/decided table", () => {
  const Loose = defineTable("loose", { name: s.string(), amount: s.int() })
    .schemaless();
  const View = defineTable("viewed", { amount: s.int() }).schemaless().typeAny();
  // A self-referencing table: `owner` is a bare link back to `Deep`. Typed through a two-step
  // declaration so the initializer does not read its own type.
  const deepShape = {
    at: s.datetime(),
    anything: s.any(),
    owner: s.recordId("deep"),
    meta: s.object({ deep: s.boolean() }),
    seats: s.array(s.string()),
    total: s.decimal(),
  };
  const Deep = defineTable("deep", deepShape);
  const deepSchema = { deeps: Deep };

  const message = async (schema: unknown, args: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: schema as never }) as unknown as {
      deeps: { aggregate: (a: unknown) => Promise<unknown> };
    };
    try {
      await client.deeps.aggregate(args);
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("a schemaless or non-SCHEMAFULL table is permissive (no column to judge)", async () => {
    expect(
      await message({ deeps: Loose }, { select: { t: { sum: "whatever" } } }),
    ).toBe("");
    expect(
      await message({ deeps: View }, { select: { t: { sum: "whatever" } } }),
    ).toBe("");
  });

  test("a flexible object and an `any` field are permissive below the surface", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "meta.deep" } } }),
    ).toBe("");
    expect(
      await message(deepSchema, { select: { t: { sum: "anything" } } }),
    ).toBe("");
  });

  test("every teaching message is asserted VERBATIM (a mutation must not slip through)", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { select: { t: { sum: "at" } } },
        'aggregate: select."t".sum can\'t run over "at" — math::sum only aggregates NUMBERS and "at" is a date field — the server would answer 0 for it, with no error. For a date total use a surql fragment (`array::sort…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { max: "at" } } },
        'aggregate: select."t".max can\'t run over "at" — math::max only aggregates NUMBERS and "at" is a date field — the server would answer null for it, with no error. For a date extremum use a surql fragment (`array::max…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { median: "at" } } },
        'aggregate: select."t".median can\'t run over "at" — math::median only aggregates NUMBERS and "at" is a date field — the server would answer an empty object for it, with no error. For a date total use a surql fragment (`array::sort…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { sum: "nope" } } },
        'aggregate: select."t".sum can\'t run over "nope" — "nope" is not a field of "deep". Known fields: at, anything, owner, meta, seats, total, id — or pass a surql fragment.',
      ],
    ];
    for (const [args, exact] of cases)
      expect(await message(deepSchema, args)).toBe(exact);
  });

  test("the link/array walk messages are asserted verbatim too", async () => {
    expect(await message(deepSchema, { select: { t: { sum: "owner.x" } } })).toBe(
      'aggregate: select."t".sum can\'t run over "owner.x" — "owner" is a record link — math::* aggregates ONE field per grouped row, so it can\'t reach through it. Use `aggregate({ split: "owner", select: { t: { sum: "…owner" } } })` for the per-element total, or a surql fragment with array::flatten.',
    );
    expect(await message(deepSchema, { select: { t: { sum: "seats.x" } } })).toBe(
      'aggregate: select."t".sum can\'t run over "seats.x" — "seats" is an array field — math::* aggregates ONE field per grouped row. Use `aggregate({ split: "seats", … })` to aggregate per element, or a surql fragment with array::flatten.',
    );
  });

  test("an ARRAY intermediate segment is refused with the split hint (not a link)", async () => {
    const text = await message(deepSchema, {
      select: { t: { sum: "seats.x" } },
    });
    expect(text).toContain("math::* aggregates ONE field per grouped row");
  });

  test("a SCALAR as an intermediate segment stops the walk (the leaf is unknown)", async () => {
    // `at.x` — `at` is a datetime, so nothing below it is knowable from the schema.
    expect(await message(deepSchema, { select: { t: { sum: "at.x" } } })).toBe("");
  });

  test("a 3-segment path through a link resolves each step (the walk is not one hop)", async () => {
    // `owner.profile.name` — the first segment is a bare link, so the walk stops there with the
    // link teaching error (and the ERROR names the FIRST hop, not the whole path).
    const text = await message(deepSchema, {
      select: { t: { sum: "owner.profile.name" } },
    });
    expect(text).toContain('"owner" is a record link');
    expect(text).toContain("owner.profile.name");
  });

  test("the SET (not array) family is refused on the walk, like the array one", async () => {
    // `seats` is an array; a SET field takes the same branch (the `||` right operand).
    const WithSet = defineTable("with_set", {
      name: s.string(),
      tags: s.set(s.string()),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { w: WithSet } });
    let text = "";
    try {
      await client.w.aggregate({ select: { t: { sum: "tags.x" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("a set field");
  });

  test("a flexible object as the LEAF family is permissive (the `||` right arm)", async () => {
    const ObjLeaf = defineTable("obj_leaf", {
      name: s.string(),
      meta: s.object({ a: s.string() }),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { o: ObjLeaf } });
    let text = "";
    try {
      await client.o.aggregate({ select: { t: { sum: "meta" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // The leaf IS the object itself: math::* over it is not a numeric leaf, but the object
    // family is deliberately permissive (its subfields are the app's business).
    expect(text).toBe("");
  });

  test("a NESTED object path is permissive below the object (its leaf is unknown)", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "meta.deep.x" } } }),
    ).toBe("");
    expect(
      await message(deepSchema, { select: { t: { sum: "owner.x.y" } } }),
    ).toContain("record link");
  });

  test("a bare record link (not a list) is NOT a walkable step", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "owner.x" } } }),
    ).toContain("record link");
  });

  test("min/max on a datetime is refused, pointing at array::min(array::group(…))", async () => {
    const text = await message(deepSchema, {
      select: { t: { max: "at" } },
    });
    expect(text).toContain("would answer null");
    expect(text).toContain("array::");
  });

  test("checkableThroughSplit: every base-column shape is decided", async () => {
    const probe = (split: string, select: Record<string, unknown>) => {
      const { conn } = fakeConn();
      const client = betterSchemic(conn, { schema: deepSchema });
      return (async () => {
        try {
          await client.deeps.aggregate({ split: split as never, select: select as never });
          return "";
        } catch (e) {
          return (e as BetterSchemicError).message ?? "";
        }
      })();
    };
    // an UNKNOWN base column under a split is left to the server (documented escape)
    expect(await probe("seats", { t: { sum: "nope.x" } })).toBe("");
    // a single-segment operand is always checkable (the parent owns the field): `at` is a datetime
    expect(await probe("seats", { t: { sum: "at" } })).toContain(
      "only aggregates NUMBERS",
    );
    // a plain (non-link) array base: the parent still owns it
    expect(await probe("seats", { t: { sum: "seats.x" } })).not.toBe("");
  });

  test("a BARE record field as the split base stays checkable (it is the parent row)", async () => {
    const Bare = defineTable("bare_link", {
      name: s.string(),
      one: s.recordId("bare_link"),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { bare: Bare } });
    let text = "";
    try {
      await client.bare.aggregate({
        split: "one",
        select: { t: { sum: "one.x" } },
      } as never);
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // A bare link is a parent field, so the walk still refuses to reach through it.
    expect(text).toContain("record link");
  });

  test("a split operand on a plain (non-link) field is still checked on the parent", async () => {
    const withSplit = async (select: Record<string, unknown>) => {
      const { conn } = fakeConn();
      const client = betterSchemic(conn, { schema: deepSchema });
      try {
        await client.deeps.aggregate({ split: "seats", select: select as never });
        return "";
      } catch (e) {
        return (e as BetterSchemicError).message ?? "";
      }
    };
    // `seats` is a plain (non-link) array, so the PARENT schema still judges it.
    expect(await withSplit({ t: { sum: "seats" } })).toContain("array field");
    // A RECORD-LIST element is the documented escape: the element's table is not this meta, so
    // only the server can judge it (this is the `getTopProducts` shape).
    const Line = defineTable("lline", { label: s.string() });
    const Shop = defineTable("shop", { lines: s.array(s.recordId(() => Line)) });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { shops: Shop } });
    let text = "";
    try {
      await client.shops.aggregate({
        split: "lines",
        select: { t: { sum: "lines[*].label" } },
      } as never);
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toBe("");
  });
});

describe("aggregate over split — the entry-shape decision table", () => {
  const Item = defineTable("split_item", {
    name: s.string(),
    qty: s.int(),
    tags: s.array(s.string()),
  });
  const Holder = defineTable("split_holder", {
    name: s.string(),
    items: s.array(s.recordId(() => Item)),
    tags: s.array(s.string()),
  });
  const schema = { holders: Holder };

  const sql = async (args: Record<string, unknown>) => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({ split: "items", ...args } as never);
    return calls[0]?.sql as string;
  };

  test("a `true` group key keeps its name; a non-group path gets a reserved column", async () => {
    const text = await sql({ select: { name: "name", _count: true } });
    expect(text).toContain("name AS name");
    expect(text).toContain("GROUP ALL");
  });

  test("a schemaless holder never reaches the operand guard (no table to judge)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { holders: "holder" } });
    await client.holders.aggregate({
      split: "items",
      select: { t: { sum: "anything.at.all" } },
    } as never);
    expect(calls[0]?.sql).toContain("anything.at.all AS _split_anything_at_all");
  });

  test("a schemaless holder still lowers (the where compiles without table meta)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { holders: "holder" } });
    await client.holders.aggregate({
      split: "items",
      select: { _count: true },
      where: { name: "a" },
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT count() AS _count FROM (SELECT items AS _split_items FROM holder WHERE name = $p0 SPLIT items) GROUP ALL;",
    );
  });

  test("a `true` entry CAN be the group key (it rides its own name, and decodes as a leaf)", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([{ name: "A", _count: 2 }]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = (await client.holders.aggregate({
      split: "items",
      select: { name: true, _count: true },
      groupBy: ["name"],
    } as never)) as unknown as { name: string; _count: number }[];
    expect(calls[0]?.sql).toBe(
      "SELECT name, count() AS _count FROM (SELECT items AS _split_items, name AS name FROM split_holder SPLIT items) GROUP BY name;",
    );
    expect(rows).toEqual([{ name: "A", _count: 2 }]);
  });

  test("a fragment entry rides the inner subquery and reads the split row", async () => {
    expect(await sql({ select: { x: surql`count() + 1` } })).toContain(
      "_split_expr_x",
    );
  });

  test("a `true` entry WITHOUT a groupBy rides a reserved column and is not a decode leaf", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ name: "A" }])]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.holders.aggregate({
      split: "items",
      select: { name: true },
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT _split_name AS name FROM (SELECT items AS _split_items, name AS _split_name FROM split_holder SPLIT items) GROUP ALL;",
    );
    // A NON-group entry is not decoded as a typed leaf (there is no group to remount it into) —
    // the raw server value rides through, exactly like a non-group path in a plain aggregate.
    expect(JSON.stringify(rows)).toBe(JSON.stringify([{ name: "A" }]));
  });

  test("undefined/false entries contribute nothing", async () => {
    const text = await sql({
      select: { name: "name", a: undefined, b: false as never },
    });
    // Without a `groupBy` the projected field is not a group key, so it rides a reserved column.
    expect(text).toBe(
      "SELECT _split_name AS name FROM (SELECT items AS _split_items, name AS _split_name FROM split_holder SPLIT items) GROUP ALL;",
    );
  });

  test("an entry can be a PARENT array field (not only the split element)", async () => {
    expect(await sql({ select: { tags: { collect: "tags" } } })).toContain(
      "array::group(_split_tags)",
    );
  });

  test("a single-key group alias equals its own name (no redundant AS)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({
      split: "items",
      select: { holder: "name", total: { sum: "items[*].qty" } },
      groupBy: ["holder"],
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT holder, math::sum(_split_items_qty) AS total " +
        "FROM (SELECT items AS _split_items, name AS holder, items[*].qty AS _split_items_qty FROM split_holder SPLIT items) " +
        "GROUP BY holder;",
    );
  });
});

describe("aggregate over split — the guard/clause tails", () => {
  const Item = defineTable("tail_item", { qty: s.int() });
  const Holder = defineTable("tail_holder", {
    name: s.string(),
    items: s.array(s.recordId(() => Item)),
  });
  const schema = { holders: Holder };

  const compile = async (args: Record<string, unknown>) => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({ split: "items", ...args } as never);
    return calls[0]?.sql as string;
  };
  const reject = async (args: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema });
    try {
      await client.holders.aggregate({ split: "items", ...args } as never);
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("start/timeout ride the OUTER query (they page the groups, not the split rows)", async () => {
    const text = await compile({
      select: { _count: true },
      start: 2,
      timeout: 5,
    });
    expect(text).toContain("START $p0");
    expect(text).toContain("TIMEOUT 5ms");
    expect(text.indexOf("START")).toBeGreaterThan(text.indexOf("GROUP ALL"));
  });

  test("a nested path THROUGH an object segment stays permissive at the leaf", async () => {
    const Nested = defineTable("nested_obj", {
      name: s.string(),
      inner: s.object({ list: s.array(s.string()) }),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { n: Nested } });
    let text = "";
    try {
      await client.n.aggregate({ select: { t: { sum: "inner.list.x" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // The object segment stops the walk: the leaf below it is genuinely unknown to the schema.
    expect(text).toBe("");
  });

  test("a non-object / empty select on the split lowering is refused before the walk", async () => {
    expect(await reject({ select: undefined as never })).toMatch(/non-empty/);
    expect(await reject({ select: [] as never })).toMatch(/non-empty/);
    expect(await reject({ select: "name" as never })).toMatch(/non-empty/);
    expect(await reject({ select: { x: { sum: 1 as never } } })).toMatch(
      /field path/,
    );
    // the operand's right arm: a STRING that is present but empty
    expect(await reject({ select: { x: { sum: "" } } })).toMatch(/field path/);
  });

  test("groupBy + groupAll together is refused on the split lowering too", async () => {
    expect(
      await reject({ select: { _count: true }, groupBy: ["name"], groupAll: true }),
    ).toMatch(/OR "groupAll"/);
  });

  test("groupBy + groupAll together, an empty select and a bad split are all refused", async () => {
    expect(
      await reject({ select: { _count: true }, groupBy: ["name"], groupAll: true }),
    ).toMatch(/OR "groupAll"/);
    expect(await reject({ select: {} })).toMatch(/non-empty/);
    expect(await reject({ select: { x: 1 } })).toMatch(/must be true, a path/);
    expect(await reject({ split: "" })).toMatch(/must be a field path/);
    expect(await reject({ select: { allFalse: false as never } })).toMatch(
      /select is empty/,
    );
  });

  test("a multi-op or non-path aggregator entry is a teaching error", async () => {
    expect(
      await reject({ select: { x: { sum: "items[*].qty", avg: "x" } } }),
    ).toMatch(/one aggregator/);
    expect(await reject({ select: { x: { sum: 1 } } })).toMatch(/field path/);
    expect(await reject({ select: { x: { nope: "items[*].qty" } } })).toMatch(
      /unknown aggregator/,
    );
  });

  test("distinct over an element column lowers to array::distinct", async () => {
    expect(
      await compile({ select: { d: { distinct: "items[*].qty" } } }),
    ).toContain("array::distinct(_split_items_qty) AS d");
  });
});

describe("aggregate guard — the remaining arms (a/any/link/uuid families)", () => {
  const Odd = defineTable("odd", {
    flag: s.boolean(),
    blob: s.bytes(),
    ident: s.uuid(),
    dur: s.duration(),
    geo: s.geometry(),
    links: s.array(s.recordId("odd")),
    one: s.recordId("odd"),
  });
  const schema = { odds: Odd };

  // `aggregate` is a lazy thenable: the compile (and its guards) only run on await.
  const message = async (select: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema });
    try {
      await client.odds.aggregate({ select: select as never });
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("a non-numeric scalar family is refused for every math op", async () => {
    for (const field of ["flag", "blob", "ident", "dur", "geo"] as const) {
      expect(await message({ t: { sum: field } })).toContain(
        "only aggregates NUMBERS",
      );
      expect(await message({ t: { median: field } })).toContain(
        "an empty object",
      );
      expect(await message({ t: { min: field } })).toContain("null");
      expect(await message({ t: { avg: field } })).toContain("0");
    }
  });

  test("a LIST link and a BARE link are both refused, with the split hint", async () => {
    expect(await message({ t: { sum: "links[*].x" } })).toContain(
      "list of record link",
    );
    expect(await message({ t: { sum: "one.x" } })).toContain("record link");
  });

  test("collect/distinct on any family are value ops — never refused", async () => {
    for (const field of ["flag", "blob", "ident", "dur", "geo", "links", "one"] as const) {
      expect(await message({ t: { collect: field } })).toBe("");
      expect(await message({ t: { distinct: field } })).toBe("");
    }
  });

  test("a table with only `id` refuses an unknown field, naming what it does have", async () => {
    const bare = { odds: defineTable("bare_odd", {}) };
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: bare });
    let text = "";
    try {
      await client.odds.aggregate({ select: { t: { sum: "nope.y" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain('"nope" is not a field of "bare_odd"');
    expect(text).toContain("Known fields: id");
  });

  test("an unknown field is refused with the known-field list (a SCHEMAFULL table rejects it too)", async () => {
    const empty = { odds: defineTable("empty_odd", {}) };
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: empty });
    let text = "";
    try {
      await client.odds.aggregate({ select: { t: { sum: "whatever" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("Known fields: id");
  });
});
