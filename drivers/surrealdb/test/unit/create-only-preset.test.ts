// M14 — the `createOnly()` schema PRESET: `PERMISSIONS FOR update NONE` (AND-narrowed with the
// table's own), the `meta.createOnly` marker and the optional hard `{table}_create_only` event.
// Offline (DDL strings).
import { describe, expect, test } from "bun:test";
import { emitStatements, emitTable } from "../../src/ddl";
import { defineTable, s } from "../../src/index";
import {
  type BetterSchemicError,
  isBetterSchemicError,
} from "../../src/orm/errors";
import { createOnly } from "../../src/plugins/create-only";
import { isCreateOnlyDef } from "../../src/plugins/create-only-shared";
import { tenant } from "../../src/plugins/tenant";

const User = defineTable("user", { name: s.string() });

const ddl = (t: Parameters<typeof emitStatements>[0]) =>
  emitStatements(t).map((statement) => statement.ddl);

describe("createOnly() — golden DDL", () => {
  test("locks ONLY update: PERMISSIONS FOR update NONE", () => {
    const Log = defineTable("log", { action: s.string() }).use(createOnly());
    expect(ddl(Log)).toEqual([
      "DEFINE TABLE log TYPE NORMAL SCHEMAFULL PERMISSIONS FOR update NONE;",
      "DEFINE FIELD action ON TABLE log TYPE string;",
    ]);
  });

  test("AND-narrows the table's own permissions (never widens)", () => {
    const Log = defineTable("log", { action: s.string() })
      .permissions({ select: true, create: true, delete: true })
      .use(createOnly());
    expect(ddl(Log)[0]).toBe(
      "DEFINE TABLE log TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select, create, delete FULL FOR update NONE;",
    );
  });

  test("hard: true emits the UPDATE guard event (blocks even root/raw)", () => {
    const Log = defineTable("log", { action: s.string() }).use(
      createOnly({ hard: true }),
    );
    expect(ddl(Log)).toContain(
      "DEFINE EVENT log_create_only ON TABLE log WHEN $event = 'UPDATE' THEN { THROW s\"createOnly: this table is append-only — UPDATE is not allowed\"; };",
    );
  });

  test("the default (and hard: false) emits no event", () => {
    const soft = defineTable("log", {}).use(createOnly());
    expect(ddl(soft).some((s) => s.startsWith("DEFINE EVENT"))).toBe(false);
    expect(emitTable(soft)).toBe(
      emitTable(defineTable("log", {}).use(createOnly({ hard: false }))),
    );
  });

  test("a non-boolean hard is rejected early", () => {
    const hardError = (hard: unknown): unknown => {
      try {
        createOnly({ hard: hard as never });
        return null;
      } catch (e) {
        return e;
      }
    };
    for (const hard of [1, "yes", null]) {
      const error = hardError(hard) as BetterSchemicError;
      expect(isBetterSchemicError(error)).toBe(true);
      expect(error.code).toBe("SchemaInvalid");
      expect(error.message).toContain('"hard" must be a boolean');
    }
  });
});

describe("createOnly() — meta marker", () => {
  test("stamps meta.createOnly = true and adds no columns", () => {
    const Log = defineTable("log", { action: s.string() }).use(createOnly());
    expect(Log.config.meta).toEqual({ createOnly: true });
    expect(isCreateOnlyDef(Log)).toBe(true);
    // The preset contributes no columns — a create-only table declares its own (e.g. only createdAt).
    expect(Object.keys(Log.fields).sort()).toEqual(["action", "id"]);
    expect("updatedAt" in Log.fields).toBe(false);
  });

  test("a bare table is not tagged", () => {
    expect(isCreateOnlyDef(defineTable("plain", {}))).toBe(false);
    expect(defineTable("plain", {}).config.meta).toBeUndefined();
  });

  test("tenant(…, { createOnly: true }) stamps the same canonical marker", () => {
    const Order = defineTable("order", { total: s.number() }).use(
      tenant(User, { createOnly: true }),
    );
    expect(isCreateOnlyDef(Order)).toBe(true);
    expect(Order.config.meta?.tenant).toMatchObject({ createOnly: true });
    expect(ddl(Order)[0]).toContain("FOR update NONE");
  });

  test("tenant() without createOnly leaves the marker unset", () => {
    const Customer = defineTable("customer", { name: s.string() }).use(
      tenant(User),
    );
    expect(isCreateOnlyDef(Customer)).toBe(false);
  });

  test("meta merges with other presets and emits no DDL by itself", () => {
    const base = defineTable.preset({ meta: { owner: "acme" } });
    const tagged = defineTable("log", {}).use(base).use(createOnly());
    expect(tagged.config.meta).toMatchObject({
      owner: "acme",
      createOnly: true,
    });
  });
});
