// M4.3 — the changefeed runtime (`SHOW CHANGES`) over a recording fake: compilation (SINCE
// literal/LIMIT/table resolution), normalization of the server shapes and per-table decode.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import {
  compileChanges,
  normalizeChangeSets,
  sinceLiteral,
} from "../../src/orm/changes";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { caught, lines, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

/** A fake conn that answers SHOW CHANGES with `raw`. */
function fakeConn(raw: unknown) {
  const calls: { sql: string; vars?: Record<string, unknown> }[] = [];
  return {
    calls,
    query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return { responses: async () => lines(sql).map(() => ok(raw)) };
    },
  };
}

const codeOf = (e: unknown): string | undefined =>
  isBetterSchemicError(e) ? e.code : undefined;
describe("changes — compilation", () => {
  const index = betterSchemic(fakeConn([]) as never, { schema }).$index;

  test("SHOW CHANGES FOR TABLE (schema key or physical) and FOR DATABASE", () => {
    expect(compileChanges(index, { table: "users", since: 0 })).toBe(
      "SHOW CHANGES FOR TABLE user SINCE 0",
    );
    expect(compileChanges(index, { table: "user", since: 10 })).toBe(
      "SHOW CHANGES FOR TABLE user SINCE 10",
    );
    expect(compileChanges(index, { table: "other", since: 0n, limit: 5 })).toBe(
      "SHOW CHANGES FOR TABLE other SINCE 0 LIMIT 5",
    );
    expect(compileChanges(index, undefined)).toBe(
      "SHOW CHANGES FOR DATABASE SINCE 0",
    );
  });

  test("since accepts versionstamps and ISO dates (literal only)", () => {
    expect(sinceLiteral(undefined)).toBe("0");
    expect(sinceLiteral(42)).toBe("42");
    expect(sinceLiteral(42n)).toBe("42");
    expect(sinceLiteral(new Date("2025-06-01T00:00:00.000Z"))).toBe(
      "d'2025-06-01T00:00:00.000Z'",
    );
    expect(sinceLiteral("2025-06-01T00:00:00Z")).toBe(
      "d'2025-06-01T00:00:00Z'",
    );
    for (const bad of [-1, -1n, new Date(Number.NaN), "yesterday", {}]) {
      expect(() => sinceLiteral(bad as never)).toThrow();
    }
  });

  test("invalid args fail fast", () => {
    for (const args of [
      { since: -1 },
      { since: "nope" },
      { table: "" },
      { limit: 0 },
      { limit: 1.5 },
      { orderBy: "x" },
    ]) {
      expect(() => compileChanges(index, args as never)).toThrow();
    }
  });
});

describe("changes — normalization", () => {
  const index = betterSchemic(fakeConn([]) as never, { schema }).$index;

  test("update / update-with-original / delete / define_table become typed entries", () => {
    const id = new RecordId("user", "u1");
    const sets = normalizeChangeSets(
      [
        {
          versionstamp: 10n,
          changes: [{ define_table: { name: "user" } }],
        },
        {
          versionstamp: 11n,
          changes: [{ update: { id, name: "A" } }],
        },
        {
          versionstamp: 12n,
          changes: [
            {
              current: { id, name: "B" },
              update: [{ op: "change", path: "/name", value: "x" }],
            },
          ],
        },
        {
          versionstamp: 13n,
          changes: [{ delete: { id, original: { id, name: "B" } } }],
        },
        {
          versionstamp: 14n,
          changes: [{ delete: { id } }],
        },
      ],
      index,
    );
    expect(sets.map((s) => s.versionstamp)).toEqual([10n, 11n, 12n, 13n, 14n]);
    expect(sets[0]?.changes[0]).toEqual({
      action: "DEFINE",
      definition: { name: "user" },
    });
    expect(sets[1]?.changes[0]).toMatchObject({
      action: "UPDATE",
      recordId: id,
      value: { id, name: "A" },
    });
    expect(sets[2]?.changes[0]).toMatchObject({
      action: "UPDATE",
      recordId: id,
      value: { id, name: "B" },
      diff: [{ op: "change", path: "/name", value: "x" }],
    });
    expect(sets[3]?.changes[0]).toMatchObject({
      action: "DELETE",
      recordId: id,
      before: { id, name: "B" },
    });
    expect(sets[4]?.changes[0]).toMatchObject({
      action: "DELETE",
      recordId: id,
    });
    expect(sets[4]?.changes[0]).not.toHaveProperty("before");
  });

  test("changes() compiles the call and decodes through the table codec", async () => {
    const id = new RecordId("user", "u1");
    const conn = fakeConn([
      { versionstamp: 7n, changes: [{ update: { id, name: "A" } }] },
    ]);
    const client = betterSchemic(conn as never, { schema });
    const out = await client.changes({ table: "users", since: 0, limit: 10 });
    expect(conn.calls[0]?.sql).toBe(
      "SHOW CHANGES FOR TABLE user SINCE 0 LIMIT 10;",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.versionstamp).toBe(7n);
    expect(out[0]?.changes[0]).toMatchObject({
      action: "UPDATE",
      value: { id, name: "A" },
    });
  });

  test("database-level changes decode each record by its own table", async () => {
    const userId = new RecordId("user", "u1");
    const otherId = new RecordId("unknown_table", "x");
    const conn = fakeConn([
      {
        versionstamp: 1n,
        changes: [
          { update: { id: userId, name: "A" } },
          { update: { id: otherId, free: true } },
        ],
      },
    ]);
    const client = betterSchemic(conn as never, { schema });
    const out = await client.changes();
    expect(conn.calls[0]?.sql).toBe("SHOW CHANGES FOR DATABASE SINCE 0;");
    expect(out[0]?.changes[0]).toMatchObject({ value: { name: "A" } });
    expect(out[0]?.changes[1]).toMatchObject({
      value: { id: otherId, free: true },
    });
  });

  test("garbage responses normalize to an empty list (never throw)", async () => {
    const client = betterSchemic(fakeConn("nope") as never, { schema });
    expect(await client.changes()).toEqual([]);
  });

  test("client.changes validates since/limit eagerly", async () => {
    const client = betterSchemic(fakeConn([]) as never, { schema });
    expect(codeOf(await caught(() => client.changes({ since: -1 })))).toBe(
      "ValidationError",
    );
    expect(codeOf(await caught(() => client.changes({ limit: 0 })))).toBe(
      "ValidationError",
    );
  });
});
