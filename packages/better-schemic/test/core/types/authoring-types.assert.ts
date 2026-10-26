// TYPE-COMPLETENESS ASSERTIONS for core's authoring type utilities (`assertType<E,A>()`).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
//
// `assertType<Expected, Actual>()` fails to COMPILE if Actual isn't exactly Expected — so a type
// Utility that silently drifts (a wrapper it stops unwrapping, a flag it drops) turns red here
// Instead of surfacing as a mystery inference bug downstream.
import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"

import type { InnerOf, SchemaOf } from "../../../src/core/authoring"
import type * as z from "zod"

describe("InnerOf — the schema one wrapper down", () => {
  it("unwraps ZodOptional", () => {
    assertType<z.ZodString, InnerOf<z.ZodOptional<z.ZodString>>>()
  })
  it("unwraps ZodArray to its element", () => {
    assertType<z.ZodNumber, InnerOf<z.ZodArray<z.ZodNumber>>>()
  })
  it("leaves a non-wrapper schema unchanged", () => {
    assertType<z.ZodString, InnerOf<z.ZodString>>()
  })
})

describe("SchemaOf — the Zod schema a field carries", () => {
  it("passes a raw Zod schema straight through", () => {
    assertType<z.ZodString, SchemaOf<z.ZodString>>()
  })
})
