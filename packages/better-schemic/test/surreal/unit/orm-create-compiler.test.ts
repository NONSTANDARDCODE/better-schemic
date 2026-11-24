const MAGIC_5 = 5
// The create/insert lowering in isolation: the default operations, the singleton id, the
// skipDuplicates id guard and the insert/insertMany shape guards.

import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"

import { defineSingleton, s } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import { type Binds, createBinds } from "../../../src/surreal/orm/compiler/shared"
import {
  compileCreate,
  compileCreateMany,
  compileInsert,
  compileInsertMany,
} from "../../../src/surreal/orm/compiler/write"
import { schema } from "../../../src/surreal/orm/schema"
import { required } from "../../required"
import { fakeConn, ok } from "../orm-fixtures"

import { schemaDef } from "./orm-writes-fixtures"

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

const { conn } = fakeConn(() => [ok([])])
const client = orm(conn, { schema: schemaDef })
const meta = required(client.$index.tables.get("users"))
const b = (): Binds => createBinds()
const sql = (plan: { statements: readonly string[] }): string => plan.statements.join("\n")

describe("compileCreate / compileCreateMany", () => {
  test("default operations and an explicit RecordId", () => {
    expect(sql(compileCreate(meta, { data: { email: "a@x", name: "A" } }, b()))).toContain("CREATE")
    expect(
      sql(compileCreate(meta, { data: { id: new RecordId("user", "1"), name: "A" } }, b())),
    ).toContain("CREATE user")
    expect(sql(compileCreateMany(meta, { data: [{ name: "A" }] }, b()))).toContain("CREATE")
  })

  test("skipDuplicates: id-less rows get the generated id; explicit ids keep the whole bind", () => {
    expect(
      code(() => compileCreateMany(meta, { data: [MAGIC_5], skipDuplicates: true }, b())),
    ).toBe("ValidationError")
    expect(
      sql(compileCreateMany(meta, { data: [{ name: "A" }], skipDuplicates: true }, b())),
    ).toContain("INSERT IGNORE INTO user { name: $b0, id: rand::ulid() }")
    expect(
      sql(
        compileCreateMany(meta, { data: [{ id: "user:1", name: "A" }], skipDuplicates: true }, b()),
      ),
    ).toContain("INSERT IGNORE INTO user $p0")
  })
})

describe("compileInsert / compileInsertMany", () => {
  test("default operations; array/single shape guards", () => {
    expect(sql(compileInsert(meta, { data: { email: "a@x", name: "A" } }, b()))).toContain("INSERT")
    expect(code(() => compileInsert(meta, { data: [{ name: "A" }] }, b()))).toBe("ValidationError")
    expect(sql(compileInsertMany(meta, { data: [{ name: "A" }] }, b()))).toContain("INSERT")
    expect(code(() => compileInsertMany(meta, { data: { name: "A" } }, b()))).toBe(
      "ValidationError",
    )
    expect(code(() => compileInsertMany(meta, {}, b()))).toBe("ValidationError")
  })
})

describe("create — singleton tables", () => {
  test("a singleton delegate targets its fixed id", () => {
    const Config = defineSingleton("config", { value: s.string() })
    const c = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ config: Config }),
    })
    const configMeta = required(c.$index.tables.get("config"))
    expect(sql(compileCreate(configMeta, { data: { value: "x" } }, b()))).toContain(
      "config:default",
    )
  })
})
