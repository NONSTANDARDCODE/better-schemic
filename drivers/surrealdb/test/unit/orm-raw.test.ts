// M5.1 — the raw escape hatches: `$raw`/`$query`/`$unsafe`, parameterization, `throwOnError:false`,
// `raw.requireComment`/`raw.timeoutMs`, and the `USE NS … DB …` scope prefix. Offline — the
// "connection" is a recording fake.
import { describe, expect, test } from "bun:test";
import { ServerError, surql } from "surrealdb";
import { defineTable, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught, fail, fakeConn, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

const rawResult = (result: unknown) => (sql: string) => [
  ok(result),
  ...(sql.includes("USE ") ? [] : []),
];

describe("raw — $raw", () => {
  test("a tagged template binds every value as $p<n>", async () => {
    const { conn, calls } = fakeConn(rawResult([{ id: "user:1" }]));
    const client = betterSchemic(conn, { schema });
    const rows = await client.$raw<
      { id: string }[]
    >`SELECT * FROM user WHERE name = ${"Aeon"} AND age > ${18}`;

    expect(calls[0]?.sql).toBe(
      "SELECT * FROM user WHERE name = $p0 AND age > $p1;",
    );
    expect(calls[0]?.vars).toEqual({ p0: "Aeon", p1: 18 });
    expect(rows).toEqual([{ id: "user:1" }]);
  });

  test("a string source takes options (timeout applied to a SELECT)", async () => {
    const { conn, calls } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema });
    await client.$raw("SELECT * FROM user", { timeout: "5s" });
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 5s;");
  });

  test("a BoundQuery source keeps its binds", async () => {
    const { conn, calls } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema });
    await client.$raw(surql`SELECT * FROM user WHERE name = ${"Aeon"}`);
    // A BoundQuery keeps its OWN bind names (the SDK tag already lowered them) — the counter is
    // process-global, so assert the shape + the bound value.
    expect(calls[0]?.sql).toMatch(
      /^SELECT \* FROM user WHERE name = \$bind__\d+;$/,
    );
    expect(Object.values(calls[0]?.vars ?? {})).toEqual(["Aeon"]);
  });

  test("an invalid source is a teaching ValidationError", async () => {
    const { conn } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.$raw(42 as never));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");
  });

  test("the curried options-tag binds options to a template", async () => {
    const { conn, calls } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema });
    await client.$raw({ timeout: 500 })`SELECT * FROM user`;
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 500ms;");
  });
});

describe("raw — $query", () => {
  test("returns one result per statement", async () => {
    const { conn } = fakeConn(() => [ok([1]), ok([2])]);
    const client = betterSchemic(conn, { schema });
    const out = await client.$query<
      [number[], number[]]
    >`SELECT * FROM user; SELECT * FROM post;`;
    expect(out).toEqual([[1], [2]]);
  });

  test("throwOnError:false returns the StatementResult envelopes", async () => {
    const error = new ServerError({ kind: "Query", message: "boom" });
    const { conn } = fakeConn(() => [fail(error)]);
    const client = betterSchemic(conn, { schema });
    const out = await client.$query("SELECT * FROM nope", {
      throwOnError: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("ERR");
    expect(out[0]?.error?.code).toBe("DatabaseError");
  });

  test("the curried options-tag keeps throwOnError:false on a template", async () => {
    const error = new ServerError({ kind: "Query", message: "boom" });
    const { conn } = fakeConn(() => [fail(error)]);
    const client = betterSchemic(conn, { schema });
    const out = await client.$query({
      throwOnError: false,
    })`SELECT * FROM nope`;
    expect(out[0]?.status).toBe("ERR");
  });
});

describe("raw — $unsafe", () => {
  test("is disabled unless raw.unsafe is true", async () => {
    const { conn } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema });
    const error = await caught(() => client.$unsafe("SELECT 1"));
    expect(isBetterSchemicError(error) && error.code).toBe("UnsafeDisabled");
  });

  test("runs with raw.unsafe:true and binds params", async () => {
    const { conn, calls } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, { schema, raw: { unsafe: true } });
    await client.$unsafe("SELECT * FROM user WHERE id = $id", { id: "user:1" });
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE id = $id;");
    expect(calls[0]?.vars).toEqual({ id: "user:1" });
  });
});

describe("raw — defaults", () => {
  test("requireComment demands meta.comment on a write script", async () => {
    const { conn } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, {
      schema,
      raw: { requireComment: true },
    });
    const error = await caught(() => client.$raw("DELETE user"));
    expect(isBetterSchemicError(error) && error.code).toBe("ValidationError");

    const { conn: okConn } = fakeConn(rawResult(1));
    const okClient = betterSchemic(okConn, {
      schema,
      raw: { requireComment: true },
    });
    await okClient.$raw("DELETE user", { meta: { comment: "cleanup" } });
    // A read-only script is exempt.
    await okClient.$raw("SELECT * FROM user");

    // The curried tag is the template-form escape hatch for requireComment.
    const { conn: tagConn, calls } = fakeConn(rawResult(1));
    const tagClient = betterSchemic(tagConn, {
      schema,
      raw: { requireComment: true },
    });
    await tagClient.$raw({ meta: { comment: "seed" } })`DELETE user`;
    expect(calls[0]?.sql).toBe("DELETE user;");
    const stillMissing = await caught(() => tagClient.$raw`DELETE user`);
    expect(isBetterSchemicError(stillMissing) && stillMissing.code).toBe(
      "ValidationError",
    );
  });

  test("timeoutMs applies to a single capable statement only", async () => {
    const { conn, calls } = fakeConn(rawResult(1));
    const client = betterSchemic(conn, {
      schema,
      raw: { timeoutMs: 250 },
    });
    await client.$raw("SELECT * FROM user");
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 250ms;");

    const { conn: other, calls: otherCalls } = fakeConn(() => [
      ok(1),
      ok(2),
      ok(3),
    ]);
    const otherClient = betterSchemic(other, {
      schema,
      raw: { timeoutMs: 250 },
    });
    await otherClient.$query`LET $a = 1; LET $b = 2; RETURN $a;`;
    expect(otherCalls[0]?.sql).not.toContain("TIMEOUT");
  });
});

describe("raw — context scope", () => {
  test("a $withContext clone prefixes USE NS … DB … in the same round-trip", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map((line) => ok(line)),
    );
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.$raw("SELECT * FROM user");
    expect(calls[0]?.sql).toBe("USE NS tenant_a DB app;\nSELECT * FROM user;");
  });

  test("an implicit batch wrapper is prefixed before BEGIN", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map((line) => ok(line)),
    );
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.users.createMany({ data: [{ name: "a" }, { name: "b" }] });
    const sql = calls[0]?.sql ?? "";
    expect(sql.startsWith("USE NS tenant_a DB app;\nBEGIN TRANSACTION;")).toBe(
      true,
    );
    expect(sql.trimEnd().endsWith("COMMIT TRANSACTION;")).toBe(true);
  });

  test("a per-call context overrides the clone's database", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map((line) => ok(line)),
    );
    const client = betterSchemic(conn, { schema });
    const tenant = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenant.users.findMany({ context: { database: "analytics" } });
    expect(calls[0]?.sql).toContain("USE NS tenant_a DB analytics;");
  });
});
