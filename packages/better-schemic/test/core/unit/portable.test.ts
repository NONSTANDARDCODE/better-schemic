const MAGIC_3 = 3
// The portable type model's constructors + fold invariants: `option<any>`/`nullable<any>` collapse,
// and `nullable(option(X))` folds to `option(nullable(X))` so `.optional().nullable()` ≡ `.nullish()`.
import { describe, expect, test } from "bun:test"

import {
  array,
  literal,
  nullable,
  option,
  record,
  scalar,
  union,
} from "../../../src/core/driver/portable"

const str = scalar("string")

describe("portable constructors", () => {
  test("scalar / literal / record", () => {
    expect(scalar("int")).toEqual({ name: "int", t: "scalar" })
    expect(literal("active")).toEqual({ t: "literal", value: "active" })
    expect(record(["user", "admin"])).toEqual({
      t: "record",
      tables: ["user", "admin"],
    })
  })

  test("array carries an optional size", () => {
    expect(array(str)).toEqual({ elem: str, t: "array" })
    expect(array(str, MAGIC_3)).toEqual({ elem: str, size: 3, t: "array" })
  })

  test("union of one member collapses to that member", () => {
    expect(union([str])).toEqual(str)
    expect(union([str, scalar("int")])).toEqual({
      members: [str, scalar("int")],
      t: "union",
    })
  })
})

describe("option / nullable folds", () => {
  test("option wraps, but option<any> collapses to any", () => {
    expect(option(str)).toEqual({ inner: str, t: "option" })
    expect(option(scalar("any"))).toEqual(scalar("any"))
    expect(option(literal("x"))).toEqual({ inner: literal("x"), t: "option" })
  })

  test("nullable wraps, but nullable<any> collapses to any", () => {
    expect(nullable(str)).toEqual({ inner: str, t: "nullable" })
    expect(nullable(scalar("any"))).toEqual(scalar("any"))
  })

  test("nullable(option(X)) folds to option(nullable(X))", () => {
    expect(nullable(option(str))).toEqual({
      inner: { inner: str, t: "nullable" },
      t: "option",
    })
  })
})
