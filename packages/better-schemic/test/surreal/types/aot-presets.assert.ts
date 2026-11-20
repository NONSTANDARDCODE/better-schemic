// Bun AOT — preset idempotence without `as unknown as AnyTableDef`. Type-checked by `bun check`.
import { describe, it } from "node:test";
import { assertType } from "../../../../../scripts/type-assert";
import {
  type AnyTableDef,
  type AnyTableRef,
  type App,
  type ApplyPreset,
  type Shape,
  s,
  table,
  type WithSmartId,
} from "../../../src/surreal";

const tenant = table.preset({
  columns: { tenant_id: s.recordId("tenant") },
});

// The app's helper used to need `(base as unknown as AnyTableDef).use(...) as unknown as TableDef<…>`.
function tenantTable<Name extends string, S extends Shape>(
  name: Name,
  shape: S,
): ApplyPreset<Name, WithSmartId<Name, S>, typeof tenant> {
  // `useUnchecked` skips only the collision check (unverifiable for an unresolved S) while keeping
  // Name + S — the explicit replacement for `(base as unknown as AnyTableDef).use(...)`.
  return table(name, () => shape).useUnchecked(tenant);
}

const Customer = tenantTable("customer", {
  tenant_id: s.recordId("tenant"), // already present -> identical overlap, not a conflict
  name: s.string(),
});

describe("AOT — idempotent presets", () => {
  it("use() works on a generic S with no cast and preserves Name + S", () => {
    assertType<string, App<typeof Customer>["name"]>();
    assertType<"customer", (typeof Customer)["name"]>();
  });

  it("the root entry exports the shape-erased helper types", () => {
    const erased: AnyTableDef = Customer;
    const ref: AnyTableRef = Customer;
    void erased;
    void ref;
  });

  it("apply the same preset twice at a concrete call site (idempotent)", () => {
    const T = table("c", { tenant_id: s.recordId("tenant") })
      .use(tenant)
      .use(tenant);
    assertType<true, "tenant_id" extends keyof App<typeof T> ? true : false>();
  });

  it("useUnchecked / useAs give explicit escapes that keep Name", () => {
    const U = table("u", { name: s.string() }).useUnchecked(tenant);
    assertType<string, App<typeof U>["name"]>();
    const A = table("a", { name: s.string() }).useAs<
      { name: ReturnType<typeof s.string> },
      typeof tenant
    >(tenant);
    assertType<string, App<typeof A>["name"]>();
  });

  it("a genuinely divergent column still fails to typecheck", () => {
    const clash = table.preset({ columns: { name: s.number() } });
    // @ts-expect-error — `name` is a string on the table, a number in the preset
    table("x", { name: s.string() }).use(clash);
  });
});
