// M6.3 — the `rules` guardrail plugin: noRawUnsafe, destructive-write-without-where, requireLimit,
// MaxLimit, cursor orderBy and strict fields. Offline.
import { describe, expect, test } from "bun:test"

import { RecordId } from "surrealdb"

import { betterSchemic } from "../../../src/surreal/orm/client"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { recommended, rules, safe, strict } from "../../../src/surreal/plugins/rules"
import { defineTable, s } from "../../../src/surreal/pure"
import { fakeConn, lines, ok } from "../orm-fixtures"

const User = defineTable("user", { name: s.string() }),
  schema = defineSchema({ users: User }),
  clientWith = (plugins: Parameters<typeof betterSchemic>[1]["plugins"]) => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
    )
    return betterSchemic(conn, { schema, plugins })
  },
  codeOf = async (fn: () => unknown): Promise<string | undefined> => {
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
    expect(await codeOf(async () => client.users.deleteMany({}))).toBe("UnsafeMutation")
    expect(await codeOf(async () => client.users.updateMany({ data: { name: "x" } }))).toBe(
      "UnsafeMutation",
    )
    expect(
      await codeOf(async () => client.users.deleteMany({ where: { name: "A" } })),
    ).toBeUndefined()
    expect(await codeOf(async () => client.users.deleteMany({ all: true }))).toBeUndefined()
  })

  test("requireLimit + maxLimit bound findMany", async () => {
    const client = clientWith([recommended({ maxLimit: 50 })])
    expect(await codeOf(async () => client.users.findMany({}))).toBe("UnsafeMutation")
    expect(await codeOf(async () => client.users.findMany({ limit: 100 }))).toBe("UnsafeMutation")
    expect(await codeOf(async () => client.users.findMany({ limit: 10 }))).toBeUndefined()
  })

  test("requireOrderByForCursor requires an explicit orderBy", async () => {
    const client = clientWith([strict()])
    expect(await codeOf(async () => client.users.cursor({ limit: 10 }))).toBe("UnsafeMutation")
    expect(
      await codeOf(async () => client.users.cursor({ orderBy: [{ id: "asc" }], limit: 10 })),
    ).toBeUndefined()
  })

  test("strict rejects unknown fields in data/where", async () => {
    const client = clientWith([rules({ strict: true })])
    expect(await codeOf(async () => client.users.create({ data: { nope: 1 } as never }))).toBe(
      "UnknownField",
    )
    expect(await codeOf(async () => client.users.findMany({ where: { nope: 1 } as never }))).toBe(
      "UnknownField",
    )
    expect(await codeOf(async () => client.users.create({ data: { name: "A" } }))).toBeUndefined()
  })
})

describe("rules — raw guardrail", () => {
  test("noRawUnsafe blocks $unsafe but leaves $raw available", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(null))),
      client = betterSchemic(conn, {
        schema,
        plugins: [safe()],
        raw: { unsafe: true },
      })
    expect(await codeOf(async () => client.$unsafe("SELECT 1"))).toBe("UnsafeMutation")
    expect(await codeOf(async () => client.$raw`SELECT 1`)).toBeUndefined()
  })
})
