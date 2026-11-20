// Bun AOT — fluent builder type assertions. The app-side generic helper must be expressible
// WITHOUT spreading its type parameter into a callback (that spread is the top `--explain` cause:
// "Objects change their shape"). Type-checked by `bun check` — no runtime.
import { describe, it } from "node:test";
import { assertType } from "../../../../../scripts/type-assert";
import { type App, type Shape, s, table } from "../../../src/surreal";

// The shape of the app's `tenantTable` helper — generic over Name and S, but composing through
// the builder chain so every shape literal stays concrete at the call site.
function tenantTable<Name extends string, S extends Shape>(
  name: Name,
  shape: S,
) {
  // Callback form returns the SAME reference — no object literal, no spread: the shape never
  // "changes inside the generic" (the top Bun --explain cause). Meta/preset are added by the
  // builder chain below, so every shape literal stays concrete.
  return table(name, () => shape)
    .extend({ createdAt: s.datetime(), updatedAt: s.datetime() })
    .extendIf(false, { deletedAt: s.datetime() })
    .build();
}

const Customer = tenantTable("customer", {
  balance: s.number(),
  creditEnabled: s.boolean(),
});

describe("AOT — fluent table builder", () => {
  it("a generic helper keeps the concrete shape through extend/extendIf/build", () => {
    assertType<number, App<typeof Customer>["balance"]>();
    assertType<boolean, App<typeof Customer>["creditEnabled"]>();
    assertType<Date, App<typeof Customer>["createdAt"]>();
  });

  it("extendIf keys are optional in the resulting shape", () => {
    type A = App<typeof Customer>;
    assertType<true, "deletedAt" extends keyof A ? true : false>();
    assertType<true, undefined extends A["deletedAt"] ? true : false>();
  });

  it("build() is an identity terminal (still a TableDef)", () => {
    const direct = table("user", { name: s.string() });
    assertType<typeof direct, ReturnType<typeof direct.build>>();
    assertType<App<typeof direct>, App<ReturnType<typeof direct.build>>>();
  });

  it("the callback form still infers S", () => {
    const Self = table("self", (self) => ({ manager: self.optional() }));
    assertType<true, "manager" extends keyof App<typeof Self> ? true : false>();
    assertType<
      true,
      undefined extends App<typeof Self>["manager"] ? true : false
    >();
  });

  it("the raw-map form still infers S with the guarded parameter", () => {
    const Raw = table("raw", { tag: s.string() });
    assertType<string, App<typeof Raw>["tag"]>();
  });
});
