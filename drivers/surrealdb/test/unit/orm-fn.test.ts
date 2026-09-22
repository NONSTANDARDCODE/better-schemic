// M5.2 — database functions: `fn.call` compilation (RETURN fn::name($p0, …)), name validation and
// the typed per-schema shortcut (named args → positional binds). Offline.
import { describe, expect, test } from "bun:test";
import { defineFunction, defineTable, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
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
