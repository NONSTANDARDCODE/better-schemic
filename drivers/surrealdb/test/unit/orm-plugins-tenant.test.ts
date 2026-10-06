// `tenantRls()` runtime plugin — fail-closed client-side tenant scoping for PRIVILEGED sessions:
// scope injection on reads/writes, `$forTenant` delegate state, divergent payload/where rejection,
// the ON DUPLICATE / unique-target guards and the bootstrap validation. Offline (fake conn).
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { defineTable, s, surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { isTenantViolation } from "../../src/orm/errors";
import { createPluginPipeline, RuntimeOperation } from "../../src/orm/plugins";
import { buildSchemaIndex, defineSchema } from "../../src/orm/schema";
import type { Plugin } from "../../src/orm/types/plugins";
import { softDelete } from "../../src/plugins/soft-delete";
import { tenant, tenantRls } from "../../src/plugins/tenant";
import { timestamps } from "../../src/plugins/timestamps";
import { caught, fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const Customer = defineTable("customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
})
  .use(tenant(User, { softDelete: true }))
  .index("customer_name_uq", ["name"], { unique: true });
const Order = defineTable("order", { total: s.number() }).use(
  tenant(User, { createOnly: true }),
);
const Plain = defineTable("plain", {
  name: s.string(),
  tenant_id: User.record().optional(),
});
const schema = defineSchema({
  users: User,
  customers: Customer,
  orders: Order,
  plains: Plain,
  audit: "raw_audit",
});

const CUSTOMER = {
  id: new RecordId("customer", "1"),
  name: "A",
  tenant_id: new RecordId("user", "abc"),
};
const ORDER = {
  id: new RecordId("order", "1"),
  total: 1,
  tenant_id: new RecordId("user", "abc"),
};
const PLAIN = { id: new RecordId("plain", "1"), name: "A" };

function clientOver<const P extends readonly Plugin[]>(plugins: P) {
  const { conn, calls } = fakeConn((sql) =>
    lines(sql).map(() =>
      ok(
        sql.includes("count()")
          ? [{ count: 1 }]
          : sql.includes("plain")
            ? [PLAIN]
            : sql.includes("order")
              ? [ORDER]
              : [CUSTOMER],
      ),
    ),
  );
  return { client: betterSchemic(conn, { schema, plugins }), calls };
}

const scoped = (opts: { tenant?: string | (() => string) } = {}) =>
  clientOver([tenantRls({ tenant: opts.tenant ?? "user:abc" })]);

const binds = (call: { vars?: Record<string, unknown> }) =>
  Object.values(call.vars ?? {});

/** The object payload bind(s) — one per row for the batched per-item lowerings. */
const payloadBinds = (call: { vars?: Record<string, unknown> }) =>
  binds(call).filter(
    (v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v) && "name" in v,
  );

/** The object payload bind (`{ name, tenant_id }`). */
const payloadBind = (call: { vars?: Record<string, unknown> }) =>
  payloadBinds(call)[0];

/** Every scope bind (`RecordId` of the principal) — one per row in inlined batches. */
const scopeBinds = (call: { vars?: Record<string, unknown> }) =>
  binds(call).filter(
    (v): v is RecordId => v instanceof RecordId && v.table.name === "user",
  );

/** The scope bind (`RecordId` of the principal). */
const scopeBind = (call: { vars?: Record<string, unknown> }) =>
  scopeBinds(call)[0];

describe("tenantRls — fail-closed scope", () => {
  test("a tagged table with no scope throws TenantRequired before compiling", async () => {
    const { client, calls } = clientOver([tenantRls()]);
    const error = await caught(() => client.customers.findMany({}));
    expect(isTenantViolation(error)).toBe(true);
    expect((error as Error).message).toContain('"customer"');
    expect((error as Error).message).toContain('"tenant_id"');
    expect((error as Error).message).toContain("$forTenant");
    expect((error as Error).message).toContain('operation "findMany"');
    expect(calls).toHaveLength(0);
  });

  test("every scoped operation kind requires a scope (read/create/update/delete)", async () => {
    const { client } = clientOver([tenantRls()]);
    const ops = [
      () => client.customers.findMany({}),
      () => client.customers.findUnique({ where: { id: "customer:1" } }),
      () => client.customers.count({}),
      () => client.customers.create({ data: { name: "A" } }),
      () => client.customers.update({ where: { id: "customer:1" } }),
      () => client.customers.delete({ where: { id: "customer:1" } }),
      () =>
        client.orders.upsert({ where: { id: "order:1" }, data: { total: 1 } }),
    ];
    for (const op of ops) {
      const error = await caught(op);
      expect(isTenantViolation(error)).toBe(true);
    }
  });

  test("$forTenant overrides the configured resolver; the original delegate keeps the config", async () => {
    const { client, calls } = scoped();
    await client.customers.$forTenant("user:xyz").findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:xyz");
    calls.length = 0;
    await client.customers.findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:abc");
  });

  test("the configured resolver is evaluated per operation", async () => {
    let current = "user:one";
    const { client, calls } = clientOver([
      tenantRls({ tenant: () => current }),
    ]);
    await client.customers.findMany({});
    current = "user:two";
    await client.customers.findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:one");
    expect(String(scopeBind(calls[1]!))).toBe("user:two");
  });

  test("a bare tenant id joins the preset's principal", async () => {
    const { client, calls } = scoped();
    await client.customers.$forTenant("abc").findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:abc");
  });

  test("a scope from another principal is rejected", async () => {
    const { client } = scoped();
    const error = await caught(() =>
      client.customers.$forTenant("other:1").findMany({}),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect((error as Error).message).toContain("principal");
  });

  test("untagged tables pass through untouched (no scope required, no rewrite)", async () => {
    const { client, calls } = clientOver([tenantRls()]);
    await client.plains.findMany({});
    expect(calls[0]?.sql).not.toContain("tenant_id");
  });

  test("$withoutPlugins bypasses the scope entirely (documented admin escape)", async () => {
    const { client, calls } = clientOver([tenantRls()]);
    await client.customers.$withoutPlugins().findMany({});
    expect(calls[0]?.sql).not.toContain("tenant_id");
  });
});

describe("tenantRls — reads", () => {
  test("findMany ANDs the scope into the caller's where", async () => {
    const { client, calls } = scoped();
    await client.customers.findMany({ where: { name: "A" } });
    expect(calls[0]?.sql).toContain("name = ");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("every read kind scopes (findFirst/findOne/count/exists/aggregate/paginate/cursor)", async () => {
    const { client, calls } = scoped();
    const reads = [
      client.customers.findFirst({}),
      client.customers.findOne({}),
      client.customers.count({}),
      client.customers.exists({}),
      client.customers.aggregate({ select: { _count: true } }),
      client.customers.paginate({ limit: 1 }),
      client.customers.cursor({ limit: 1, orderBy: [{ id: "asc" }] }),
    ];
    for (const read of reads) {
      await read.explain();
    }
    expect(calls.length).toBeGreaterThanOrEqual(reads.length);
    for (const call of calls)
      if (call.sql.startsWith("EXPLAIN"))
        expect(call.sql).toContain("tenant_id = ");
  });

  test("a fragment where is wrapped so the scope still ANDs", async () => {
    const { client, calls } = scoped();
    await client.customers.findMany({ where: surql`name = "A"` });
    expect(calls[0]?.sql).toContain('name = "A"');
    expect(calls[0]?.sql).toContain("tenant_id = ");
    expect(calls[0]?.sql).toContain(" AND ");
  });

  test("an equal manual tenant filter is accepted without duplication", async () => {
    const { client, calls } = scoped();
    await client.customers.findMany({ where: { tenant_id: "user:abc" } });
    expect(calls[0]?.sql.match(/tenant_id/g)).toHaveLength(1);
  });

  test("a divergent manual tenant filter throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.findMany({ where: { tenant_id: "user:other" } }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect((error as Error).message).toContain("$forTenant");
    expect(calls).toHaveLength(0);
  });

  test("findUnique scopes BOTH the id target and the unique-field target", async () => {
    const { client, calls } = scoped();
    await client.customers.findUnique({ where: { id: "customer:1" } });
    expect(calls[0]?.sql).toContain("FROM ONLY customer:1");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
    calls.length = 0;
    await client.customers.findUnique({ where: { name: "A" } });
    expect(calls[0]?.sql).toContain("name = ");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });
});

describe("tenantRls — creates and upserts", () => {
  test("create injects the scoped RecordId into the payload", async () => {
    const { client, calls } = scoped();
    await client.customers.create({ data: { name: "A" } });
    const payload = payloadBind(calls[0]!)!;
    expect(payload).toMatchObject({ name: "A" });
    expect(payload.tenant_id).toBeInstanceOf(RecordId);
    expect(String(payload.tenant_id)).toBe("user:abc");
  });

  test("createMany / insertMany inject every array item", async () => {
    const { client, calls } = scoped();
    await client.customers.createMany({
      data: [{ name: "A" }, { name: "B" }],
    });
    const payload = payloadBinds(calls[0]!);
    expect(String(payload[0]?.tenant_id)).toBe("user:abc");
    expect(String(payload[1]?.tenant_id)).toBe("user:abc");
    calls.length = 0;
    await client.customers.insertMany({
      data: [{ name: "C" }, { name: "D" }],
    });
    const inserted = scopeBinds(calls[0]!);
    expect(inserted.map(String)).toEqual(["user:abc", "user:abc"]);
  });

  test("a divergent create payload throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.create({
        // A JS/raw caller bypassing the typed create input (which excludes the readonly column).
        data: { name: "A", tenant_id: "user:other" as never },
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("insert onDuplicate can update another tenant's row — rejected", async () => {
    const { client, calls } = scoped();
    for (const onDuplicate of ["update", { name: "X" }] as const) {
      const error = await caught(() =>
        client.customers.insert({
          data: { id: "customer:1", name: "A" },
          onDuplicate,
        }),
      );
      expect(isTenantViolation(error)).toBe(true);
      expect((error as Error).message).toContain("ON DUPLICATE");
    }
    expect(calls).toHaveLength(0);
  });

  test("insert with onDuplicate: 'ignore' is safe and scoped", async () => {
    const { client, calls } = scoped();
    await client.customers.insert({
      data: { id: "customer:1", name: "A" },
      onDuplicate: "ignore",
    });
    const payload = payloadBind(calls[0]!)!;
    expect(String(payload.tenant_id)).toBe("user:abc");
  });

  test("upsert injects the payload and scopes the resolved target", async () => {
    const { client, calls } = scoped();
    await client.customers.upsert({
      where: { id: "customer:1" },
      data: { name: "A" },
      onMissing: "create",
    });
    expect(calls[0]?.sql).toContain("UPSERT");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
    const payload = payloadBind(calls[0]!)!;
    expect(String(payload.tenant_id)).toBe("user:abc");
  });

  test("upsertDelta injects, scopes and decodes the envelope", async () => {
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(
          line.startsWith("UPSERT") ||
            line.startsWith("CREATE") ||
            line.startsWith("IF ")
            ? [{ before: CUSTOMER, after: { ...CUSTOMER, name: "B" } }]
            : null,
        ),
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [tenantRls({ tenant: "user:abc" })],
    });
    const result = await client.customers.upsertDelta({
      where: { id: "customer:1" },
      data: { name: "B" },
      onMissing: "create",
    });
    expect(result.created).toBe(false);
    expect(result.changed).toEqual(["name"]);
    expect(calls[0]?.sql).toContain("UPSERT");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
    expect(String(payloadBind(calls[0]!)?.tenant_id)).toBe("user:abc");
  });

  test("upsertDelta target-less create injects the tenant", async () => {
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(line.startsWith("CREATE") ? [{ after: CUSTOMER }] : null),
      ),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [tenantRls({ tenant: "user:abc" })],
    });
    const result = await client.customers.upsertDelta({ data: { name: "A" } });
    expect(result.created).toBe(true);
    expect(String(payloadBind(calls[0]!)?.tenant_id)).toBe("user:abc");
  });

  test("upsertDelta strict rejects a cross-tenant id instead of creating", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(null)));
    const client = betterSchemic(conn, {
      schema,
      plugins: [tenantRls({ tenant: "user:abc" })],
    });
    const error = await caught(() =>
      client.customers.upsertDelta({
        where: { id: "customer:other" },
        data: { name: "B" },
        onMissing: "throw",
      }),
    );
    expect((error as { code?: string }).code).toBe("ResultNotFound");
    expect(calls[0]?.sql).toContain("UPDATE ONLY customer:other");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
    expect(calls[0]?.sql).not.toContain("UPSERT");
    expect(calls[0]?.sql).not.toContain("CREATE");
  });

  test("upsertMany by conflict injects each row and scopes the per-item WHERE", async () => {
    const { client, calls } = scoped();
    await client.customers.upsertMany({
      data: [{ name: "A" }, { name: "B" }],
      conflict: "name",
    });
    const payload = payloadBinds(calls[0]!);
    expect(String(payload[0]?.tenant_id)).toBe("user:abc");
    expect(String(payload[1]?.tenant_id)).toBe("user:abc");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("upsertMany by ids uses INSERT … ON DUPLICATE with no WHERE — rejected", async () => {
    const { client } = scoped();
    const error = await caught(() =>
      client.customers.upsertMany({
        data: [{ id: "customer:1", name: "A" }],
      }),
    );
    expect(isTenantViolation(error)).toBe(false);
    expect((error as Error).message).toContain("ON DUPLICATE");
  });

  test("upsert with distinct create+update branches injects the create payload when expressions force LET/IF", async () => {
    const { client, calls } = scoped();
    await client.customers.upsert({
      where: { id: "customer:1" },
      create: { id: "customer:1", name: "A" },
      update: { name: surql`"B"` },
      onMissing: "create",
    });
    expect(calls[0]?.sql).toContain("LET");
    expect(calls[0]?.sql).toContain("tenant_id = ");
    const createBind = binds(calls[0]!).find(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        !(v instanceof RecordId) &&
        "id" in v,
    ) as Record<string, unknown>;
    expect(String(createBind.tenant_id)).toBe("user:abc");
  });

  test("a divergent tenant in upsert's create/update branches throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const inCreate = await caught(() =>
      client.customers.upsert({
        where: { id: "customer:1" },
        create: {
          id: "customer:1",
          name: "A",
          tenant_id: "user:other" as never,
        },
        update: { name: surql`"B"` },
      }),
    );
    expect(isTenantViolation(inCreate)).toBe(true);
    const inUpdate = await caught(() =>
      client.customers.upsert({
        where: { id: "customer:1" },
        create: { id: "customer:1", name: "A" },
        update: { name: "B", tenant_id: "user:other" as never },
      }),
    );
    expect(isTenantViolation(inUpdate)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("upsert with distinct create+update branches on an id is rejected (no scoped lowering)", async () => {
    const { client } = scoped();
    const error = await caught(() =>
      client.customers.upsert({
        where: { id: "customer:1" },
        create: { id: "customer:1", name: "A" },
        update: { name: "B" },
        onMissing: "create",
      }),
    );
    expect((error as Error).message).toContain("ON DUPLICATE");
  });
});

describe("tenantRls — updates and deletes", () => {
  test("update by id scopes the UPDATE with a WHERE (unique target untouched)", async () => {
    const { client, calls } = scoped();
    await client.customers.update({
      where: { id: "customer:1" },
      data: { name: "B" },
    });
    expect(calls[0]?.sql).toContain("UPDATE customer:1");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
  });

  test("update by a unique field ANDs the scope with the unique predicate", async () => {
    const { client, calls } = scoped();
    await client.customers.update({
      where: { name: "A" },
      data: { name: "B" },
    });
    expect(calls[0]?.sql).toContain("UPDATE customer");
    expect(calls[0]?.sql).toContain("name = ");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("a divergent update payload throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.update({
        where: { id: "customer:1" },
        data: { name: "B", tenant_id: "user:other" },
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("an equal tenant in an update payload passes (READONLY no-op)", async () => {
    const { client, calls } = scoped();
    await client.customers.update({
      where: { id: "customer:1" },
      data: { name: "B", tenant_id: "user:abc" },
    });
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
  });

  test("mode replace injects the scoped tenant (a READONLY field must be present)", async () => {
    const { client, calls } = scoped();
    await client.customers.update({
      where: { id: "customer:1" },
      data: { name: "B" },
      mode: "replace",
    });
    expect(calls[0]?.sql).toContain("REPLACE");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
    const payload = payloadBind(calls[0]!);
    expect(String(payload?.tenant_id)).toBe("user:abc");
  });

  test("a divergent tenant in a replace payload throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.update({
        where: { id: "customer:1" },
        data: { name: "B", tenant_id: "user:other" },
        mode: "replace",
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a divergent updateEach item throws TenantViolation", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.updateEach({
        data: [{ id: "customer:1", name: "B", tenant_id: "user:other" }],
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("patch scopes the statement", async () => {
    const { client, calls } = scoped();
    await client.customers.patch({
      where: { id: "customer:1" },
      patches: [{ op: "replace", path: "/name", value: "B" }],
    });
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
  });

  test("a patch touching the tenant column is rejected", async () => {
    const { client, calls } = scoped();
    const error = await caught(() =>
      client.customers.patch({
        where: { id: "customer:1" },
        patches: [{ op: "replace", path: "/tenant_id", value: "user:other" }],
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("updateMany scopes the WHERE", async () => {
    const { client, calls } = scoped();
    await client.customers.updateMany({
      data: { name: "B" },
      where: { name: "A" },
    });
    expect(calls[0]?.sql).toContain("WHERE");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("updateEach scopes every per-item statement", async () => {
    const { client, calls } = scoped();
    await client.customers.updateEach({
      data: [{ id: "customer:1", name: "B" }],
    });
    expect(calls[0]?.sql).toContain("WHERE");
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("delete by id scopes the DELETE", async () => {
    const { client, calls } = scoped();
    await client.customers.delete({ where: { id: "customer:1" } });
    expect(calls[0]?.sql).toContain("DELETE customer:1");
    expect(calls[0]?.sql).toContain("WHERE tenant_id = ");
  });

  test("deleteMany all:true becomes a scoped delete, not a table wipe", async () => {
    const { client, calls } = scoped();
    await client.customers.deleteMany({ all: true, return: "none" });
    const sql = calls.map((c) => c.sql).join("\n");
    expect(sql).toContain("DELETE FROM customer");
    expect(sql).toContain("tenant_id = ");
    expect(sql).not.toContain("DELETE customer;");
  });
});

describe("tenantRls — extras and setup validation", () => {
  test("configured `tables` treat untagged physical tables as scoped", async () => {
    const { client, calls } = clientOver([
      tenantRls({ tenant: "user:abc", tables: ["plain"] }),
    ]);
    await client.plains.findMany({});
    expect(calls[0]?.sql).toContain("tenant_id = ");
  });

  test("a `tables` entry outside the schema fails the bootstrap", () => {
    expect(() =>
      betterSchemic({} as never, {
        schema,
        plugins: [tenantRls({ tables: ["ghost"] })],
      }),
    ).toThrow(/ghost.*not in the schema/);
  });

  test("invalid config fails fast at the factory or the bootstrap", () => {
    expect(() => tenantRls({ column: "tenant id" })).toThrow(/identifier/);
    for (const bad of [42, ""] as const)
      expect(() => tenantRls({ tables: [bad as unknown as string] })).toThrow(
        /non-empty physical table name/,
      );
    expect(() =>
      betterSchemic({} as never, {
        schema,
        plugins: [tenantRls({ tenant: 42 as never })],
      }),
    ).toThrow(/record id, a string, or a \(\) => TenantRef/);
  });

  test("a malformed meta.tenant tag fails the bootstrap", () => {
    const Broken = defineTable("broken", { title: s.string() }).use(
      defineTable.preset({ meta: { tenant: {} } }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ broken: Broken }),
        plugins: [tenantRls()],
      }),
    ).toThrow(/malformed meta.tenant/);
  });

  test("$forTenant accepts a RecordId", async () => {
    const { client, calls } = scoped();
    await client.customers.$forTenant(new RecordId("user", "xyz")).findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:xyz");
  });

  test("a meta.tenant column that isn't a field fails the bootstrap", () => {
    const Broken = defineTable("broken", { title: s.string() }).use(
      defineTable.preset({
        meta: {
          tenant: {
            column: "tenant_id",
            principal: "user",
            softDelete: false,
            createOnly: false,
          },
        },
      }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ broken: Broken }),
        plugins: [tenantRls()],
      }),
    ).toThrow(/column "tenant_id" is not a field/);
  });

  test("a meta.tenant column that isn't a record link fails the bootstrap", () => {
    const Broken = defineTable("broken", { tenant_id: s.string() }).use(
      defineTable.preset({
        meta: {
          tenant: {
            column: "tenant_id",
            principal: "user",
            softDelete: false,
            createOnly: false,
          },
        },
      }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ broken: Broken }),
        plugins: [tenantRls()],
      }),
    ).toThrow(/must be a record link/);
  });

  test("a missing soft-delete column fails the bootstrap (SCHEMAFULL would reject its index)", () => {
    const Broken = defineTable("broken", { title: s.string() }).use(
      defineTable.preset({
        meta: {
          tenant: {
            column: "tenant_id",
            principal: "user",
            softDelete: "removedAt",
            createOnly: false,
          },
        },
        columns: {
          tenant_id: User.record().$readonly(),
        },
      }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ broken: Broken }),
        plugins: [tenantRls()],
      }),
    ).toThrow(/tombstone column "removedAt" is not a field/);
  });
});

describe("tenantRls — plugin combinations", () => {
  for (const order of [
    ["tenantRls", "softDelete"],
    ["softDelete", "tenantRls"],
  ] as const) {
    test(`soft-delete delete() stays scoped with plugins [${order.join(", ")}]`, async () => {
      const plugins = order.map((name) =>
        name === "tenantRls" ? tenantRls({ tenant: "user:abc" }) : softDelete(),
      );
      const { client, calls } = clientOver(plugins);
      await client.customers.delete({ where: { id: "customer:1" } });
      expect(calls[0]?.sql).toContain("UPDATE");
      expect(calls[0]?.sql).toContain("deletedAt");
      expect(calls[0]?.sql).toContain("tenant_id = ");
      calls.length = 0;
      await client.customers.findMany({});
      expect(calls[0]?.sql).toContain("deletedAt = NONE");
      expect(calls[0]?.sql).toContain("tenant_id = ");
    });
  }

  test("timestamps + tenantRls fill both columns on create", async () => {
    const { client, calls } = clientOver([
      tenantRls({ tenant: "user:abc" }),
      timestamps(),
    ]);
    await client.customers.create({ data: { name: "A" } });
    expect(String(scopeBind(calls[0]!))).toBe("user:abc");
    expect(calls[0]?.sql).toContain("time::now()");
  });

  test("plugin state is per delegate and namespaced under the plugin id", async () => {
    const { client } = scoped();
    const tenantDelegate = client.customers.$forTenant("user:xyz");
    expect(tenantDelegate.$state["@better-schemic/surrealdb/tenant"]).toBe(
      "user:xyz",
    );
    expect(
      client.customers.$state["@better-schemic/surrealdb/tenant"],
    ).toBeUndefined();
  });
});

describe("tenantRls — edge cases (coverage + teaching errors)", () => {
  test("a non-record scope value fails with TenantViolation (describe fallbacks)", async () => {
    const { client } = scoped();
    const fn = await caught(() =>
      client.customers.$forTenant((() => {}) as never).findMany({}),
    );
    expect(isTenantViolation(fn)).toBe(true);
    const throwing = await caught(() =>
      client.customers
        .$forTenant({
          toJSON() {
            throw new Error("nope");
          },
        } as never)
        .findMany({}),
    );
    expect(isTenantViolation(throwing)).toBe(true);
    const number = await caught(() =>
      client.customers.$forTenant(42 as never).findMany({}),
    );
    expect(isTenantViolation(number)).toBe(true);
    const empty = await caught(() =>
      client.customers.$forTenant("").findMany({}),
    );
    expect(isTenantViolation(empty)).toBe(true);
  });

  test("a RecordId scope from another table is rejected", async () => {
    const { client } = scoped();
    const error = await caught(() =>
      client.customers.$forTenant(new RecordId("other", "1")).findMany({}),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect((error as Error).message).toContain("principal");
  });

  test("a bare id on an extras-only table needs a table prefix", async () => {
    const { client } = clientOver([
      tenantRls({ tenant: "abc", tables: ["plain"] }),
    ]);
    const error = await caught(() => client.plains.findMany({}));
    expect(isTenantViolation(error)).toBe(true);
    expect((error as Error).message).toContain("principal");
  });

  test("a non-string/empty tenant payload value is a violation; a bare equal id normalizes", async () => {
    const { client, calls } = scoped();
    for (const value of [42, ""]) {
      const error = await caught(() =>
        client.customers.create({
          data: { name: "A", tenant_id: value as never },
        }),
      );
      expect(isTenantViolation(error)).toBe(true);
    }
    await client.customers.create({
      data: { name: "A", tenant_id: "abc" as never },
    });
    const payload = payloadBind(calls[0]!)!;
    expect(payload.tenant_id).toBeInstanceOf(RecordId);
    expect(String(payload.tenant_id)).toBe("user:abc");
  });

  test("an explicit { equals } tenant filter is accepted; other forms are rejected", async () => {
    const { client, calls } = scoped();
    await client.customers.findMany({
      where: { tenant_id: { equals: "user:abc" } },
    });
    expect(calls[0]?.sql).toContain("tenant_id");
    for (const bad of [
      { equals: "user:other" },
      { equals: "user:abc", notEquals: "x" },
      { in: ["user:abc"] },
    ]) {
      const error = await caught(() =>
        client.customers.findMany({ where: { tenant_id: bad } as never }),
      );
      expect(isTenantViolation(error)).toBe(true);
    }
  });

  test("non-object batch items skip injection and fail in the compiler", async () => {
    const { client } = scoped();
    const create = await caught(() =>
      client.customers.createMany({ data: [{ name: "A" }, 5 as never] }),
    );
    expect(create).not.toBeNull();
    const each = await caught(() =>
      client.customers.updateEach({ data: [5 as never] }),
    );
    expect(each).not.toBeNull();
  });

  test("malformed patch entries skip the tenant check; a nested tenant path is rejected", async () => {
    const { client } = scoped();
    const malformed = await caught(() =>
      client.customers.patch({
        where: { id: "customer:1" },
        patches: [{ op: "replace" } as never],
      }),
    );
    expect(malformed).not.toBeNull();
    const nonObject = await caught(() =>
      client.customers.patch({
        where: { id: "customer:1" },
        patches: [5 as never],
      }),
    );
    expect(nonObject).not.toBeNull();
    const nested = await caught(() =>
      client.customers.patch({
        where: { id: "customer:1" },
        patches: [{ op: "replace", path: "/tenant_id/x", value: 1 }],
      }),
    );
    expect(isTenantViolation(nested)).toBe(true);
  });

  test("tenantRls({ column }) must be a string; a RecordId config is accepted", async () => {
    expect(() => tenantRls({ column: 42 as never })).toThrow(/identifier/);
    const { client, calls } = clientOver([
      tenantRls({ tenant: new RecordId("user", "abc") }),
    ]);
    await client.customers.findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:abc");
  });

  test("schemaless extras and tagged extras both resolve", async () => {
    const schemaless = clientOver([
      tenantRls({ tenant: "user:a", tables: ["raw_audit"] }),
    ]);
    await schemaless.client.audit.findMany({});
    expect(schemaless.calls[0]?.sql).toContain("tenant_id = ");

    const tagged = clientOver([
      tenantRls({ tenant: "user:a", tables: ["customer"] }),
    ]);
    await tagged.client.customers.findMany({});
    expect(tagged.calls[0]?.sql).toContain("tenant_id = ");
  });

  test("a hand-built pipeline lazily builds the tag map (fail-closed, no silent unscoped ops)", () => {
    const pipeline = createPluginPipeline([tenantRls({ tenant: "user:a" })]);
    const freshIndex = buildSchemaIndex({ customers: Customer, plains: Plain });
    const scoped = new RuntimeOperation(
      "findMany",
      "customer",
      {},
      {},
      freshIndex,
    );
    pipeline?.transform(scoped);
    // Reads channel the scope (the compiler ANDs it); the caller's `where` stays untouched.
    expect(scoped.args.scope).toEqual({
      tenant_id: { equals: new RecordId("user", "a") },
    });
    expect(scoped.args.where).toBeUndefined();
    const untouched = new RuntimeOperation(
      "findMany",
      "plain",
      {},
      {},
      freshIndex,
    );
    pipeline?.transform(untouched);
    expect(untouched.args.scope).toBeUndefined();
    expect(untouched.args.where).toBeUndefined();
  });

  test("sharing one tenantRls instance across clients keeps each schema's tags", async () => {
    const plugin = tenantRls({ tenant: "user:a" });
    const Doc = defineTable("u_doc", { name: s.string() });
    const a = clientOver([plugin]);
    const b = clientOver([plugin]);
    const untaggedSchema = defineSchema({ docs: Doc });
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])));
    const bClient = betterSchemic(conn, {
      schema: untaggedSchema,
      plugins: [plugin],
    });
    await a.client.customers.findMany({});
    await bClient.docs.findMany({});
    expect(a.calls[0]?.sql).toContain("tenant_id = ");
    expect(calls[0]?.sql).not.toContain("tenant_id");
    expect(b.calls).toHaveLength(0);
  });

  test("relation ops are out of scope (no TenantRequired even without a scope)", async () => {
    const { client } = clientOver([tenantRls()]);
    const edge = client.customers as unknown as {
      relate(args: unknown): Promise<unknown>;
    };
    const error = await caught(() =>
      edge.relate({ from: "t_customer:1", to: "t_order:1" }),
    );
    expect(isTenantViolation(error)).toBe(false);
  });

  test("malformed meta.tenant tags fail the bootstrap", () => {
    for (const tag of ["nope", { column: "" }]) {
      const Broken = defineTable("broken", { title: s.string() }).use(
        defineTable.preset({ meta: { tenant: tag } }),
      );
      expect(() =>
        betterSchemic({} as never, {
          schema: defineSchema({ broken: Broken }),
          plugins: [tenantRls()],
        }),
      ).toThrow(/malformed meta.tenant/);
    }
  });

  test("a meta tag with a non-string/empty principal or soft-delete is tolerated", async () => {
    for (const tag of [
      { principal: 42, softDelete: false },
      { principal: "", softDelete: false },
      { principal: "user", softDelete: "" },
    ]) {
      const NoPrincipal = defineTable("nop", {
        title: s.string(),
        tenant_id: User.record().optional(),
      }).use(
        defineTable.preset({
          meta: {
            tenant: {
              column: "tenant_id",
              ...tag,
              createOnly: false,
            },
          },
        }),
      );
      const localSchema = defineSchema({ nop: NoPrincipal });
      const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])));
      const local = betterSchemic(conn, {
        schema: localSchema,
        plugins: [tenantRls({ tenant: "user:a" })],
      });
      await local.nop.findMany({});
      expect(calls[0]?.sql).toContain("tenant_id = ");
    }
  });

  test("a RecordId scope on an extras-only table skips the principal check", async () => {
    const { client, calls } = clientOver([
      tenantRls({ tenant: new RecordId("user", "a"), tables: ["plain"] }),
    ]);
    await client.plains.findMany({});
    expect(String(scopeBind(calls[0]!))).toBe("user:a");
  });

  test("a bare payload id on an extras-only table is a violation", async () => {
    const { client } = clientOver([
      tenantRls({ tenant: "user:a", tables: ["plain"] }),
    ]);
    const error = await caught(() =>
      client.plains.create({
        data: { name: "A", tenant_id: "abc" as never },
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
  });

  test("a tenant column linking the wrong table (or a bare record) fails the bootstrap", () => {
    const Other = defineTable("other", { name: s.string() });
    const Mismatch = defineTable("mismatch", {
      tenant_id: Other.record(),
    }).use(
      defineTable.preset({
        meta: {
          tenant: {
            column: "tenant_id",
            principal: "t_user",
            softDelete: false,
            createOnly: false,
          },
        },
      }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ mismatch: Mismatch }),
        plugins: [tenantRls()],
      }),
    ).toThrow(/links record<other>/);

    // A bare `record` link has no targets — the principal check is skipped.
    const Bare = defineTable("bare", {
      tenant_id: s.recordId().optional(),
    }).use(
      defineTable.preset({
        meta: {
          tenant: {
            column: "tenant_id",
            principal: "t_user",
            softDelete: false,
            createOnly: false,
          },
        },
      }),
    );
    expect(() =>
      betterSchemic({} as never, {
        schema: defineSchema({ bare: Bare }),
        plugins: [tenantRls()],
      }),
    ).not.toThrow();
  });
});
