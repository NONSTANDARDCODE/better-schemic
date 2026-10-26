// The tenant plugin against a REAL server in a PRIVILEGED (root) session — where `$auth` is NONE
// And DDL permissions do not filter. Verifies the runtime scope end-to-end: create injection, read
// Filtering (findMany + findUnique id/unique targets), cross-tenant no-ops, `$withoutPlugins` admin
// Escape, the `replace`-mode tenant injection, the ON DUPLICATE refusal, and the soft-delete
// Combination. Skipped without `surreal`.
import { setDefaultTimeout } from "bun:test"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { RecordId } from "surrealdb"

import { surrealBinaryAvailable } from "../../../src/surreal/cli/engine"
import { emitTable } from "../../../src/surreal/ddl"
import { betterSchemic } from "../../../src/surreal/orm/client"
import { isTenantViolation } from "../../../src/surreal/orm/errors"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { softDelete } from "../../../src/surreal/plugins/soft-delete"
import { tenant, tenantRls } from "../../../src/surreal/plugins/tenant"
import { defineTable, s } from "../../../src/surreal/pure"
import { caught } from "../orm-fixtures"

import { startLiveServer } from "./harness"

import type { LiveServer } from "./harness"
import type { BetterSchemicError } from "../../../src/surreal/orm/errors"

setDefaultTimeout(120_000)

const ENABLED = surrealBinaryAvailable(),
  live = describe.skipIf(!ENABLED)
if (!ENABLED) console.warn("[orm-plugins-tenant] `surreal` binary unavailable — skipping")

const User = defineTable("t_user", { name: s.string() }),
  Customer = defineTable("t_customer", {
    name: s.string(),
    deletedAt: s.datetime().optional(),
  }).use(tenant(User, { softDelete: true })),
  Order = defineTable("t_order", { total: s.number() }).use(tenant(User, { createOnly: true })),
  /** A tenant-scoped table with a UNIQUE field — the `findUnique` unique-target path. */
  Unique = defineTable("t_uq", { code: s.string() })
    .use(tenant(User))
    .index("t_uq_code_uq", ["code"], { unique: true }),
  schema = defineSchema({
    users: User,
    customers: Customer,
    orders: Order,
    uniques: Unique,
  }),
  A = new RecordId("t_user", "a"),
  B = new RecordId("t_user", "b")

live("tenant plugin — live (privileged session)", () => {
  let live_: LiveServer

  beforeAll(async () => {
    live_ = await startLiveServer({
      namespace: "tenant_plugin",
      database: "live",
      ddl: [emitTable(User), emitTable(Customer), emitTable(Order), emitTable(Unique)].join("\n"),
    })
  })

  afterAll(async () => {
    await live_?.stop()
  })

  /** A root-session client with the tenant runtime + soft delete (both orders are offline-tested). */
  const client = () =>
    betterSchemic(live_.db, {
      schema,
      plugins: [tenantRls(), softDelete()],
    })

  test("create injects the scoped tenant; reads filter by it; $withoutPlugins sees all", async () => {
    const c = client(),
      a = await c.customers.$forTenant(A).create({ data: { name: "a1" } }),
      b = await c.customers.$forTenant(B).create({ data: { name: "b1" } })
    expect(String(a.tenant_id)).toBe("t_user:a")
    expect(String(b.tenant_id)).toBe("t_user:b")

    const aRows = await c.customers.$forTenant(A).findMany({})
    expect(aRows.map((r) => r.name)).toContain("a1")
    expect(aRows.map((r) => r.name)).not.toContain("b1")

    const all = await c.customers.$withoutPlugins().findMany({})
    expect(all.length).toBeGreaterThanOrEqual(2)
  })

  test("cross-tenant update/delete/upsert are no-ops (scoped WHERE) — strict upsert rejects", async () => {
    const c = client(),
      a = await c.customers.$forTenant(A).create({ data: { name: "a2" } })

    expect(
      await c.customers.$forTenant(B).update({ where: { id: a.id }, data: { name: "hacked" } }),
    ).toBeNull()
    expect(await c.customers.$forTenant(B).delete({ where: { id: a.id } })).toBeNull()
    const crossTenant = (await caught(() =>
      c.customers.$forTenant(B).upsert({ where: { id: a.id }, data: { name: "hacked2" } }),
    )) as BetterSchemicError
    expect(crossTenant.code).toBe("ResultNotFound")

    const after = await c.customers.$forTenant(A).findFirst({ where: { id: a.id } })
    expect(after?.name).toBe("a2")
  })

  test("updateMany/deleteMany without a where touch only the scoped tenant", async () => {
    const c = client()
    await c.customers.$forTenant(A).create({ data: { name: "a3" } })
    await c.customers.$forTenant(B).create({ data: { name: "b3" } })

    await c.customers.$forTenant(A).updateMany({ data: { name: "a3x" } })
    expect((await c.customers.$forTenant(B).findMany({ where: { name: "b3" } })).length).toBe(1)

    await c.customers.$forTenant(A).deleteMany({ all: true, return: "none" })
    expect(await c.customers.$forTenant(A).findMany({})).toHaveLength(0)
    expect((await c.customers.$forTenant(B).findMany({ where: { name: "b3" } })).length).toBe(1)
  })

  test("soft-delete delete() stays scoped and the tombstone hides the row", async () => {
    const c = client(),
      a = await c.customers.$forTenant(A).create({ data: { name: "a4" } })
    await c.customers.$forTenant(A).delete({ where: { id: a.id } })
    expect(await c.customers.$forTenant(A).findFirst({ where: { id: a.id } })).toBeNull()
    const withDeleted = await c.customers.$forTenant(A).findMany({ deleted: "with" })
    expect(withDeleted.some((r) => String(r.id) === String(a.id))).toBe(true)
  })

  test("upsert on a missing id creates in the scoped tenant", async () => {
    const c = client(),
      id = new RecordId("t_customer", "upsert1"),
      row = await c.customers.$forTenant(A).upsert({
        where: { id },
        data: { name: "u1" },
        onMissing: "create",
      })
    expect(String(row?.tenant_id)).toBe("t_user:a")
  })

  test("upsertDelta: scoped create/update, and a cross-tenant strict miss rejects", async () => {
    const c = client(),
      id = new RecordId("t_customer", "delta1"),
      created = await c.customers.$forTenant(A).upsertDelta({
        where: { id },
        data: { name: "d1" },
        onMissing: "create",
      })
    expect(created.created).toBe(true)
    expect(created.delta).toBeNull()
    expect(String(created.record.tenant_id)).toBe("t_user:a")

    const updated = await c.customers
      .$forTenant(A)
      .upsertDelta({ where: { id }, data: { name: "d2" } })
    expect(updated.created).toBe(false)
    expect(updated.changed).toEqual(["name"])
    expect(updated.delta?.old.name).toBe("d1")
    expect(updated.delta?.new.name).toBe("d2")

    const error = (await caught(() =>
      c.customers.$forTenant(B).upsertDelta({
        where: { id },
        data: { name: "hacked" },
        onMissing: "throw",
      }),
    )) as BetterSchemicError
    expect(error.code).toBe("ResultNotFound")
    expect((await c.customers.$forTenant(A).findUnique({ where: { id } }))?.name).toBe("d2")
  })

  test("findUnique is scoped: a cross-tenant id and unique field resolve to null", async () => {
    const c = client(),
      a = await c.uniques.$forTenant(A).create({ data: { code: "a5" } })
    expect(await c.uniques.$forTenant(B).findUnique({ where: { id: a.id } })).toBeNull()
    expect(await c.uniques.$forTenant(B).findUnique({ where: { code: "a5" } })).toBeNull()
    // The owning tenant still resolves it through both target forms.
    expect((await c.uniques.$forTenant(A).findUnique({ where: { id: a.id } }))?.code).toBe("a5")
    expect((await c.uniques.$forTenant(A).findUnique({ where: { code: "a5" } }))?.id).toEqual(a.id)
  })

  test("read scoping covers count/exists/aggregate/findFirst and keeps other tenants out", async () => {
    const c = client()
    await c.customers.$forTenant(B).create({ data: { name: "b5" } })
    expect(await c.customers.$forTenant(A).count({ where: { name: "b5" } })).toBe(0)
    expect(await c.customers.$forTenant(A).exists({ where: { name: "b5" } })).toBe(false)
    const agg = await c.customers
      .$forTenant(A)
      .aggregate({ where: { name: "b5" }, select: { _count: true } })
    expect(agg[0]?._count).toBe(0)
    expect(await c.customers.$forTenant(A).findFirst({ where: { name: "b5" } })).toBeNull()
  })

  test("mode replace injects the scoped tenant and never drops it", async () => {
    const c = client(),
      a = await c.customers.$forTenant(A).create({ data: { name: "a6" } }),
      replaced = await c.customers
        .$forTenant(A)
        .update({ where: { id: a.id }, data: { name: "a6x" }, mode: "replace" })
    expect(replaced?.name).toBe("a6x")
    expect(String(replaced?.tenant_id)).toBe("t_user:a")
  })

  test("a forged tenant payload fails before the DB (root session has no event guard)", async () => {
    const c = client(),
      error = await caught(() =>
        c.customers.$forTenant(A).create({ data: { name: "forged", tenant_id: B as never } }),
      )
    expect(isTenantViolation(error)).toBe(true)
  })

  test("insert onDuplicate is refused before touching the DB", async () => {
    const c = client(),
      error = await caught(() =>
        c.customers.$forTenant(A).insert({
          data: { id: new RecordId("t_customer", "dup1"), name: "x" },
          onDuplicate: "update",
        }),
      )
    expect(isTenantViolation(error)).toBe(true)
    expect(
      await c.customers
        .$forTenant(A)
        .findUnique({ where: { id: new RecordId("t_customer", "dup1") } }),
    ).toBeNull()
  })

  test("an unscoped operation on a tagged table throws TenantRequired", async () => {
    const c = betterSchemic(live_.db, { schema, plugins: [tenantRls()] }),
      error = await caught(async () => c.customers.findMany({}))
    expect(isTenantViolation(error)).toBe(true)
  })
})
