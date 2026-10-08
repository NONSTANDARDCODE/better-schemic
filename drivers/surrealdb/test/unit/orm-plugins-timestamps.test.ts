// M6.4 — the official `timestamps` plugin: `app` mode stamps time::now() on create/update and
// `database` mode strips the managed columns. Offline (expressions splice into the statement text).
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { createOnly, createOnlyGuard } from "../../src/plugins/create-only";
import { tenant } from "../../src/plugins/tenant";
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

  test("upsertDelta: updatedAt rides the delta on update and create has none", async () => {
    const before = {
      id: new RecordId("user", 1),
      name: "A",
      createdAt: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
      updatedAt: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
    };
    const after = {
      ...before,
      name: "B",
      updatedAt: new DateTime(new Date("2021-01-01T00:00:00.000Z")),
    };
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(line.startsWith("IF ") ? [{ before, after }] : null),
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [timestamps()],
    });
    const result = await client.users.upsertDelta({
      where: { id: "user:1" },
      data: { name: "B" },
      onMissing: "create",
    });
    expect(result.created).toBe(false);
    expect(result.changed).toEqual(["name", "updatedAt"]);
    expect(result.delta?.new.updatedAt).toBeInstanceOf(Date);
    expect(calls[0]?.sql).toContain("updatedAt: time::now()");
    expect(calls[0]?.sql).not.toContain("createdAt: time::now()");

    const fresh = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(line.startsWith("IF ") ? [{ after: after }] : null),
      ),
    );
    const createClient = betterSchemic(fresh.conn, {
      schema,
      plugins: [timestamps()],
    });
    const created = await createClient.users.upsertDelta({
      data: { id: "user:1", name: "A" },
      onMissing: "create",
    });
    expect(created.created).toBe(true);
    expect(created.delta).toBeNull();
    // `upsertDelta` is update-family: timestamps stamps `updatedAt` on both branches (like upsert).
    expect(fresh.calls[0]?.sql).toContain("updatedAt: time::now()");
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

// --- create-only interop: the marker suppresses `updatedAt`, order-independently ----------------

const Principal = defineTable("principal", { name: s.string() });
const CreateOnlyLog = defineTable("co_log", {
  name: s.string(),
  createdAt: s.datetime().optional(),
}).use(createOnly());
const TenantLog = defineTable("t_log", {
  name: s.string(),
  createdAt: s.datetime().optional(),
}).use(tenant(Principal, { createOnly: true }));
const coSchema = defineSchema({ logs: CreateOnlyLog, tenantLogs: TenantLog });

const coClient = (plugins: Parameters<typeof betterSchemic>[1]["plugins"]) => {
  const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])));
  return { client: betterSchemic(conn, { schema: coSchema, plugins }), calls };
};

describe("timestamps — create-only interop", () => {
  test("create stamps createdAt only — never updatedAt", async () => {
    const { client, calls } = coClient([timestamps()]);
    await client.logs.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("createdAt: time::now()");
    expect(calls[0]?.sql).not.toContain("updatedAt");
  });

  test("a bypassed update (no guard) stamps nothing — the column does not exist", async () => {
    const { client, calls } = coClient([timestamps()]);
    await client.logs.update({
      where: { id: "co_log:1" },
      data: { name: "B" },
    });
    expect(calls[0]?.sql).toContain("UPDATE");
    expect(calls[0]?.sql).not.toContain("time::now()");
  });

  test("a custom updatedAt column is skipped too", async () => {
    const { client, calls } = coClient([
      timestamps({ updatedAt: "modificadoEm" }),
    ]);
    await client.logs.create({ data: { name: "A" } });
    expect(calls[0]?.sql).not.toContain("modificadoEm");
    expect(calls[0]?.sql).not.toContain("updatedAt");
  });

  test("tenant(…, { createOnly: true }) tables use the canonical marker", async () => {
    const { client, calls } = coClient([timestamps()]);
    await client.tenantLogs.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("createdAt: time::now()");
    expect(calls[0]?.sql).not.toContain("updatedAt");
  });

  test("order-independent: a guard registered BEFORE timestamps changes nothing", async () => {
    const { client, calls } = coClient([createOnlyGuard(), timestamps()]);
    await client.logs.create({ data: { name: "A" } });
    expect(calls[0]?.sql).toContain("createdAt: time::now()");
    expect(calls[0]?.sql).not.toContain("updatedAt");
  });
});
