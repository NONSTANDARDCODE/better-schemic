// The tenant plugin against a REAL server in a PRIVILEGED (root) session — where `$auth` is NONE
// and DDL permissions do not filter. Verifies the runtime scope end-to-end: create injection, read
// filtering (findMany + findUnique id/unique targets), cross-tenant no-ops, `$withoutPlugins` admin
// escape, the `replace`-mode tenant injection, the ON DUPLICATE refusal, and the soft-delete
// combination. Skipped without `surreal`.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { surrealBinaryAvailable } from "../../src/cli/engine";
import { emitTable } from "../../src/ddl";
import { betterSchemic } from "../../src/orm/client";
import { isTenantViolation } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { softDelete } from "../../src/plugins/soft-delete";
import { tenant, tenantRls } from "../../src/plugins/tenant";
import { defineTable, s } from "../../src/pure";
import { caught } from "../orm-fixtures";
import { type LiveServer, startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-plugins-tenant] `surreal` binary unavailable — skipping");

const User = defineTable("t_user", { name: s.string() });
const Customer = defineTable("t_customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
}).use(tenant(User, { softDelete: true }));
const Order = defineTable("t_order", { total: s.number() }).use(
  tenant(User, { createOnly: true }),
);
/** A tenant-scoped table with a UNIQUE field — the `findUnique` unique-target path. */
const Unique = defineTable("t_uq", { code: s.string() })
  .use(tenant(User))
  .index("t_uq_code_uq", ["code"], { unique: true });
const schema = defineSchema({
  users: User,
  customers: Customer,
  orders: Order,
  uniques: Unique,
});

const A = new RecordId("t_user", "a");
const B = new RecordId("t_user", "b");

live("tenant plugin — live (privileged session)", () => {
  let live_: LiveServer;

  beforeAll(async () => {
    live_ = await startLiveServer({
      namespace: "tenant_plugin",
      database: "live",
      ddl: [emitTable(User), emitTable(Customer), emitTable(Order), emitTable(Unique)].join(
        "\n",
      ),
    });
  });

  afterAll(async () => {
    await live_?.stop();
  });

  /** A root-session client with the tenant runtime + soft delete (both orders are offline-tested). */
  const client = () =>
    betterSchemic(live_.db, {
      schema,
      plugins: [tenantRls(), softDelete()],
    });

  test("create injects the scoped tenant; reads filter by it; $withoutPlugins sees all", async () => {
    const c = client();
    const a = await c.customers.$forTenant(A).create({ data: { name: "a1" } });
    const b = await c.customers.$forTenant(B).create({ data: { name: "b1" } });
    expect(String(a.tenant_id)).toBe("t_user:a");
    expect(String(b.tenant_id)).toBe("t_user:b");

    const aRows = await c.customers.$forTenant(A).findMany({});
    expect(aRows.map((r) => r.name)).toContain("a1");
    expect(aRows.map((r) => r.name)).not.toContain("b1");

    const all = await c.customers.$withoutPlugins().findMany({});
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("cross-tenant update/delete/upsert are no-ops (scoped WHERE)", async () => {
    const c = client();
    const a = await c.customers.$forTenant(A).create({ data: { name: "a2" } });

    expect(
      await c.customers
        .$forTenant(B)
        .update({ where: { id: a.id }, data: { name: "hacked" } }),
    ).toBeNull();
    expect(
      await c.customers.$forTenant(B).delete({ where: { id: a.id } }),
    ).toBeNull();
    await c.customers
      .$forTenant(B)
      .upsert({ where: { id: a.id }, data: { name: "hacked2" } });

    const after = await c.customers
      .$forTenant(A)
      .findFirst({ where: { id: a.id } });
    expect(after?.name).toBe("a2");
  });

  test("updateMany/deleteMany without a where touch only the scoped tenant", async () => {
    const c = client();
    await c.customers.$forTenant(A).create({ data: { name: "a3" } });
    await c.customers.$forTenant(B).create({ data: { name: "b3" } });

    await c.customers.$forTenant(A).updateMany({ data: { name: "a3x" } });
    expect(
      (await c.customers.$forTenant(B).findMany({ where: { name: "b3" } }))
        .length,
    ).toBe(1);

    await c.customers.$forTenant(A).deleteMany({ all: true, return: "none" });
    expect(await c.customers.$forTenant(A).findMany({})).toHaveLength(0);
    expect(
      (await c.customers.$forTenant(B).findMany({ where: { name: "b3" } }))
        .length,
    ).toBe(1);
  });

  test("soft-delete delete() stays scoped and the tombstone hides the row", async () => {
    const c = client();
    const a = await c.customers.$forTenant(A).create({ data: { name: "a4" } });
    await c.customers.$forTenant(A).delete({ where: { id: a.id } });
    expect(
      await c.customers.$forTenant(A).findFirst({ where: { id: a.id } }),
    ).toBeNull();
    const withDeleted = await c.customers
      .$forTenant(A)
      .findMany({ deleted: "with" });
    expect(withDeleted.some((r) => String(r.id) === String(a.id))).toBe(true);
  });

  test("upsert on a missing id creates in the scoped tenant", async () => {
    const c = client();
    const id = new RecordId("t_customer", "upsert1");
    const row = await c.customers
      .$forTenant(A)
      .upsert({ where: { id }, data: { name: "u1" } });
    expect(String(row?.tenant_id)).toBe("t_user:a");
  });

  test("findUnique is scoped: a cross-tenant id and unique field resolve to null", async () => {
    const c = client();
    const a = await c.uniques.$forTenant(A).create({ data: { code: "a5" } });
    expect(
      await c.uniques.$forTenant(B).findUnique({ where: { id: a.id } }),
    ).toBeNull();
    expect(
      await c.uniques.$forTenant(B).findUnique({ where: { code: "a5" } }),
    ).toBeNull();
    // The owning tenant still resolves it through both target forms.
    expect(
      (await c.uniques.$forTenant(A).findUnique({ where: { id: a.id } }))?.code,
    ).toBe("a5");
    expect(
      (await c.uniques.$forTenant(A).findUnique({ where: { code: "a5" } }))?.id,
    ).toEqual(a.id);
  });

  test("read scoping covers count/exists/aggregate/findFirst and keeps other tenants out", async () => {
    const c = client();
    await c.customers.$forTenant(B).create({ data: { name: "b5" } });
    expect(await c.customers.$forTenant(A).count({ where: { name: "b5" } })).toBe(0);
    expect(await c.customers.$forTenant(A).exists({ where: { name: "b5" } })).toBe(
      false,
    );
    const agg = await c.customers
      .$forTenant(A)
      .aggregate({ where: { name: "b5" }, select: { _count: true } });
    expect(agg[0]?._count).toBe(0);
    expect(
      await c.customers.$forTenant(A).findFirst({ where: { name: "b5" } }),
    ).toBeNull();
  });

  test("mode replace injects the scoped tenant and never drops it", async () => {
    const c = client();
    const a = await c.customers.$forTenant(A).create({ data: { name: "a6" } });
    const replaced = await c.customers
      .$forTenant(A)
      .update({ where: { id: a.id }, data: { name: "a6x" }, mode: "replace" });
    expect(replaced?.name).toBe("a6x");
    expect(String(replaced?.tenant_id)).toBe("t_user:a");
  });

  test("a forged tenant payload fails before the DB (root session has no event guard)", async () => {
    const c = client();
    const error = await caught(() =>
      c.customers
        .$forTenant(A)
        .create({ data: { name: "forged", tenant_id: B as never } }),
    );
    expect(isTenantViolation(error)).toBe(true);
  });

  test("insert onDuplicate is refused before touching the DB", async () => {
    const c = client();
    const error = await caught(() =>
      c.customers.$forTenant(A).insert({
        data: { id: new RecordId("t_customer", "dup1"), name: "x" },
        onDuplicate: "update",
      }),
    );
    expect(isTenantViolation(error)).toBe(true);
    expect(
      await c.customers
        .$forTenant(A)
        .findUnique({ where: { id: new RecordId("t_customer", "dup1") } }),
    ).toBeNull();
  });

  test("an unscoped operation on a tagged table throws TenantRequired", async () => {
    const c = betterSchemic(live_.db, { schema, plugins: [tenantRls()] });
    const error = await caught(() => c.customers.findMany({}));
    expect(isTenantViolation(error)).toBe(true);
  });
});
