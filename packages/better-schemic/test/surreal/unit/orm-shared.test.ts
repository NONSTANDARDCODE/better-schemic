const MAGIC_5n = 5n
const MAGIC_7n = 7n
const MAGIC_30000 = 30_000
const MAGIC_2 = 2

const MAGIC_5 = 5
const MAGIC_7 = 7
// The compiler's shared lowering primitives in isolation: `renderValue` (range / param def / param
// ref / fragment), `renderBareFragment`, the arg validators, the record-id parser and `describeValue`.
import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"

import { defineParam, range, surql } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import {
  coerceRecordId,
  coerceRecordValue,
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
  recordTargets,
  renderBareFragment,
  renderPath,
  renderValue,
  splitRecordId,
  uniqueFields,
} from "../../../src/surreal/orm/compiler/shared"
import { buildSchemaIndex, schema } from "../../../src/surreal/orm/schema"
import { required } from "../../required"
import { fakeConn, ok } from "../orm-fixtures"

import { schemaDef, User } from "./orm-writes-fixtures"

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe("renderValue", () => {
  test("ranges, param defs/refs and fragments keep their semantics", () => {
    const b = createBinds()
    const ctx = b.ctx()
    expect(renderValue(range({ from: 1, to: 5 }), b, ctx)).toContain("..=")
    expect(renderValue(range({ from: 1 }), b, ctx)).toContain("..")
    expect(renderValue(range({ after: 0, until: 11 }), b, ctx)).toContain("..")
    const P = defineParam("p_x", 1)
    expect(renderValue(P, b, ctx)).toBe("$p_x")
    expect(renderValue(P.$, b, ctx)).toBe("$p_x")
    expect(renderValue(surql`x + ${1}`, b, ctx)).toContain("x +")
  })
})

describe("renderBareFragment", () => {
  test("returns undefined for non-fragments", () => {
    const b = createBinds()
    expect(renderBareFragment(MAGIC_5, b)).toBeUndefined()
    expect(renderBareFragment(surql`rand()`, b)).toBe("rand()")
  })
})

describe("recordIdParts", () => {
  test("empty, no-fallback, bare-id fallback and table mismatch", () => {
    expect(code(() => recordIdParts("", "op", { fallbackTable: "user" }))).toBe("ValidationError")
    expect(code(() => recordIdParts("bare", "op", {}))).toBe("ValidationError")
    expect(recordIdParts("bare", "op", { fallbackTable: "user" })).toEqual({
      id: "bare",
      table: "user",
    })
    expect(recordIdParts("user:1", "op", { table: "user" })).toEqual({
      id: "1",
      table: "user",
    })
    expect(code(() => recordIdParts("other:1", "op", { table: "user" }))).toBe("ValidationError")
  })

  test("the id part is UNESCAPED (⟨…⟩/backtick/uuid spellings)", () => {
    expect(recordIdParts("user:⟨a b⟩", "op", { table: "user" })).toEqual({
      id: "a b",
      table: "user",
    })
    expect(recordIdParts("user:⟨a\\⟩b⟩", "op", { table: "user" })).toEqual({
      id: "a⟩b",
      table: "user",
    })
    expect(recordIdParts("user:`a\\`b`", "op", { table: "user" })).toEqual({
      id: "a`b",
      table: "user",
    })
    expect(recordIdParts('user:u"0190f5b2"', "op", { table: "user" })).toEqual({
      id: "0190f5b2",
      table: "user",
    })
  })
})

describe("coerceRecordId / coerceRecordValue", () => {
  test("coerceRecordId: bare fallback, prefixed validation, RecordId pass-through", () => {
    expect(String(coerceRecordId("bare", "op", { fallbackTable: "user" }))).toBe("user:bare")
    expect(String(coerceRecordId("user:1", "op", { table: "user" }))).toBe("user:⟨1⟩")
    expect(String(coerceRecordId("user:⟨a b⟩", "op", { table: "user" }))).toBe("user:⟨a b⟩")
    const rid = new RecordId("user", "1")
    expect(coerceRecordId(rid, "op", {})).toBe(rid)
    expect(code(() => coerceRecordId("bare", "op", {}))).toBe("ValidationError")
    expect(code(() => coerceRecordId("other:1", "op", { table: "user" }))).toBe("ValidationError")
  })

  test("coerceRecordValue: arrays, numbers, bare/multi/any targets", () => {
    expect(String(coerceRecordValue("bare", ["user"], "op", "f"))).toBe("user:bare")
    expect(
      (coerceRecordValue(["a", "user:b"], ["user"], "op", "f") as RecordId[]).map(String),
    ).toEqual(["user:a", "user:b"])
    expect(String(coerceRecordValue(MAGIC_7, ["user"], "op", "f"))).toBe("user:7")
    // a prefixed id on an ANY-table link passes; a bare one is a teaching error
    expect(String(coerceRecordValue("other:1", undefined, "op", "f"))).toBe("other:⟨1⟩")
    expect(code(() => coerceRecordValue("bare", undefined, "op", "f"))).toBe("ValidationError")
    expect(code(() => coerceRecordValue("bare", ["a", "b"], "op", "f"))).toBe("ValidationError")
    expect(code(() => coerceRecordValue("other:1", ["user"], "op", "f"))).toBe("ValidationError")
    // non-record values (fragments/objects/null) pass through untouched
    const rangeObj = { end: 2, start: 1 }
    expect(coerceRecordValue(rangeObj, ["user"], "op", "f")).toBe(rangeObj)
    expect(coerceRecordValue(null, ["user"], "op", "f")).toBeNull()
  })

  test("coerceRecordId: numeric values, custom `what`, nullish text", () => {
    // A non-string id value wraps in the fallback table (number and bigint).
    expect(String(coerceRecordId(MAGIC_5, "op", { fallbackTable: "user" }))).toBe("user:5")
    expect(String(coerceRecordId(MAGIC_5n, "op", { fallbackTable: "user" }))).toBe("user:5")
    // Without any table, a non-string value is a teaching error.
    expect(code(() => coerceRecordId(MAGIC_5, "op", {}))).toBe("ValidationError")
    // A custom `what` shapes the message.
    expect(String(coerceRecordId("x", "op", { fallbackTable: "user", what: "link" }))).toBe(
      "user:x",
    )
    // Nullish text hits the non-empty guard.
    expect(code(() => recordIdParts(null, "op", { fallbackTable: "user" }))).toBe("ValidationError")
    expect(code(() => recordIdParts("x", "op", {}))).toBe("ValidationError")
  })

  test("coerceRecordValue: empty targets, bigint ids, schemaless recordTargets", () => {
    // An empty target list behaves like "any table" for the bare-id error.
    expect(String(coerceRecordValue("user:1", [], "op", "f"))).toBe("user:⟨1⟩")
    expect(code(() => coerceRecordValue("bare", [], "op", "f"))).toBe("ValidationError")
    expect(String(coerceRecordValue(MAGIC_7n, ["user"], "op", "f"))).toBe("user:7")
    expect(code(() => coerceRecordValue(MAGIC_7n, ["a", "b"], "op", "f"))).toBe("ValidationError")
    // recordTargets: `id` -> the table; a schemaless meta -> undefined.
    const tableMeta = required(buildSchemaIndex({ users: User }).tables.get("users"))
    expect(recordTargets(tableMeta, "id")).toEqual(["user"])
    const sm = required(buildSchemaIndex({ audit: "audit_log" }).schemaless.get("audit"))
    expect(recordTargets(sm, "anything")).toBeUndefined()
  })
})

describe("describeValue", () => {
  test("dates, arrays, class instances and primitives", () => {
    expect(describeValue(new Date(0))).toBe("1970-01-01T00:00:00.000Z")
    expect(describeValue([1, MAGIC_2])).toBe("[2 item(s)]")
    class Foo {
      readonly marker = "x"
    }
    expect(describeValue(new Foo())).toBe("Foo")
    expect(describeValue({})).toBe("{…}")
    expect(describeValue(null)).toBe("null")
    expect(describeValue("x")).toBe('"x"')
  })
})

const { conn } = fakeConn(() => [ok([])])
const client = orm(conn, { schema: schemaDef })
const meta = required(client.$index.tables.get("users"))
const sm = required(
  orm(fakeConn(() => [ok([])]).conn, {
    schema: schema({ audit: "audit_log" }),
  }).$index.schemaless.get("audit"),
)

describe("lowering primitives", () => {
  test("isLowerableValue covers refs/ranges/params/fragments", () => {
    const P = defineParam("p_y", 1)
    expect(isLowerableValue(P.$)).toBe(true)
    expect(isLowerableValue(P)).toBe(true)
    expect(isLowerableValue(range({ from: 1 }))).toBe(true)
    expect(isLowerableValue(surql`x`)).toBe(true)
    expect(isLowerableValue(MAGIC_5)).toBe(false)
  })

  test("renderPath rejects a non-string/empty path", () => {
    expect(code(() => renderPath(""))).toBe("ValidationError")
    expect(code(() => renderPath(MAGIC_5 as never))).toBe("ValidationError")
    expect(renderPath("address.city")).toContain("address")
  })

  test("pathSegments / isArrayPath / joinAnd / paren", () => {
    expect(pathSegments("contacts[*].type")).toEqual(["contacts", "type"])
    expect(isArrayPath("tags[*]")).toBe(true)
    expect(isArrayPath("tags")).toBe(false)
    expect(joinAnd(["a", "b"])).toBe("a AND b")
    expect(paren("x")).toBe("(x)")
  })

  test("uniqueFields / isTableMeta", () => {
    expect(uniqueFields(meta)).toEqual(["email"])
    expect(uniqueFields(sm)).toEqual([])
  })

  test("pathList / nonNegativeInt / positiveInt", () => {
    expect(pathList(undefined, "groupBy")).toEqual([])
    expect(pathList("a", "groupBy")).toEqual(["a"])
    expect(pathList(["a", "b"], "groupBy")).toEqual(["a", "b"])
    expect(code(() => pathList(MAGIC_5, "groupBy", "op"))).toBe("ValidationError")
    expect(nonNegativeInt(0, "limit", "op")).toBe(0)
    expect(code(() => nonNegativeInt(-1, "limit", "op"))).toBe("ValidationError")
    expect(positiveInt(1, "perPage", "op")).toBe(1)
    expect(code(() => positiveInt(0, "perPage", "op"))).toBe("ValidationError")
  })

  test("rangeTarget + recordIdSuffix + escapeRecordIdPart", () => {
    expect(rangeTarget(meta, { end: "user:2", inclusive: true, start: "user:1" }, "op")).toBe(
      "user:1..=2",
    )
    expect(code(() => rangeTarget(meta, MAGIC_5, "op"))).toBe("ValidationError")
    expect(recordIdSuffix("user", "1", "start", "op")).toBe("1")
    expect(escapeRecordIdPart("a b")).toContain("⟨")
  })

  test("compileWithClause: noIndex, list, and the guards", () => {
    expect(compileWithClause({ noIndex: true }, "op")).toBe("WITH NOINDEX")
    expect(compileWithClause({ index: "i" }, "op")).toBe("WITH INDEX i")
    expect(compileWithClause({ index: ["i", "j"] }, "op")).toBe("WITH INDEX i, j")
    expect(code(() => compileWithClause(MAGIC_5, "op"))).toBe("ValidationError")
    expect(code(() => compileWithClause({ index: "i", noIndex: true }, "op"))).toBe(
      "ClauseNotSupported",
    )
    expect(code(() => compileWithClause({}, "op"))).toBe("ValidationError")
    expect(code(() => compileWithClause({ index: [] }, "op"))).toBe("ValidationError")
    expect(code(() => compileWithClause({ index: [MAGIC_5] }, "op"))).toBe("ValidationError")
  })

  test("datetimeLiteral / durationLiteral / parseDurationMs", () => {
    expect(datetimeLiteral(new Date(0), "op")).toBe("d'1970-01-01T00:00:00.000Z'")
    expect(datetimeLiteral("2025-01-01", "op")).toBe("d'2025-01-01'")
    expect(code(() => datetimeLiteral(MAGIC_5, "op"))).toBe("ValidationError")
    expect(durationLiteral(MAGIC_5, "op")).toBe("5ms")
    expect(durationLiteral("30s", "op")).toBe("30s")
    expect(code(() => durationLiteral("nope", "op"))).toBe("ValidationError")
    expect(code(() => durationLiteral(-1, "op"))).toBe("ValidationError")
    expect(parseDurationMs(MAGIC_5, "op")).toBe(MAGIC_5)
    expect(parseDurationMs("30s", "op")).toBe(MAGIC_30000)
    expect(code(() => parseDurationMs(-1, "op"))).toBe("ValidationError")
    expect(code(() => parseDurationMs("x", "op"))).toBe("ValidationError")
  })

  test("splitRecordId / recordIdParts message arms", () => {
    expect(splitRecordId("user:1")).toEqual({ id: "1", table: "user" })
    expect(splitRecordId("bare")).toBeUndefined()
    expect(splitRecordId(MAGIC_5)).toBeUndefined()
    expect(recordIdParts("user:1", "op", {})).toEqual({
      id: "1",
      table: "user",
    })
    // the message falls back to options.table then "table" when there's no fallback.
    expect(code(() => recordIdParts("bare", "op", { table: "user" }))).toBe("ValidationError")
  })

  test("isPlainObject", () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject(null)).toBe(false)
    class Foo {
      readonly marker = "x"
    }
    expect(isPlainObject(new Foo())).toBe(false)
  })
})
