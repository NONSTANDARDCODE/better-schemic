// M6.3 — the `rules` guardrail plugin: noRawUnsafe, destructive-write-without-where, requireLimit,
// maxLimit, cursor orderBy and strict fields. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { orm } from "../../../src/surreal/orm/client";
import { schema } from "../../../src/surreal/orm/schema";
import {
  recommended,
  rules,
  safe,
  strict,
} from "../../../src/surreal/plugins/rules";
import { s, table } from "../../../src/surreal/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = table("user", { name: s.string() });
const schemaDef = schema({ users: User });

const clientWith = (plugins: Parameters<typeof orm>[1]["plugins"]) => {
  const { conn } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  );
  return orm(conn, { schema: schemaDef, plugins });
};

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe("rules — write/limit guardrails", () => {
  test("destructiveWriteWithoutWhere blocks updateMany/deleteMany without a filter", async () => {
    const client = clientWith([safe()]);
    expect(await codeOf(() => client.users.deleteMany({}))).toBe(
      "UnsafeMutation",
    );
    expect(
      await codeOf(() => client.users.updateMany({ data: { name: "x" } })),
    ).toBe("UnsafeMutation");
    expect(
      await codeOf(() => client.users.deleteMany({ where: { name: "A" } })),
    ).toBeUndefined();
    expect(
      await codeOf(() => client.users.deleteMany({ all: true })),
    ).toBeUndefined();
  });

  test("requireLimit + maxLimit bound findMany", async () => {
    const client = clientWith([recommended({ maxLimit: 50 })]);
    expect(await codeOf(() => client.users.findMany({}))).toBe(
      "UnsafeMutation",
    );
    expect(await codeOf(() => client.users.findMany({ limit: 100 }))).toBe(
      "UnsafeMutation",
    );
    expect(
      await codeOf(() => client.users.findMany({ limit: 10 })),
    ).toBeUndefined();
  });

  test("requireOrderByForCursor requires an explicit orderBy", async () => {
    const client = clientWith([strict()]);
    expect(await codeOf(() => client.users.cursor({ limit: 10 }))).toBe(
      "UnsafeMutation",
    );
    expect(
      await codeOf(() =>
        client.users.cursor({ orderBy: [{ id: "asc" }], limit: 10 }),
      ),
    ).toBeUndefined();
  });

  test("strict rejects unknown fields in data/where", async () => {
    const client = clientWith([rules({ strict: true })]);
    expect(
      await codeOf(() => client.users.create({ data: { nope: 1 } as never })),
    ).toBe("UnknownField");
    expect(
      await codeOf(() =>
        client.users.findMany({ where: { nope: 1 } as never }),
      ),
    ).toBe("UnknownField");
    expect(
      await codeOf(() => client.users.create({ data: { name: "A" } })),
    ).toBeUndefined();
  });
});

describe("rules — raw guardrail", () => {
  test("noRawUnsafe blocks $unsafe but leaves $raw available", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(null)));
    const client = orm(conn, {
      schema: schemaDef,
      plugins: [safe()],
      raw: { unsafe: true },
    });
    expect(await codeOf(() => client.$unsafe("SELECT 1"))).toBe(
      "UnsafeMutation",
    );
    expect(await codeOf(() => client.$raw`SELECT 1`)).toBeUndefined();
  });
});
