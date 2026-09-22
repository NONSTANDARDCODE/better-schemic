// M5.2 — `api`/`auth`/admin: the `DEFINE API` envelope unwrap + status error, the auth passthrough
// (and the record-session mapping), and `info`/`version`/`ping`/`export`/`import`. Offline.
import { describe, expect, test } from "bun:test";
import { ServerError } from "surrealdb";
import { defineTable, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught, fail, fakeConn, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

const echo = (sql: string) => sql.split("\n").map((line) => ok(line));

interface Envelope {
  status?: number;
  body?: unknown;
}

/** A chainable SDK-shaped `ApiPromise` (header/query return the same thenable). */
function apiPromise(
  response: Envelope,
  record: { headers: Record<string, string>; query: Record<string, string> },
): Promise<Envelope> & {
  header(name: string, value: string): unknown;
  query(name: string, value: string): unknown;
} {
  const promise = Promise.resolve(response) as Promise<Envelope> & {
    header(name: string, value: string): unknown;
    query(name: string, value: string): unknown;
  };
  promise.header = (name, value) => {
    record.headers[name] = value;
    return promise;
  };
  promise.query = (name, value) => {
    record.query[name] = value;
    return promise;
  };
  return promise;
}

describe("api", () => {
  test("unwraps the response body and forwards query/headers", async () => {
    const record = {
      headers: {} as Record<string, string>,
      query: {} as Record<string, string>,
    };
    const { conn } = fakeConn();
    Object.assign(conn, {
      api: () => ({
        get: () => apiPromise({ status: 200, body: [{ id: "a:1" }] }, record),
      }),
    });
    const client = betterSchemic(conn, { schema });
    const body = await client.api.get<{ id: string }[]>("/articles", {
      query: { limit: 10 },
      headers: { "accept-language": "pt-BR" },
    });
    expect(body).toEqual([{ id: "a:1" }]);
    expect(record.query).toEqual({ limit: "10" });
    expect(record.headers).toEqual({ "accept-language": "pt-BR" });
  });

  test("a >=400 status throws with the HTTP status and the body", async () => {
    const record = { headers: {}, query: {} };
    const { conn } = fakeConn();
    Object.assign(conn, {
      api: () => ({
        get: () => apiPromise({ status: 418, body: { why: "teapot" } }, record),
      }),
    });
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.api.get("/boom"));
    expect(isBetterSchemicError(error) && error.code).toBe("DatabaseError");
    expect(isBetterSchemicError(error) && error.status).toBe(418);
    expect(isBetterSchemicError(error) && error.details).toEqual({
      why: "teapot",
    });
  });

  test("a path without a leading slash fails fast", async () => {
    const { conn } = fakeConn();
    Object.assign(conn, {
      api: () => ({ get: () => apiPromise({}, { headers: {}, query: {} }) }),
    });
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.api.get("articles"));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });
});

describe("auth", () => {
  test("passthroughs the SDK session methods", async () => {
    const { conn } = fakeConn();
    const seen: unknown[] = [];
    Object.assign(conn, {
      signin: async (auth: unknown) => {
        seen.push(["signin", auth]);
        return { access: "a" };
      },
      authenticate: async (token: unknown) => {
        seen.push(["authenticate", token]);
        return { access: "a" };
      },
      invalidate: async () => {
        seen.push(["invalidate"]);
      },
    });
    const client = betterSchemic(conn, { schema });
    expect(await client.auth.signin({ username: "u", password: "p" })).toEqual({
      access: "a",
    });
    await client.auth.authenticate("token");
    await client.auth.invalidate();
    expect(seen).toEqual([
      ["signin", { username: "u", password: "p" }],
      ["authenticate", "token"],
      ["invalidate"],
    ]);
  });

  test("record() maps the missing-record-user error to NotAuthenticated", async () => {
    const { conn } = fakeConn();
    Object.assign(conn, {
      auth: async () => {
        throw new Error(
          "Expected a single result output when using the ONLY keyword",
        );
      },
    });
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.auth.record());
    expect(isBetterSchemicError(error) && error.code).toBe("NotAuthenticated");
  });
});

describe("admin", () => {
  test("info compiles INFO FOR … and returns the first row", async () => {
    const { conn, calls } = fakeConn(() => [ok({ tables: {} })]);
    const client = betterSchemic(conn, { schema });
    expect(await client.info("db")).toEqual({ tables: {} });
    expect(calls[0]?.sql).toBe("INFO FOR DB;");
    await client.info("table", "user");
    expect(calls[1]?.sql).toBe("INFO FOR TABLE user;");
  });

  test('info("table") without a table fails fast', async () => {
    const { conn } = fakeConn(echo);
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.info("table", undefined as never));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });

  test("version passthroughs the SDK and ping round-trips RETURN true", async () => {
    const { conn, calls } = fakeConn(() => [ok(true)]);
    Object.assign(conn, {
      version: async () => ({ version: "surrealdb-3.2.0" }),
    });
    const client = betterSchemic(conn, { schema });
    expect(await client.version()).toEqual({ version: "surrealdb-3.2.0" });
    expect(await client.ping()).toBe(true);
    expect(calls[0]?.sql).toBe("RETURN true;");
  });

  test("export is session-bound; import replays the dump through query()", async () => {
    const { conn, calls } = fakeConn(echo);
    Object.assign(conn, {
      export: async () => "-- dump\nRETURN 1;",
    });
    const client = betterSchemic(conn, { schema });
    expect(await client.export()).toBe("-- dump\nRETURN 1;");
    await client.import("-- dump\nRETURN 1;");
    expect(calls[0]?.sql).toContain("-- dump");

    const tenant = client.$withContext({ namespace: "t", database: "d" });
    const error = await caught(() => tenant.export());
    expect(isBetterSchemicError(error) && error.code).toBe(
      "UnsupportedCapability",
    );
    await tenant.import("RETURN 1;");
    expect(calls[1]?.sql).toBe("USE NS t DB d;\nRETURN 1;");
  });

  test("import surfaces the first failing statement instead of succeeding silently", async () => {
    const { conn } = fakeConn((sql) =>
      sql
        .split("\n")
        .map((line, index) =>
          index === 1
            ? fail(new ServerError({ kind: "Query", message: "bad dump" }))
            : ok(line),
        ),
    );
    const client = betterSchemic(conn, { schema });
    const error = await caught(() =>
      client.import("RETURN 1;\nTHIS IS NOT SURREALQL;"),
    );
    expect(isBetterSchemicError(error) && error.code).toBe("DatabaseError");
  });
});
