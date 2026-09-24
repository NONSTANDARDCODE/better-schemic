// The compiler's shared lowering primitives in isolation: `renderValue` (range / param def / param
// ref / fragment), `renderBareFragment`, the arg validators, the record-id parser and `describeValue`.
import { describe, expect, test } from "bun:test";
import { defineParam, range, surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileWithClause,
  createBinds,
  datetimeLiteral,
  describeValue,
  durationLiteral,
  escapeRecordIdPart,
  isArrayPath,
  isLowerableValue,
  isPlainObject,
  joinAnd,
  nonNegativeInt,
  paren,
  parseDurationMs,
  pathList,
  pathSegments,
  positiveInt,
  rangeTarget,
  recordIdParts,
  recordIdSuffix,
  renderBareFragment,
  renderPath,
  renderValue,
  splitRecordId,
  uniqueFields,
} from "../../src/orm/compiler/shared";
import { defineSchema } from "../../src/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";
import { schema } from "./orm-writes-fixtures";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe("renderValue", () => {
  test("ranges, param defs/refs and fragments keep their semantics", () => {
    const b = createBinds();
    const ctx = b.ctx();
    expect(renderValue(range({ from: 1, to: 5 }), b, ctx)).toContain("..=");
    expect(renderValue(range({ from: 1 }), b, ctx)).toContain("..");
    expect(renderValue(range({ after: 0, until: 11 }), b, ctx)).toContain("..");
    const P = defineParam("p_x", 1);
    expect(renderValue(P, b, ctx)).toBe("$p_x");
    expect(renderValue(P.$, b, ctx)).toBe("$p_x");
    expect(renderValue(surql`x + ${1}`, b, ctx)).toContain("x +");
  });
});

describe("renderBareFragment", () => {
  test("returns undefined for non-fragments", () => {
    const b = createBinds();
    expect(renderBareFragment(5, b)).toBeUndefined();
    expect(renderBareFragment(surql`rand()`, b)).toBe("rand()");
  });
});

describe("recordIdParts", () => {
  test("empty, no-fallback, bare-id fallback and table mismatch", () => {
    expect(code(() => recordIdParts("", "op", { fallbackTable: "user" }))).toBe(
      "ValidationError",
    );
    expect(code(() => recordIdParts("bare", "op", {}))).toBe(
      "ValidationError",
    );
    expect(recordIdParts("bare", "op", { fallbackTable: "user" })).toEqual({
      table: "user",
      id: "bare",
    });
    expect(recordIdParts("user:1", "op", { table: "user" })).toEqual({
      table: "user",
      id: "1",
    });
    expect(code(() => recordIdParts("other:1", "op", { table: "user" }))).toBe(
      "ValidationError",
    );
  });
});

describe("describeValue", () => {
  test("dates, arrays, class instances and primitives", () => {
    expect(describeValue(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(describeValue([1, 2])).toBe("[2 item(s)]");
    class Foo {}
    expect(describeValue(new Foo())).toBe("Foo");
    expect(describeValue({})).toBe("{…}");
    expect(describeValue(null)).toBe("null");
    expect(describeValue("x")).toBe('"x"');
  });
});

const { conn } = fakeConn(() => [ok([])]);
const client = betterSchemic(conn, { schema });
const meta = client.$index.tables.get("users")!;
const sm = betterSchemic(fakeConn(() => [ok([])]).conn, {
  schema: defineSchema({ audit: "audit_log" }),
}).$index.schemaless.get("audit")!;

describe("lowering primitives", () => {
  test("isLowerableValue covers refs/ranges/params/fragments", () => {
    const P = defineParam("p_y", 1);
    expect(isLowerableValue(P.$)).toBe(true);
    expect(isLowerableValue(P)).toBe(true);
    expect(isLowerableValue(range({ from: 1 }))).toBe(true);
    expect(isLowerableValue(surql`x`)).toBe(true);
    expect(isLowerableValue(5)).toBe(false);
  });

  test("renderPath rejects a non-string/empty path", () => {
    expect(code(() => renderPath(""))).toBe("ValidationError");
    expect(code(() => renderPath(5 as never))).toBe("ValidationError");
    expect(renderPath("address.city")).toContain("address");
  });

  test("pathSegments / isArrayPath / joinAnd / paren", () => {
    expect(pathSegments("contacts[*].type")).toEqual(["contacts", "type"]);
    expect(isArrayPath("tags[*]")).toBe(true);
    expect(isArrayPath("tags")).toBe(false);
    expect(joinAnd(["a", "b"])).toBe("a AND b");
    expect(paren("x")).toBe("(x)");
  });

  test("uniqueFields / isTableMeta", () => {
    expect(uniqueFields(meta)).toEqual(["email"]);
    expect(uniqueFields(sm)).toEqual([]);
  });

  test("pathList / nonNegativeInt / positiveInt", () => {
    expect(pathList(undefined, "groupBy")).toEqual([]);
    expect(pathList("a", "groupBy")).toEqual(["a"]);
    expect(pathList(["a", "b"], "groupBy")).toEqual(["a", "b"]);
    expect(code(() => pathList(5, "groupBy", "op"))).toBe("ValidationError");
    expect(nonNegativeInt(0, "limit", "op")).toBe(0);
    expect(code(() => nonNegativeInt(-1, "limit", "op"))).toBe(
      "ValidationError",
    );
    expect(positiveInt(1, "perPage", "op")).toBe(1);
    expect(code(() => positiveInt(0, "perPage", "op"))).toBe("ValidationError");
  });

  test("rangeTarget + recordIdSuffix + escapeRecordIdPart", () => {
    expect(
      rangeTarget(meta, { start: "user:1", end: "user:2", inclusive: true }, "op"),
    ).toBe("user:1..=2");
    expect(code(() => rangeTarget(meta, 5, "op"))).toBe("ValidationError");
    expect(recordIdSuffix("user", "1", "start", "op")).toBe("1");
    expect(escapeRecordIdPart("a b")).toContain("⟨");
  });

  test("compileWithClause: noIndex, list, and the guards", () => {
    expect(compileWithClause({ noIndex: true }, "op")).toBe("WITH NOINDEX");
    expect(compileWithClause({ index: "i" }, "op")).toBe("WITH INDEX i");
    expect(compileWithClause({ index: ["i", "j"] }, "op")).toBe(
      "WITH INDEX i, j",
    );
    expect(code(() => compileWithClause(5, "op"))).toBe("ValidationError");
    expect(
      code(() => compileWithClause({ noIndex: true, index: "i" }, "op")),
    ).toBe("ClauseNotSupported");
    expect(code(() => compileWithClause({}, "op"))).toBe("ValidationError");
    expect(code(() => compileWithClause({ index: [] }, "op"))).toBe(
      "ValidationError",
    );
    expect(code(() => compileWithClause({ index: [5] }, "op"))).toBe(
      "ValidationError",
    );
  });

  test("datetimeLiteral / durationLiteral / parseDurationMs", () => {
    expect(datetimeLiteral(new Date(0), "op")).toBe("d'1970-01-01T00:00:00.000Z'");
    expect(datetimeLiteral("2025-01-01", "op")).toBe("d'2025-01-01'");
    expect(code(() => datetimeLiteral(5, "op"))).toBe("ValidationError");
    expect(durationLiteral(5, "op")).toBe("5ms");
    expect(durationLiteral("30s", "op")).toBe("30s");
    expect(code(() => durationLiteral("nope", "op"))).toBe("ValidationError");
    expect(code(() => durationLiteral(-1, "op"))).toBe("ValidationError");
    expect(parseDurationMs(5, "op")).toBe(5);
    expect(parseDurationMs("30s", "op")).toBe(30_000);
    expect(code(() => parseDurationMs(-1, "op"))).toBe("ValidationError");
    expect(code(() => parseDurationMs("x", "op"))).toBe("ValidationError");
  });

  test("splitRecordId / recordIdParts message arms", () => {
    expect(splitRecordId("user:1")).toEqual({ table: "user", id: "1" });
    expect(splitRecordId("bare")).toBeUndefined();
    expect(splitRecordId(5)).toBeUndefined();
    expect(recordIdParts("user:1", "op", {})).toEqual({ table: "user", id: "1" });
    // the message falls back to options.table then "table" when there's no fallback.
    expect(code(() => recordIdParts("bare", "op", { table: "user" }))).toBe(
      "ValidationError",
    );
  });

  test("isPlainObject", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    class Foo {}
    expect(isPlainObject(new Foo())).toBe(false);
  });
});
