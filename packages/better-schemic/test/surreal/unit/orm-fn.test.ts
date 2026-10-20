// M5.2 — database functions: `fn.call` compilation (RETURN fn::name($p0, …)), name validation and
// the typed per-schema shortcut (named args → positional binds). Offline.
import { describe, expect, test } from "bun:test";
import { defineFunction, defineTable, s, surql } from "../../../src/surreal";
import { betterSchemic } from "../../../src/surreal/orm/client";
import { isBetterSchemicError } from "../../../src/surreal/orm/errors";
import { defineSchema } from "../../../src/surreal/orm/schema";
import { caught, fakeConn, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const CustomerTier = defineFunction("customer_tier", {
  total: s.number(),
}).returns(s.string());
const Ping = defineFunction("ping");
const schema = defineSchema({
  users: User,
  customerTier: CustomerTier,
  ping: Ping,
});

const echo = (sql: string) => sql.split("\n").map(() => ok("gold"));

describe("fn.call", () => {
  test("compiles RETURN fn::name($p0, …) with bound args", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tier = await client.fn.call<string>("fn::customer_tier", [15000]);
    expect(calls[0]?.sql).toBe("RETURN fn::customer_tier($p0);");
    expect(calls[0]?.vars).toEqual({ p0: 15000 });
    expect(tier).toBe("gold");
  });

  test("a bare name resolves under fn::", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    await client.fn.call("customer_tier", [1]);
    expect(calls[0]?.sql).toBe("RETURN fn::customer_tier($p0);");
  });

  test("an invalid name fails fast (no splicing of arbitrary text)", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const error = await caught(() =>
      client.fn.call("fn::x; DROP TABLE user", []),
    );
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });

  test("args must be an array", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.fn.call("fn::x", 1 as never));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });

  test("defineFunction validates the name at authoring time", () => {
    expect(() => defineFunction("bad name")).toThrow(/invalid function name/);
    expect(() => defineFunction("x; DROP TABLE user")).toThrow(
      /invalid function name/,
    );
    expect(() => defineFunction("math_add")).not.toThrow();
    expect(() => defineFunction("math::add")).not.toThrow();
  });
});

describe("fn — typed shortcuts", () => {
  test("named args lower to positional binds in declaration order", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tier = await client.fn.customerTier({ total: 42 });
    expect(calls[0]?.sql).toBe("RETURN fn::customer_tier($p0);");
    expect(calls[0]?.vars).toEqual({ p0: 42 });
    expect(tier).toBe("gold");
  });

  test("a zero-arg function takes no argument object", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    await client.fn.ping();
    expect(calls[0]?.sql).toBe("RETURN fn::ping();");
  });

  test("a function with args rejects a non-object argument", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.fn.customerTier(1 as never));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });
});

describe("fn.expr — the fragment form (composes inside a statement)", () => {
  test("a schema function lowers to a fragment that rides a typed read", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    await client.users.findMany({
      where: { name: { equals: client.fn.expr.customerTier({ total: 15000 }) } },
    });
    // The fragment's own binds are merged into the statement's — no extra round-trip, no $query.
    expect(calls[0]?.sql).toBe(
      "SELECT * FROM user WHERE name = (fn::customer_tier($p0));",
    );
    expect(calls[0]?.vars).toEqual({ p0: 15000 });
  });

  test("it also composes in select and orderBy", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    await client.users.findMany({
      select: { name: true, tier: client.fn.expr.customerTier({ total: 1 }) },
      orderBy: [{ tier: "desc" }],
    });
    expect(calls[0]?.sql).toBe(
      "SELECT name, (fn::customer_tier($p0)) AS tier FROM user ORDER BY tier DESC;",
    );
  });

  test("the dynamic form takes any fn:: (a repo's own function)", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    await client.users.findMany({
      where: { name: { equals: client.fn.expr.call("fn::jw", ["ana"]) } },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE name = (fn::jw($p0));");
    expect(calls[0]?.vars).toEqual({ p0: "ana" });
  });

  test("a zero-arg schema function takes no argument object", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    await client.users.findMany({
      where: { name: { equals: client.fn.expr.ping() } },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE name = (fn::ping());");
  });

  test("a fragment with NO arguments composes too (the dynamic zero-arg form)", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    await client.users.findMany({
      where: { name: { equals: client.fn.expr.call("fn::now") } },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE name = (fn::now());");
  });

  test("a fragment argument can itself be a fragment (they compose)", async () => {
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    const inner = surql`RETURN "a"`;
    await client.users.findMany({
      where: { name: { equals: client.fn.expr.call("fn::jw", [inner]) } },
    });
    expect(calls[0]?.sql).toContain("fn::jw((");
    expect(calls[0]?.sql).toContain('RETURN "a"');
  });

  test("a schema key that would shadow `expr` cannot claim it", () => {
    const shadow = defineSchema({
      users: User,
      expr: defineFunction("expr"),
    });
    const { conn } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    expect(() => betterSchemic(conn, { schema: shadow })).toThrow(/shadow/);
  });

  test("name validation and the named-arg guard hold on the fragment form", async () => {
    const { conn } = fakeConn((sql) => sql.split("\n").map(() => ok([])));
    const client = betterSchemic(conn, { schema });
    expect(() => client.fn.expr.call("fn::x; DROP TABLE user")).toThrow(
      /not a valid function name/,
    );
    expect(() => client.fn.expr.customerTier(1 as never)).toThrow(
      /fn\.expr\.customerTier/,
    );
  });
});
