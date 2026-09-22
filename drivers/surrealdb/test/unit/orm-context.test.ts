// M5.3 — `$withContext` (USE prefix, per-call override, session-bound fail-fast, auth overload),
// `extends` reapplication across clones/transactions and `forkSession` isolation. Offline — the
// "connection" is a recording fake (with optional session getters / fork support).
import { describe, expect, test } from "bun:test";
import { defineFunction, defineTable, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught, fakeConn, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

const echo = (sql: string) => sql.split("\n").map((line) => ok(line));

describe("$withContext — prefix scope", () => {
  test("reads are prefixed with USE NS … DB … in the same round-trip", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.users.findMany();
    expect(calls[0]?.sql).toBe("USE NS tenant_a DB app;\nSELECT * FROM user;");
  });

  test("a missing side is inherited from the session", async () => {
    const { conn, calls } = fakeConn(echo);
    Object.assign(conn, { namespace: "tenant_a", database: "app" });
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({ namespace: "other" });
    await tenant.users.findMany();
    expect(calls[0]?.sql).toContain("USE NS other DB app;");
  });

  test("a per-call context overrides the clone", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.users.findMany({ context: { database: "analytics" } });
    expect(calls[0]?.sql).toContain("USE NS tenant_a DB analytics;");
  });

  test("no namespace/database anywhere is a teaching ValidationError", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({ namespace: "tenant_a" });
    const error = await caught(() => tenant.users.findMany());
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });

  test("an unknown option fails fast", () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    expect(() =>
      client.$withContext({
        namespace: "a",
        database: "b",
        nope: true,
      } as never),
    ).toThrow(/unknown option "nope"/);
  });

  test("changes is context-aware (SHOW CHANGES rides the USE prefix)", async () => {
    const { conn, calls } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.changes({ since: 0 });
    expect(calls[0]?.sql).toContain("USE NS tenant_a DB app;");
    expect(calls[0]?.sql).toContain("SHOW CHANGES");

    // A per-call context overrides the clone's namespace.
    await tenant.changes({ since: 0, context: { namespace: "tenant_b" } });
    expect(calls[1]?.sql).toContain("USE NS tenant_b DB app;");
  });

  test("session-bound operations are rejected on a prefix clone", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    for (const call of [
      () => tenant.api.get("/x"),
      () => tenant.auth.invalidate(),
      () => tenant.export(),
      () => tenant.users.live(),
      () => tenant.liveOf("00000000-0000-0000-0000-000000000000"),
      () => tenant.kill("00000000-0000-0000-0000-000000000000"),
    ]) {
      const error = await caught(call);
      expect(isBetterSchemicError(error) && error.code).toBe(
        "UnsupportedCapability",
      );
    }
  });
});

describe("$withContext — auth overload", () => {
  test("forks a session, selects the scope and authenticates", async () => {
    const { conn } = fakeConn(echo);
    const used: unknown[] = [];
    const tokens: unknown[] = [];
    Object.assign(conn, {
      forkSession: async () => ({
        namespace: "parent_ns",
        database: "parent_db",
        use: async (what: unknown) => {
          used.push(what);
          return what;
        },
        authenticate: async (token: unknown) => {
          tokens.push(token);
          return token;
        },
        query: (sql: string) => ({ responses: async () => echo(sql) }),
        closeSession: async () => {},
      }),
    });
    const client = betterSchemic(conn, { schema });
    const scoped = await client.$withContext({
      namespace: "tenant_a",
      database: "app",
      auth: "token-123",
    });
    expect(used).toEqual([{ namespace: "tenant_a", database: "app" }]);
    expect(tokens).toEqual(["token-123"]);
    // The scoped session is a SESSION (no prefix) — session-bound ops are allowed.
    expect(
      (scoped as unknown as { context?: unknown }).context,
    ).toBeUndefined();
  });
});

describe("fn — key guard", () => {
  test('a schema function key "call" fails fast at bootstrap', () => {
    const { conn } = fakeConn(echo);
    const Call = defineFunction("call");
    expect(() =>
      betterSchemic(conn, {
        schema: defineSchema({ users: User, call: Call }),
      }),
    ).toThrow(/would shadow/);
  });
});

describe("extends — reapplication", () => {
  test("helpers are re-applied on clones and inside transactions", async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema }).extends({
      helper: () => "ok",
    });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    expect((tenant as unknown as { helper: () => string }).helper()).toBe("ok");

    const txConn = {
      query: (sql: string) => ({ responses: async () => echo(sql) }),
      beginTransaction: async () => ({
        query: (sql: string) => ({ responses: async () => echo(sql) }),
        commit: async () => {},
        cancel: async () => {},
      }),
    };
    const txClient = betterSchemic(txConn as never, { schema }).extends({
      helper: () => "ok",
    });
    const inTx = await txClient.transaction(async (tx) => {
      return (tx as unknown as { helper: () => string }).helper();
    });
    expect(inTx).toBe("ok");
  });

  test("a colliding helper fails fast", () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    expect(() => client.extends({ users: 1 })).toThrow(/collides/);
  });
});
