// The portable type model's constructors + fold invariants: `option<any>`/`nullable<any>` collapse,
// and `nullable(option(X))` folds to `option(nullable(X))` so `.optional().nullable()` ≡ `.nullish()`.
import { describe, expect, test } from "bun:test";
import {
  array,
  literal,
  nullable,
  option,
  record,
  scalar,
  union,
} from "../../src/driver/portable";

const str = scalar("string");

describe("portable constructors", () => {
  test("scalar / literal / record", () => {
    expect(scalar("int")).toEqual({ t: "scalar", name: "int" });
    expect(literal("active")).toEqual({ t: "literal", value: "active" });
    expect(record(["user", "admin"])).toEqual({
      t: "record",
      tables: ["user", "admin"],
    });
  });

  test("array carries an optional size", () => {
    expect(array(str)).toEqual({ t: "array", elem: str });
    expect(array(str, 3)).toEqual({ t: "array", elem: str, size: 3 });
  });

  test("union of one member collapses to that member", () => {
    expect(union([str])).toEqual(str);
    expect(union([str, scalar("int")])).toEqual({
      t: "union",
      members: [str, scalar("int")],
    });
  });
});

describe("option / nullable folds", () => {
  test("option wraps, but option<any> collapses to any", () => {
    expect(option(str)).toEqual({ t: "option", inner: str });
    expect(option(scalar("any"))).toEqual(scalar("any"));
    expect(option(literal("x"))).toEqual({ t: "option", inner: literal("x") });
  });

  test("nullable wraps, but nullable<any> collapses to any", () => {
    expect(nullable(str)).toEqual({ t: "nullable", inner: str });
    expect(nullable(scalar("any"))).toEqual(scalar("any"));
  });

  test("nullable(option(X)) folds to option(nullable(X))", () => {
    expect(nullable(option(str))).toEqual({
      t: "option",
      inner: { t: "nullable", inner: str },
    });
  });
});
