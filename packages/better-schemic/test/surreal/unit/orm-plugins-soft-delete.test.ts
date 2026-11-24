import { describe, expect, test } from "bun:test"
import { type DateTime, RecordId } from "surrealdb"
import type { ZodCodec, ZodDate, ZodInstanceOf, ZodOptional, ZodString } from "zod"

import { orm } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { Client } from "../../../src/surreal/orm/types/client"
import type { Plugin } from "../../../src/surreal/orm/types/plugins"
import { softDelete } from "../../../src/surreal/plugins/soft-delete"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"
import { type FakeCall, type FakeConn, fakeConn, lines, ok } from "../orm-fixtures"

// M6.4 — the official `soft-delete` plugin: delete -> update, read filtering with `deleted:`, the
// `deletedBy` actor and the `restore`/`restoreById` model methods. Offline.

const User = table("user", {
  deletedAt: s.datetime().optional(),
  deletedBy: s.string().optional(),
  name: s.string(),
})
const schemaDef = schema({ users: User })

const clientOver = (
  plugins: Parameters<typeof orm>[1]["plugins"],
): {
  calls: FakeCall[]
  client: Client<
    {
      readonly users: TableDef<
        "user",
        WithSmartId<
          "user",
          {
            deletedAt: SField<ZodOptional<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>>
            deletedBy: SField<ZodOptional<ZodString>>
            name: SField<ZodString>
          }
        >
      >
    },
    FakeConn,
    readonly Plugin[]
  >
} => {
  const { calls, conn } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  )
  return { calls, client: orm(conn, { plugins, schema: schemaDef }) }
}

describe("soft-delete — writes", () => {
  test("delete compiles as UPDATE stamping the column", async () => {
    const { calls, client } = clientOver([softDelete()])
    await client.users.delete({ where: { id: "user:1" } })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).not.toContain("DELETE")
    expect(calls[0]?.sql).toContain("deletedAt: time::now()")
  })

  test("deleteMany stamps every matching row", async () => {
    const { calls, client } = clientOver([softDelete()])
    await client.users.deleteMany({ return: "none", where: { name: "A" } })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).toContain("deletedAt: time::now()")
  })

  test("deletedBy stamps the actor from meta", async () => {
    const { calls, client } = clientOver([
      softDelete({ actorMeta: "actor", deletedBy: "deletedBy" }),
    ])
    await client.users.delete({
      meta: { actor: "user:9" },
      where: { id: "user:1" },
    })
    expect(calls[0]?.sql).toContain("deletedBy: $b0")
    expect(calls[0]?.vars?.b0).toBe("user:9")
  })

  test("no actor in meta means no deletedBy field", async () => {
    const { calls, client } = clientOver([softDelete({ deletedBy: "deletedBy" })])
    await client.users.delete({ where: { id: "user:1" } })
    expect(calls[0]?.sql).not.toContain("deletedBy")
  })
})

describe("soft-delete — read filtering", () => {
  test("default reads filter deletedAt IS NONE", async () => {
    const { calls, client } = clientOver([softDelete()])
    await client.users.findMany({})
    expect(calls[0]?.sql).toContain("deletedAt = NONE")
    expect(calls[0]?.sql).toContain("FROM user")
  })

  test('deleted: "with" disables the filter', async () => {
    const { calls, client } = clientOver([softDelete()])
    await client.users.findMany({ deleted: "with" })
    expect(calls[0]?.sql).not.toContain("deletedAt")
  })

  test('deleted: "only" filters deletedAt IS NOT NONE', async () => {
    const { calls, client } = clientOver([softDelete()])
    await client.users.findMany({ deleted: "only" })
    expect(calls[0]?.sql).toContain("deletedAt != NONE")
  })
})

describe("soft-delete — restore", () => {
  test("restore clears the column by filter", async () => {
    const { calls, client } = clientOver([softDelete()])
    const model = client.users as unknown as {
      restore(args: { where: unknown }): Promise<unknown>
    }
    await model.restore({ where: { id: "user:1" } })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).toContain("UNSET deletedAt")
  })

  test("restoreById targets the record", async () => {
    const { calls, client } = clientOver([softDelete()])
    const model = client.users as unknown as {
      restoreById(id: unknown): Promise<unknown>
    }
    await model.restoreById("user:1")
    expect(calls[0]?.sql).toContain("UPDATE user:1")
    expect(calls[0]?.sql).toContain("UNSET deletedAt")
  })
})
