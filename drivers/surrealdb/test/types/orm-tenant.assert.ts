// TYPE assertions for the tenant plugin: the preset column is a typed `record<principal>` (create-
// optional, absent from updates, available as `t.<column>` in index callbacks) and `$forTenant`
// returns the FULL typed delegate (`this`), so reads/writes survive the scope clone. Run under
// node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { RecordIdValue, Surreal } from "surrealdb";
import { RecordId } from "surrealdb";
import { type App, defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { isTenantViolation } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import type { PluginModelExtras } from "../../src/orm/types/plugins";
import { tenant, tenantRls } from "../../src/plugins/tenant";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

const User = defineTable("user", { name: s.string() });
const Customer = defineTable("customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
})
  .use(tenant(User, { softDelete: true }))
  .index("by_tenant", (t) => [t.tenant_id]);
const Org = defineTable("org", {}).use(tenant(User, { column: "org_id" }));
const schema = defineSchema({ users: User, customers: Customer, orgs: Org });

const plugin = tenantRls({ tenant: "user:abc" });
type P = typeof plugin;
type C = Client<typeof schema, Surreal, [P]>;

const scoped = (client: C) => client.customers.$forTenant("user:abc");
const scopedFind = (client: C) =>
  client.customers.$forTenant("user:abc").findMany({ where: { name: "A" } });
const scopedCreate = (client: C) =>
  client.customers.$forTenant("user:abc").create({ data: { name: "A" } });
const byRecordId = (client: C) =>
  client.customers.$forTenant(new RecordId("user", "abc"));

describe("tenant preset — types", () => {
  it("the tenant column is a record<principal> carrying the principal's id value type", () => {
    attest<
      RecordId<"user", RecordIdValue>,
      App<typeof Customer>["tenant_id"]
    >();
    attest<RecordId<"user", RecordIdValue>, App<typeof Org>["org_id"]>();
  });

  it("the column is create-optional ($default) and absent from updates ($readonly)", () => {
    // A create payload without the column type-checks (the DB fills it from $auth.id).
    Customer.create.safeParse({ name: "A" });
    attest<
      false,
      "tenant_id" extends keyof Parameters<typeof Customer.encodePartial>[0]
        ? true
        : false
    >();
  });

  it("a custom column name stays typed and rename-safe in .index() callbacks", () => {
    const Indexed = defineTable("indexed", {}).use(
      tenant(User, { column: "org_id" }),
    );
    const withIndex = Indexed.index("by_org", (t) => [t.org_id]);
    attest<true, typeof withIndex extends object ? true : false>();
  });
});

describe("tenantRls — types", () => {
  it("$forTenant lands on every delegate and returns the full typed delegate (`this`)", () => {
    attest<true, "$forTenant" extends keyof C["customers"] ? true : false>();
    attest<
      true,
      "$forTenant" extends keyof PluginModelExtras<[P]> ? true : false
    >();
    attest<
      true,
      ReturnType<typeof scoped> extends { findMany: unknown; create: unknown }
        ? true
        : false
    >();
  });

  it("the scoped delegate keeps the read/write surface and accepts string | RecordId", () => {
    attest<true, ReturnType<typeof scopedFind> extends object ? true : false>();
    attest<
      true,
      ReturnType<typeof scopedCreate> extends object ? true : false
    >();
    attest<true, ReturnType<typeof byRecordId> extends object ? true : false>();
  });

  it("isTenantViolation is a boolean predicate", () => {
    attest<boolean, ReturnType<typeof isTenantViolation>>();
  });
});
