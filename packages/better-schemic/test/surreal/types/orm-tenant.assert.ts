// TYPE assertions for the tenant plugin: the preset column is a typed `record<principal>` (create-
// Optional, absent from updates, available as `t.<column>` in index callbacks) and `$forTenant`
// Returns the FULL typed delegate (`this`), so reads/writes survive the scope clone.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test"

import { RecordId } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import { defineTable, s } from "../../../src/surreal"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { tenant, tenantRls } from "../../../src/surreal/plugins/tenant"

import type { App } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import type { isTenantViolation } from "../../../src/surreal/orm/errors"
import type { PluginModelExtras } from "../../../src/surreal/orm/types/plugins"
import type { RecordIdValue, Surreal } from "surrealdb"

const User = defineTable("user", { name: s.string() }),
  Customer = defineTable("customer", {
    name: s.string(),
    deletedAt: s.datetime().optional(),
  })
    .use(tenant(User, { softDelete: true }))
    .index("by_tenant", (t) => [t.tenant_id]),
  Org = defineTable("org", {}).use(tenant(User, { column: "org_id" })),
  schema = defineSchema({ users: User, customers: Customer, orgs: Org }),
  plugin = tenantRls({ tenant: "user:abc" })
type P = typeof plugin
type C = Client<typeof schema, Surreal, [P]>

const scoped = (client: C) => client.customers.$forTenant("user:abc"),
  scopedFind = async (client: C) =>
    client.customers.$forTenant("user:abc").findMany({ where: { name: "A" } }),
  scopedCreate = async (client: C) =>
    client.customers.$forTenant("user:abc").create({ data: { name: "A" } }),
  byRecordId = (client: C) => client.customers.$forTenant(new RecordId("user", "abc"))

describe("tenant preset — types", () => {
  it("the tenant column is a record<principal> carrying the principal's id value type", () => {
    assertType<RecordId<"user">, App<typeof Customer>["tenant_id"]>()
    assertType<RecordId<"user">, App<typeof Org>["org_id"]>()
  })

  it("the column is create-optional ($default) and absent from updates ($readonly)", () => {
    // A create payload without the column type-checks (the DB fills it from $auth.id).
    Customer.create.safeParse({ name: "A" })
    assertType<
      false,
      "tenant_id" extends keyof Parameters<typeof Customer.encodePartial>[0] ? true : false
    >()
  })

  it("a custom column name stays typed and rename-safe in .index() callbacks", () => {
    const Indexed = defineTable("indexed", {}).use(tenant(User, { column: "org_id" })),
      withIndex = Indexed.index("by_org", (t) => [t.org_id])
    assertType<true, typeof withIndex extends object ? true : false>()
  })
})

describe("tenantRls — types", () => {
  it("$forTenant lands on every delegate and returns the full typed delegate (`this`)", () => {
    assertType<true, "$forTenant" extends keyof C["customers"] ? true : false>()
    assertType<true, "$forTenant" extends keyof PluginModelExtras<[P]> ? true : false>()
    assertType<
      true,
      ReturnType<typeof scoped> extends { findMany: unknown; create: unknown } ? true : false
    >()
  })

  it("the scoped delegate keeps the read/write surface and accepts string | RecordId", () => {
    assertType<true, ReturnType<typeof scopedFind> extends object ? true : false>()
    assertType<true, ReturnType<typeof scopedCreate> extends object ? true : false>()
    assertType<true, ReturnType<typeof byRecordId> extends object ? true : false>()
  })

  it("isTenantViolation is a boolean predicate", () => {
    assertType<boolean, ReturnType<typeof isTenantViolation>>()
  })
})
