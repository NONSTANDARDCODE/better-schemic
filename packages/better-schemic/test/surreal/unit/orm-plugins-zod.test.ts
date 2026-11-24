import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"
import { z, type ZodInt, type ZodString } from "zod"

import { surql } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { Client } from "../../../src/surreal/orm/types/client"
import type { Plugin } from "../../../src/surreal/orm/types/plugins"
import { zod } from "../../../src/surreal/plugins/zod"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"
import { type FakeConn, fakeConn, lines, ok } from "../orm-fixtures"

const MAGIC_2 = 2
// M6.3 — the `zod` validation plugin: check write `data` with user Zod schemas (path in the
// ValidationError), and skip unconfigured tables. Offline.

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

const clientWith = (
  schemas: Record<string, z.ZodType>,
): Client<
  {
    readonly users: TableDef<"user", WithSmartId<"user", { name: SField<ZodString> }>>
  },
  FakeConn,
  readonly [Plugin]
> => {
  const { conn } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  )
  return orm(conn, { plugins: [zod({ schemas })], schema: schemaDef })
}

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe("zod — write validation", () => {
  const schemaFor = { user: z.object({ name: z.string().min(MAGIC_2) }) }

  test("accepts valid data and rejects invalid with a ValidationError", async () => {
    const client = clientWith(schemaFor)
    expect(await codeOf(() => client.users.create({ data: { name: "Aeon" } }))).toBeUndefined()
    expect(await codeOf(() => client.users.create({ data: { name: "A" } }))).toBe("ValidationError")
  })

  test("validates every item of a batch", async () => {
    const client = clientWith(schemaFor)
    expect(
      await codeOf(() => client.users.createMany({ data: [{ name: "Aeon" }, { name: "B" }] })),
    ).toBe("ValidationError")
  })

  test("tables without a schema are skipped", async () => {
    const client = clientWith({})
    expect(await codeOf(() => client.users.create({ data: { name: "A" } }))).toBeUndefined()
  })

  test("reads and relates are neither create nor update — skipped", async () => {
    const client = clientWith(schemaFor)
    expect(await codeOf(() => client.users.findMany())).toBeUndefined()
  })

  test("validate.create:false skips create validation", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
    )
    const client = orm(conn, {
      plugins: [zod({ schemas: schemaFor, validate: { create: false } })],
      schema: schemaDef,
    })
    expect(await codeOf(() => client.users.create({ data: { name: "A" } }))).toBeUndefined()
  })

  test("validate.update:false skips update validation", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
    )
    const client = orm(conn, {
      plugins: [zod({ schemas: schemaFor, validate: { update: false } })],
      schema: schemaDef,
    })
    expect(
      await codeOf(() =>
        client.users.update({
          data: { name: "A" },
          where: { id: new RecordId("user", 1) },
        }),
      ),
    ).toBeUndefined()
  })

  test("a data-less update (patch) is skipped", async () => {
    const client = clientWith(schemaFor)
    expect(
      await codeOf(() =>
        client.users.patch({
          patches: [{ op: "replace", path: "/name", value: "Aeon" }],
          where: { id: new RecordId("user", 1) },
        }),
      ),
    ).toBeUndefined()
  })

  test("upsertDelta validates its payload (update family)", async () => {
    const client = clientWith(schemaFor)
    expect(
      await codeOf(() =>
        client.users.upsertDelta({
          data: { name: "A" },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(await codeOf(() => client.users.upsertDelta({ data: { name: "A" } }))).toBe(
      "ValidationError",
    )

    const { conn } = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(
          line.startsWith("UPSERT") || line.startsWith("CREATE")
            ? [{ after: { id: new RecordId("user", 1), name: "Aeon" } }]
            : null,
        ),
      ),
    )
    const valid = orm(conn, {
      plugins: [zod({ schemas: schemaFor })],
      schema: schemaDef,
    })
    expect(
      await codeOf(() =>
        valid.users.upsertDelta({
          data: { name: "Aeon" },
          onMissing: "create",
          where: { id: "user:1" },
        }),
      ),
    ).toBeUndefined()
  })
})

describe("zod — numeric adjustments", () => {
  const Acct = table("acct", { balance: s.int(), name: s.string() })
  const acctSchema = schema({ accounts: Acct })
  const rules = {
    acct: z.object({
      balance: z.number().min(0).optional(),
      name: z.string().optional(),
    }),
  }
  const acctClient = (): Client<
    {
      readonly accounts: TableDef<
        "acct",
        WithSmartId<"acct", { balance: SField<ZodInt>; name: SField<ZodString> }>
      >
    },
    FakeConn,
    readonly [Plugin]
  > => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ balance: 10, id: new RecordId("acct", 1), name: "A" }])),
    )
    return orm(conn, {
      plugins: [zod({ schemas: rules })],
      schema: acctSchema,
    })
  }

  test("the marker wrapper is substituted by its OPERAND for validation", async () => {
    const client = acctClient()
    expect(
      await codeOf(() =>
        client.accounts.update({
          data: { balance: { increment: 5 } },
          where: { id: "acct:1" },
        }),
      ),
    ).toBeUndefined()
    // The operand itself is what the app schema checks (`min(0)` rejects -5).
    expect(
      await codeOf(() =>
        client.accounts.update({
          data: { balance: { increment: -5 } },
          where: { id: "acct:1" },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("expression operands are dropped from validation (the server enforces them)", async () => {
    const client = acctClient()
    expect(
      await codeOf(() =>
        client.accounts.update({
          data: { balance: { increment: surql`1`.as<number>() } },
          where: { id: "acct:1" },
        }),
      ),
    ).toBeUndefined()
  })
})
