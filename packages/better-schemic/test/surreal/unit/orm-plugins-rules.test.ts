import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"
import type { ZodString } from "zod"

import { orm } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { Client } from "../../../src/surreal/orm/types/client"
import type { Plugin } from "../../../src/surreal/orm/types/plugins"
import { recommended, rules, safe, strict } from "../../../src/surreal/plugins/rules"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"
import type { FakeConn } from "../../../test/surreal/orm-fixtures"
import { fakeConn, lines, ok } from "../orm-fixtures"

// M6.3 — the `rules` guardrail plugin: noRawUnsafe, destructive-write-without-where, requireLimit,
// maxLimit, cursor orderBy and strict fields. Offline.

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

const clientWith = (
  plugins: Parameters<typeof orm>[1]["plugins"],
): Client<
  {
    readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
  },
  FakeConn,
  readonly Plugin[]
> => {
  const { conn } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  )
  return orm(conn, { plugins, schema: schemaDef })
}

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe("rules — write/limit guardrails", () => {
  test("destructiveWriteWithoutWhere blocks updateMany/deleteMany without a filter", async () => {
    const client = clientWith([safe()])
    expect(await codeOf(() => client.users.deleteMany({}))).toBe("UnsafeMutation")
    expect(await codeOf(() => client.users.updateMany({ data: { name: "x" } }))).toBe(
      "UnsafeMutation",
    )
    expect(await codeOf(() => client.users.deleteMany({ where: { name: "A" } }))).toBeUndefined()
    expect(await codeOf(() => client.users.deleteMany({ all: true }))).toBeUndefined()
  })

  test("requireLimit + maxLimit bound findMany", async () => {
    const client = clientWith([recommended({ maxLimit: 50 })])
    expect(await codeOf(() => client.users.findMany({}))).toBe("UnsafeMutation")
    expect(await codeOf(() => client.users.findMany({ limit: 100 }))).toBe("UnsafeMutation")
    expect(await codeOf(() => client.users.findMany({ limit: 10 }))).toBeUndefined()
  })

  test("requireOrderByForCursor requires an explicit orderBy", async () => {
    const client = clientWith([strict()])
    expect(await codeOf(() => client.users.cursor({ limit: 10 }))).toBe("UnsafeMutation")
    expect(
      await codeOf(() => client.users.cursor({ limit: 10, orderBy: [{ id: "asc" }] })),
    ).toBeUndefined()
  })

  test("strict rejects unknown fields in data/where", async () => {
    const client = clientWith([rules({ strict: true })])
    expect(await codeOf(() => client.users.create({ data: { nope: 1 } as never }))).toBe(
      "UnknownField",
    )
    expect(await codeOf(() => client.users.findMany({ where: { nope: 1 } as never }))).toBe(
      "UnknownField",
    )
    expect(await codeOf(() => client.users.create({ data: { name: "A" } }))).toBeUndefined()
  })
})

describe("rules — raw guardrail", () => {
  test("noRawUnsafe blocks $unsafe but leaves $raw available", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(null)))
    const client = orm(conn, {
      plugins: [safe()],
      raw: { unsafe: true },
      schema: schemaDef,
    })
    expect(await codeOf(() => client.$unsafe("SELECT 1"))).toBe("UnsafeMutation")
    expect(await codeOf(() => client.$raw`SELECT 1`)).toBeUndefined()
  })
})
