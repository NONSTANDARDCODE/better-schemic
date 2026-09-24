// M6.4 — the official `timestamps` plugin: `app` mode stamps time::now() on create/update and
// `database` mode strips the managed columns. Offline (expressions splice into the statement text).
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { timestamps } from "../../src/plugins/timestamps";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", {
  name: s.string(),
  createdAt: s.datetime().optional(),
  updatedAt: s.datetime().optional(),
});
const schema = defineSchema({ users: User });

const clientOver = (
  plugins: Parameters<typeof betterSchemic>[1]["plugins"],
) => {
  const { conn, calls } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  );
  return { client: betterSchemic(conn, { schema, plugins }), calls };
};

describe("timestamps — app mode", () => {
  test("create stamps both columns with time::now()", async () => {
    const { client, calls } = clientOver([timestamps()]);
    await client.users.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("createdAt: time::now()");
    expect(calls[0]?.sql).toContain("updatedAt: time::now()");
  });

  test("update stamps only updatedAt", async () => {
    const { client, calls } = clientOver([timestamps()]);
    await client.users.update({
      where: { id: "user:1" },
      mode: "merge",
      data: { name: "B" },
    });
    expect(calls[0]?.sql).toContain("updatedAt: time::now()");
    expect(calls[0]?.sql).not.toContain("createdAt");
  });

  test("honors custom column names", async () => {
    const { client, calls } = clientOver([
      timestamps({ createdAt: "criadoEm", updatedAt: "atualizadoEm" }),
    ]);
    await client.users.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("criadoEm: time::now()");
    expect(calls[0]?.sql).toContain("atualizadoEm: time::now()");
  });
});

describe("timestamps — database mode", () => {
  test("strips the managed columns instead of stamping", async () => {
    const { client, calls } = clientOver([timestamps({ mode: "database" })]);
    await client.users.create({ data: { name: "A" } });
    expect(calls[0]?.sql).not.toContain("createdAt");
    expect(calls[0]?.sql).not.toContain("updatedAt");
  });
});
