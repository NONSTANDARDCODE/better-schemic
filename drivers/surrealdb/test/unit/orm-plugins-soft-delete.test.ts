// M6.4 — the official `soft-delete` plugin: delete -> update, read filtering with `deleted:`, the
// `deletedBy` actor and the `restore`/`restoreById` model methods. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { softDelete } from "../../src/plugins/soft-delete";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
  deletedBy: s.string().optional(),
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

describe("soft-delete — writes", () => {
  test("delete compiles as UPDATE stamping the column", async () => {
    const { client, calls } = clientOver([softDelete()]);
    await client.users.delete({ where: { id: "user:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).not.toContain("DELETE");
    expect(calls[0]?.sql).toContain("deletedAt: time::now()");
  });

  test("deleteMany stamps every matching row", async () => {
    const { client, calls } = clientOver([softDelete()]);
    await client.users.deleteMany({ where: { name: "A" }, return: "none" });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).toContain("deletedAt: time::now()");
  });

  test("deletedBy stamps the actor from meta", async () => {
    const { client, calls } = clientOver([
      softDelete({ deletedBy: "deletedBy", actorMeta: "actor" }),
    ]);
    await client.users.delete({
      where: { id: "user:1" },
      meta: { actor: "user:9" },
    });
    expect(calls[0]?.sql).toContain("deletedBy: $b0");
    expect(calls[0]?.vars?.b0).toBe("user:9");
  });

  test("no actor in meta means no deletedBy field", async () => {
    const { client, calls } = clientOver([
      softDelete({ deletedBy: "deletedBy" }),
    ]);
    await client.users.delete({ where: { id: "user:1" } });
    expect(calls[0]?.sql).not.toContain("deletedBy");
  });
});

describe("soft-delete — read filtering", () => {
  test("default reads filter deletedAt IS NONE", async () => {
    const { client, calls } = clientOver([softDelete()]);
    await client.users.findMany({});
    expect(calls[0]?.sql).toContain("deletedAt = NONE");
    expect(calls[0]?.sql).toContain("FROM user");
  });

  test('deleted: "with" disables the filter', async () => {
    const { client, calls } = clientOver([softDelete()]);
    await client.users.findMany({ deleted: "with" });
    expect(calls[0]?.sql).not.toContain("deletedAt");
  });

  test('deleted: "only" filters deletedAt IS NOT NONE', async () => {
    const { client, calls } = clientOver([softDelete()]);
    await client.users.findMany({ deleted: "only" });
    expect(calls[0]?.sql).toContain("deletedAt != NONE");
  });
});

describe("soft-delete — restore", () => {
  test("restore clears the column by filter", async () => {
    const { client, calls } = clientOver([softDelete()]);
    const model = client.users as unknown as {
      restore(args: { where: unknown }): Promise<unknown>;
    };
    await model.restore({ where: { id: "user:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).toContain("UNSET deletedAt");
  });

  test("restoreById targets the record", async () => {
    const { client, calls } = clientOver([softDelete()]);
    const model = client.users as unknown as {
      restoreById(id: unknown): Promise<unknown>;
    };
    await model.restoreById("user:1");
    expect(calls[0]?.sql).toContain("UPDATE user:1");
    expect(calls[0]?.sql).toContain("UNSET deletedAt");
  });
});
