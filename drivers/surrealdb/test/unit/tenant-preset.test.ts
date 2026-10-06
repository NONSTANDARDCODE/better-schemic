// The `tenant()` schema PRESET — the tenant column + per-op permissions + guard event + indexes,
// matching the hand-written multi-tenant recipe line-by-line (zero-diff), with the column typed as
// a `record<principal>` and `meta.tenant` stamped for the runtime plugin.
import { describe, expect, test } from "bun:test";
import { emitStatements, emitTable } from "../../src/ddl";
import { defineTable, s, surql } from "../../src/index";
import { tenant } from "../../src/plugins/tenant";

const User = defineTable("user", { name: s.string() });

const Customer = defineTable("customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
}).use(tenant(User, { softDelete: true }));

const Order = defineTable("order", { total: s.number() }).use(
  tenant(User, { createOnly: true }),
);

const ddl = (t: Parameters<typeof emitStatements>[0]) =>
  emitStatements(t).map((s) => s.ddl);

describe("tenant() — golden DDL (soft delete)", () => {
  test("permissions, field, indexes and guard event, in canonical order", () => {
    expect(ddl(Customer)).toEqual([
      "DEFINE TABLE customer TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select WHERE tenant_id = $auth.id AND deletedAt IS NONE FOR create, delete WHERE tenant_id = $auth.id FOR update WHERE tenant_id = $auth.id AND (deletedAt IS NONE OR $before.deletedAt IS NONE AND deletedAt != NONE);",
      "DEFINE FIELD name ON TABLE customer TYPE string;",
      "DEFINE FIELD deletedAt ON TABLE customer TYPE option<datetime>;",
      "DEFINE FIELD tenant_id ON TABLE customer TYPE record<user> DEFAULT $auth.id ASSERT $value != NONE READONLY;",
      "DEFINE INDEX customer_tenant_id_idx ON TABLE customer FIELDS tenant_id;",
      "DEFINE INDEX customer_deleted_at_idx ON TABLE customer FIELDS tenant_id, deletedAt;",
      "DEFINE EVENT customer_protect_tenant_id ON TABLE customer WHEN $event = 'CREATE' OR $event = 'UPDATE' THEN IF $auth != NONE AND $after.tenant_id != $auth.id { THROW s\"tenant_id cannot manually be set to a different value than the authenticated user\"; };",
    ]);
  });
});

describe("tenant() — golden DDL (createOnly)", () => {
  test("select/create/delete share the scope; update is NONE; no deleted index", () => {
    expect(ddl(Order)).toEqual([
      "DEFINE TABLE order TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select, create, delete WHERE tenant_id = $auth.id FOR update NONE;",
      "DEFINE FIELD total ON TABLE order TYPE number;",
      "DEFINE FIELD tenant_id ON TABLE order TYPE record<user> DEFAULT $auth.id ASSERT $value != NONE READONLY;",
      "DEFINE INDEX order_tenant_id_idx ON TABLE order FIELDS tenant_id;",
      "DEFINE EVENT order_protect_tenant_id ON TABLE order WHEN $event = 'CREATE' OR $event = 'UPDATE' THEN IF $auth != NONE AND $after.tenant_id != $auth.id { THROW s\"tenant_id cannot manually be set to a different value than the authenticated user\"; };",
    ]);
  });
});

describe("tenant() — zero-diff against the manual recipe", () => {
  test("the composed table emits exactly the hand-written statements", () => {
    const manual = defineTable("customer", {
      name: s.string(),
      deletedAt: s.datetime().optional(),
      tenant_id: User.record()
        .$default(surql`$auth.id`)
        .$assert(surql`$value != NONE`)
        .$readonly(),
    })
      .permissions({
        select: surql`tenant_id = $auth.id AND deletedAt IS NONE`,
        create: surql`tenant_id = $auth.id`,
        update: surql`tenant_id = $auth.id AND (deletedAt IS NONE OR $before.deletedAt IS NONE AND deletedAt != NONE)`,
        delete: surql`tenant_id = $auth.id`,
      })
      .event("customer_protect_tenant_id", {
        when: surql`$event = 'CREATE' OR $event = 'UPDATE'`,
        // biome-ignore lint/suspicious/noThenProperty: SurrealQL's event THEN clause.
        then: surql`IF $auth != NONE AND $after.tenant_id != $auth.id { THROW ${"tenant_id cannot manually be set to a different value than the authenticated user"}; }`,
      })
      .index("customer_tenant_id_idx", ["tenant_id"])
      .index("customer_deleted_at_idx", ["tenant_id", "deletedAt"]);

    expect(ddl(Customer)).toEqual(ddl(manual));
  });

  test("the preset NARROWS existing permissions (AND), never widens", () => {
    const narrowed = defineTable("doc", { title: s.string() })
      .permissions({ select: true, delete: false })
      .use(tenant(User));
    const emitted = emitStatements(narrowed);
    const table = emitted.find((s) => s.kind === "table")?.ddl;
    expect(table).toContain(
      "PERMISSIONS FOR select, create, update WHERE tenant_id = $auth.id FOR delete NONE",
    );
  });
});

describe("tenant() — options", () => {
  test("custom column name drives the field, permissions and index names", () => {
    const Doc = defineTable("doc", { title: s.string() }).use(
      tenant(User, { column: "org_id" }),
    );
    const emitted = ddl(Doc);
    expect(emitted).toContain(
      "DEFINE FIELD org_id ON TABLE doc TYPE record<user> DEFAULT $auth.id ASSERT $value != NONE READONLY;",
    );
    expect(emitted).toContain(
      "DEFINE INDEX doc_org_id_idx ON TABLE doc FIELDS org_id;",
    );
    expect(emitted.join("\n")).toContain("org_id = $auth.id");
    expect(emitted.join("\n")).toContain("$after.org_id");
  });

  test("softDelete as a custom column snake-cases the deleted index name", () => {
    const Doc = defineTable("doc", { removedAt: s.datetime().optional() }).use(
      tenant(User, { softDelete: "removedAt" }),
    );
    const emitted = ddl(Doc);
    expect(emitted).toContain(
      "DEFINE INDEX doc_removed_at_idx ON TABLE doc FIELDS tenant_id, removedAt;",
    );
    expect(emitted.join("\n")).toContain("removedAt IS NONE");
    expect(emitted.join("\n")).toContain("$before.removedAt IS NONE");
  });

  test("names override the derived event/index names ({table} still interpolates)", () => {
    const Doc = defineTable("doc", { title: s.string() }).use(
      tenant(User, {
        softDelete: true,
        names: {
          event: "guard_{table}",
          tenantIndex: "by_tenant_{table}",
          deletedIndex: "by_deleted_{table}",
        },
      }),
    );
    const emitted = ddl(Doc);
    expect(
      emitted.some((s) => s.startsWith("DEFINE EVENT guard_doc ON TABLE doc")),
    ).toBe(true);
    expect(emitted).toContain(
      "DEFINE INDEX by_tenant_doc ON TABLE doc FIELDS tenant_id;",
    );
    expect(emitted).toContain(
      "DEFINE INDEX by_deleted_doc ON TABLE doc FIELDS tenant_id, deletedAt;",
    );
  });

  test("protect: false drops only the event", () => {
    const Doc = defineTable("doc", {}).use(tenant(User, { protect: false }));
    const emitted = ddl(Doc);
    expect(emitted.some((s) => s.startsWith("DEFINE EVENT"))).toBe(false);
    expect(emitted).toContain(
      "DEFINE INDEX doc_tenant_id_idx ON TABLE doc FIELDS tenant_id;",
    );
  });

  test("indexes: false drops only the indexes", () => {
    const Doc = defineTable("doc", {}).use(tenant(User, { indexes: false }));
    const emitted = ddl(Doc);
    expect(emitted.some((s) => s.startsWith("DEFINE INDEX"))).toBe(false);
    expect(emitted.some((s) => s.startsWith("DEFINE EVENT"))).toBe(true);
  });

  test("createOnly + softDelete is rejected at the factory (incompatible states)", () => {
    expect(() =>
      defineTable("doc", {}).use(
        tenant(User, { createOnly: true, softDelete: true }),
      ),
    ).toThrow(/mutually exclusive/);
  });

  test("a non-identifier column name is rejected early", () => {
    expect(() => tenant(User, { column: "tenant id" })).toThrow(
      /plain identifier/,
    );
    expect(() => tenant(User, { column: 42 as never })).toThrow(
      /plain identifier/,
    );
  });
});

describe("tenant() — meta marker", () => {
  test("stamps meta.tenant with the resolved options", () => {
    expect(Customer.config.meta?.tenant).toEqual({
      column: "tenant_id",
      principal: "user",
      softDelete: "deletedAt",
      createOnly: false,
    });
    expect(Order.config.meta?.tenant).toEqual({
      column: "tenant_id",
      principal: "user",
      softDelete: false,
      createOnly: true,
    });
  });

  test("meta merges with other presets and never emits DDL", () => {
    const base = defineTable.preset({ meta: { owner: "acme" } });
    const tagged = defineTable("doc", {}).use(base).use(tenant(User));
    expect(tagged.config.meta).toMatchObject({
      owner: "acme",
      tenant: { column: "tenant_id" },
    });
    // meta alone is invisible to the emitter: a meta-only preset table is DDL-identical to a bare one.
    expect(emitTable(defineTable("doc", {}).use(base))).toBe(
      emitTable(defineTable("doc", {})),
    );
  });

  test("chained .use(tenant) keeps the preset column typed and conflict-checked", () => {
    const Doc = defineTable("doc", { title: s.string() }).use(tenant(User));
    expect(Doc.fields.tenant_id).toBeDefined();
    expect("tenant_id" in Doc.update.shape).toBe(false); // $readonly excludes it
    expect(Doc.create.safeParse({ title: "t" }).success).toBe(true);
  });
});
