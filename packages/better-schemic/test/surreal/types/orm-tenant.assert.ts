/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-restricted-types, @typescript-eslint/no-unused-vars, @typescript-eslint/explicit-function-return-type -- Object key order mirrors expected serialized output and must stay as authored. Fixtures use object to probe schema typing. Type queries and callback signatures need fixture values. callbacks de teste: tipo inferido pelo saturador de assercoes; anotar cada um geraria ruido sem valor. */
// TYPE assertions for the tenant plugin: the preset column is a typed `record<principal>` (create-
// optional, absent from updates, available as `t.<column>` in index callbacks) and `$forTenant`
// returns the FULL typed delegate (`this`), so reads/writes survive the scope clone.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test"

import { RecordId, type Surreal } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import { type App, s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import type { isTenantViolation } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import type { PluginModelExtras } from "../../../src/surreal/orm/types/plugins"
import { tenant, tenantRls } from "../../../src/surreal/plugins/tenant"

const User = table("user", { name: s.string() })
const Customer = table("customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
})
  .use(tenant(User, { softDelete: true }))
  .index("by_tenant", (t) => [t.tenant_id])
const Org = table("org", {}).use(tenant(User, { column: "org_id" }))
const schemaDef = schema({ users: User, customers: Customer, orgs: Org })

const plugin = tenantRls({ tenant: "user:abc" })
type P = typeof plugin
type C = Client<typeof schemaDef, Surreal, [P]>

const scoped = (client: C) => client.customers.$forTenant("user:abc")
const scopedFind = (client: C) =>
  client.customers.$forTenant("user:abc").findMany({ where: { name: "A" } })
const scopedCreate = (client: C) =>
  client.customers.$forTenant("user:abc").create({ data: { name: "A" } })
const byRecordId = (client: C) => client.customers.$forTenant(new RecordId("user", "abc"))

void describe("tenant preset — types", () => {
  void it("the tenant column is a record<principal> carrying the principal's id value type", () => {
    assertType<RecordId<"user">, App<typeof Customer>["tenant_id"]>()
    assertType<RecordId<"user">, App<typeof Org>["org_id"]>()
  })

  void it("the column is create-optional ($default) and absent from updates ($readonly)", () => {
    // A create payload without the column type-checks (the DB fills it from $auth.id).
    Customer.create.safeParse({ name: "A" })
    assertType<
      false,
      "tenant_id" extends keyof Parameters<typeof Customer.encodePartial>[0] ? true : false
    >()
  })

  void it("a custom column name stays typed and rename-safe in .index() callbacks", () => {
    const Indexed = table("indexed", {}).use(tenant(User, { column: "org_id" }))
    const withIndex = Indexed.index("by_org", (t) => [t.org_id])
    assertType<true, typeof withIndex extends object ? true : false>()
  })
})

void describe("tenantRls — types", () => {
  void it("$forTenant lands on every delegate and returns the full typed delegate (`this`)", () => {
    assertType<true, "$forTenant" extends keyof C["customers"] ? true : false>()
    assertType<true, "$forTenant" extends keyof PluginModelExtras<[P]> ? true : false>()
    assertType<
      true,
      ReturnType<typeof scoped> extends { create: unknown; findMany: unknown } ? true : false
    >()
  })

  void it("the scoped delegate keeps the read/write surface and accepts string | RecordId", () => {
    assertType<true, ReturnType<typeof scopedFind> extends object ? true : false>()
    assertType<true, ReturnType<typeof scopedCreate> extends object ? true : false>()
    assertType<true, ReturnType<typeof byRecordId> extends object ? true : false>()
  })

  void it("isTenantViolation is a boolean predicate", () => {
    assertType<boolean, ReturnType<typeof isTenantViolation>>()
  })
})
