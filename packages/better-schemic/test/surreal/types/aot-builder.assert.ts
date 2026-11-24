// Bun AOT — fluent builder type assertions. The app-side generic helper must be expressible
// WITHOUT spreading its type parameter into a callback (that spread is the top `--explain` cause:
// "Objects change their shape"). Type-checked by `bun check` — no runtime.

import { describe, it } from "node:test"

import type { DateTime } from "surrealdb"
import type { ZodCodec, ZodDate, ZodInstanceOf } from "zod"

import { assertType } from "../../../../../scripts/type-assert"
import {
  type App,
  s,
  type SField,
  type Shape,
  table,
  type TableDef,
  type WithSmartId,
} from "../../../src/surreal"

// The shape of the app's `tenantTable` helper — generic over Name and S, but composing through
// the builder chain so every shape literal stays concrete at the call site.
function tenantTable<Name extends string, S extends Shape>(
  name: Name,
  shape: S,
): TableDef<
  Name,
  Omit<WithSmartId<Name, S>, "createdAt" | "updatedAt"> & {
    createdAt: SField<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>
    updatedAt: SField<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>
  } & Partial<{ deletedAt: SField<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>> }>
> {
  // Callback form returns the SAME reference — no object literal, no spread: the shape never
  // "changes inside the generic" (the top Bun --explain cause). Meta/preset add them by the
  // builder chain below, so every shape literal stays concrete.
  return table(name, () => shape)
    .extend({ createdAt: s.datetime(), updatedAt: s.datetime() })
    .extendIf(false, { deletedAt: s.datetime() })
    .build()
}

const _Customer = tenantTable("customer", {
  balance: s.number(),
  creditEnabled: s.boolean(),
})

void describe("AOT — fluent table builder", () => {
  void it("a generic helper keeps the concrete shape through extend/extendIf/build", () => {
    assertType<number, App<typeof _Customer>["balance"]>()
    assertType<boolean, App<typeof _Customer>["creditEnabled"]>()
    assertType<Date, App<typeof _Customer>["createdAt"]>()
  })

  void it("extendIf keys are optional in the resulting shape", () => {
    type A = App<typeof _Customer>
    assertType<true, "deletedAt" extends keyof A ? true : false>()
    assertType<true, undefined extends A["deletedAt"] ? true : false>()
  })

  void it("build() is an identity terminal (still a TableDef)", () => {
    const _direct = table("user", { name: s.string() })
    assertType<typeof _direct, ReturnType<typeof _direct.build>>()
    assertType<App<typeof _direct>, App<ReturnType<typeof _direct.build>>>()
  })

  void it("the callback form still infers S", () => {
    const _Self = table("self", (self) => ({ manager: self.optional() }))
    assertType<true, "manager" extends keyof App<typeof _Self> ? true : false>()
    assertType<true, undefined extends App<typeof _Self>["manager"] ? true : false>()
  })

  void it("the raw-map form still infers S with the guarded parameter", () => {
    const _Raw = table("raw", { tag: s.string() })
    assertType<string, App<typeof _Raw>["tag"]>()
  })
})
