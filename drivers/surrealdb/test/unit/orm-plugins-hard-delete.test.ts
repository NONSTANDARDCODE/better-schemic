// M17 — the `hard-delete` plugin: `delete` stays a PHYSICAL delete, the destructive intent is
// explicit in the bootstrap and travels on the operation (hooks + query log). Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { definePlugin } from "../../src/orm/plugins";
import { hardDelete } from "../../src/plugins/hard-delete";
import { softDelete } from "../../src/plugins/soft-delete";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const SessionKey = defineTable("session_key", {
  signal: s.string(),
  payload: s.string(),
});
const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ keys: SessionKey, users: User });

const clientOver = (
  plugins: Parameters<typeof betterSchemic>[1]["plugins"],
  row: Record<string, unknown> = {
    id: new RecordId("session_key", 1),
    signal: "s",
    payload: "p",
  },
) => {
  const { conn, calls } = fakeConn((sql) =>
    lines(sql).map(() =>
      ok(
        sql.includes("session_key")
          ? row
          : { id: new RecordId("user", 1), name: "A", deletedAt: "2025-01-01" },
      ),
    ),
  );
  return { client: betterSchemic(conn, { schema, plugins }), calls };
};

describe("hard-delete — writes", () => {
  test("delete stays a physical DELETE", async () => {
    const { client, calls } = clientOver([hardDelete()]);
    await client.keys.delete({ where: { id: "session_key:1" } });
    expect(calls[0]?.sql).toBe("DELETE session_key:1 RETURN BEFORE;");
  });

  test("deleteMany without a where keeps its all:true guard", async () => {
    const { client, calls } = clientOver([hardDelete()]);
    await client.keys.deleteMany({ all: true, return: "none" });
    expect(calls[0]?.sql).toBe("DELETE session_key RETURN NONE;");
  });

  test("the destructive intent travels on the operation (hooks/log see it)", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = clientOver([
      hardDelete({ reason: "machine state is rewritten every message" }),
      definePlugin({
        id: "spy",
        transform(op) {
          if (op.kind === "delete" || op.kind === "deleteMany")
            seen.push({ ...(op.meta ?? {}) });
        },
      }),
    ]);
    await client.keys.delete({ where: { id: "session_key:1" } });
    expect(seen[0]).toEqual({
      hardDelete: true,
      hardDeleteReason: "machine state is rewritten every message",
    });
  });

  test("a scoped plugin only marks its own tables", async () => {
    const seen: string[] = [];
    const { client } = clientOver([
      hardDelete({ tables: ["session_key"] }),
      definePlugin({
        id: "spy2",
        transform(op) {
          if (op.meta?.hardDelete === true) seen.push(op.table);
        },
      }),
    ]);
    await client.users.delete({ where: { id: "user:1" } });
    expect(seen).toEqual([]);
    await client.keys.delete({ where: { id: "session_key:1" } });
    expect(seen).toEqual(["session_key"]);
  });

  test("an unscoped plugin marks every table; a non-delete op is untouched", async () => {
    const seen: (string | undefined)[] = [];
    const { client } = clientOver([
      hardDelete(),
      definePlugin({
        id: "spy3",
        transform(op) {
          if (op.meta?.hardDelete === true) seen.push(op.table);
        },
      }),
    ]);
    await client.keys.findMany({});
    await client.users.update({ where: { id: "user:1" }, data: {} });
    await client.keys.delete({ where: { id: "session_key:1" } });
    await client.keys.deleteMany({ where: { signal: "s" }, return: "none" });
    // Only the two deletes carry the marker — a read and an update do not.
    expect(seen).toEqual(["session_key", "session_key"]);
  });

  test("reads are untouched — there is no tombstone to hide", async () => {
    const { client, calls } = clientOver([hardDelete()]);
    await client.keys.findMany({});
    expect(calls[0]?.sql).toBe("SELECT * FROM session_key;");
  });
});

describe("hard-delete — composition", () => {
  test("scoped plugins compose: a tombstoned table and a physically-deleted one", async () => {
    // The mixed schema: `user` rows are recoverable (soft-delete), `session_key` rows are machine
    // state that is rewritten every message (hard-delete). Both plugins are scoped, so neither
    // touches the other's tables.
    const { client, calls } = clientOver([
      softDelete({ tables: ["user"] }),
      hardDelete({ tables: ["session_key"] }),
    ]);
    await client.users.delete({ where: { id: "user:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
    await client.keys.delete({ where: { id: "session_key:1" } });
    expect(calls[1]?.sql).toContain("DELETE session_key:1");
  });

  test("an unscoped soft-delete wins over hard-delete (it re-dispatches first)", async () => {
    const { client, calls } = clientOver([softDelete(), hardDelete()]);
    await client.keys.delete({ where: { id: "session_key:1" } });
    expect(calls[0]?.sql).toContain("UPDATE");
  });
});

describe("hard-delete — the reason/meta arms", () => {
  const key = defineTable("hd_key", { signal: s.string() });
  const schema = defineSchema({ keys: key });
  const clientOver = (
    plugins: Parameters<typeof betterSchemic>[1]["plugins"],
    seen: Record<string, unknown>[] = [],
  ) => {
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map(() =>
        ok([{ id: new RecordId("hd_key", 1), signal: "s" }]),
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [
        ...(plugins ?? []),
        definePlugin({
          id: "spy-meta",
          transform(op) {
            if (op.kind === "delete") seen.push({ ...(op.meta ?? {}) });
          },
        }),
      ],
    });
    return { client, calls };
  };

  test("existing meta on the call is preserved, the marker is added", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = clientOver([hardDelete()], seen);
    await client.keys.delete({ where: { id: "hd_key:1" }, meta: { actor: "u1" } });
    expect(seen[0]).toEqual({ actor: "u1", hardDelete: true });
  });

  test("a reason is carried alongside the marker", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = clientOver(
      [hardDelete({ reason: "rewritten every message" })],
      seen,
    );
    await client.keys.delete({ where: { id: "hd_key:1" } });
    expect(seen[0]).toEqual({
      hardDelete: true,
      hardDeleteReason: "rewritten every message",
    });
  });

  test("a table outside the scope is not marked, and a non-delete op never is", async () => {
    const seen: Record<string, unknown>[] = [];
    const { client } = clientOver([hardDelete({ tables: ["other"] })], seen);
    await client.keys.delete({ where: { id: "hd_key:1" } });
    expect(seen[0]).toEqual({});
  });
});
