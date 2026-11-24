import { describe, expect, test } from "bun:test"
import { DateTime, RecordId } from "surrealdb"
import type { ZodCodec, ZodDate, ZodInstanceOf, ZodOptional, ZodString } from "zod"

import { orm } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { Client } from "../../../src/surreal/orm/types/client"
import type { Plugin } from "../../../src/surreal/orm/types/plugins"
import { createOnly, createOnlyGuard } from "../../../src/surreal/plugins/create-only"
import { tenant, type TenantColumns } from "../../../src/surreal/plugins/tenant"
import { timestamps } from "../../../src/surreal/plugins/timestamps"
import {
  type ApplyPreset,
  s,
  type SField,
  table,
  type TableDef,
  type TablePreset,
  type WithSmartId,
} from "../../../src/surreal/pure"
import { type FakeCall, type FakeConn, fakeConn, lines, ok } from "../orm-fixtures"

// M6.4 — the official `timestamps` plugin: `app` mode stamps time::now() on create/update and
// `database` mode strips the managed columns. Offline (expressions splice into the statement text).

const User = table("user", {
  createdAt: s.datetime().optional(),
  name: s.string(),
  updatedAt: s.datetime().optional(),
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
            createdAt: SField<ZodOptional<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>>
            name: SField<ZodString>
            updatedAt: SField<ZodOptional<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>>
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

describe("timestamps — app mode", () => {
  test("create stamps both columns with time::now()", async () => {
    const { calls, client } = clientOver([timestamps()])
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
    expect(calls[0]?.sql).toContain("updatedAt: time::now()")
  })

  test("upsertDelta: updatedAt rides the delta on update and create has none", async () => {
    const before = {
      createdAt: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
      id: new RecordId("user", 1),
      name: "A",
      updatedAt: new DateTime(new Date("2020-01-01T00:00:00.000Z")),
    }
    const after = {
      ...before,
      name: "B",
      updatedAt: new DateTime(new Date("2021-01-01T00:00:00.000Z")),
    }
    const { calls, conn } = fakeConn((sql) =>
      lines(sql).map((line) => ok(line.startsWith("IF ") ? [{ after, before }] : null)),
    )
    const client = orm(conn, { plugins: [timestamps()], schema: schemaDef })
    const result = await client.users.upsertDelta({
      data: { name: "B" },
      onMissing: "create",
      where: { id: "user:1" },
    })
    expect(result.created).toBe(false)
    expect(result.changed).toEqual(["name", "updatedAt"])
    expect(result.delta?.new.updatedAt).toBeInstanceOf(Date)
    expect(calls[0]?.sql).toContain("updatedAt: time::now()")
    expect(calls[0]?.sql).not.toContain("createdAt: time::now()")

    const fresh = fakeConn((sql) =>
      lines(sql).map((line) => ok(line.startsWith("IF ") ? [{ after: after }] : null)),
    )
    const createClient = orm(fresh.conn, {
      plugins: [timestamps()],
      schema: schemaDef,
    })
    const created = await createClient.users.upsertDelta({
      data: { id: "user:1", name: "A" },
      onMissing: "create",
    })
    expect(created.created).toBe(true)
    expect(created.delta).toBeNull()
    // `upsertDelta` is update-family: timestamps stamps `updatedAt` on both branches (like upsert).
    expect(fresh.calls[0]?.sql).toContain("updatedAt: time::now()")
  })

  test("update stamps only updatedAt", async () => {
    const { calls, client } = clientOver([timestamps()])
    await client.users.update({
      data: { name: "B" },
      mode: "merge",
      where: { id: "user:1" },
    })
    expect(calls[0]?.sql).toContain("updatedAt: time::now()")
    expect(calls[0]?.sql).not.toContain("createdAt")
  })

  test("honors custom column names", async () => {
    const { calls, client } = clientOver([
      timestamps({ createdAt: "criadoEm", updatedAt: "atualizadoEm" }),
    ])
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("criadoEm: time::now()")
    expect(calls[0]?.sql).toContain("atualizadoEm: time::now()")
  })
})

describe("timestamps — database mode", () => {
  test("strips the managed columns instead of stamping", async () => {
    const { calls, client } = clientOver([timestamps({ mode: "database" })])
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.sql).not.toContain("createdAt")
    expect(calls[0]?.sql).not.toContain("updatedAt")
  })
})

// --- create-interop: the marker suppresses `updatedAt`, order-independently ----------------

const Principal = table("principal", { name: s.string() })
const CreateOnlyLog = table("co_log", {
  createdAt: s.datetime().optional(),
  name: s.string(),
}).use(createOnly())
const TenantLog = table("t_log", {
  createdAt: s.datetime().optional(),
  name: s.string(),
}).use(tenant(Principal, { createOnly: true }))
const coSchema = schema({ logs: CreateOnlyLog, tenantLogs: TenantLog })

const coClient = (
  plugins: Parameters<typeof orm>[1]["plugins"],
): {
  calls: FakeCall[]
  client: Client<
    {
      readonly logs: ApplyPreset<
        "co_log",
        WithSmartId<
          "co_log",
          {
            createdAt: SField<ZodOptional<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>>
            name: SField<ZodString>
          }
        >,
        TablePreset
      >
      readonly tenantLogs: ApplyPreset<
        "t_log",
        WithSmartId<
          "t_log",
          {
            createdAt: SField<ZodOptional<ZodCodec<ZodInstanceOf<DateTime>, ZodDate>>>
            name: SField<ZodString>
          }
        >,
        TablePreset<
          TenantColumns<
            TableDef<"principal", WithSmartId<"principal", { name: SField<ZodString> }>>,
            "tenant_id"
          >
        >
      >
    },
    FakeConn,
    readonly Plugin[]
  >
} => {
  const { calls, conn } = fakeConn((sql) => lines(sql).map(() => ok([])))
  return { calls, client: orm(conn, { plugins, schema: coSchema }) }
}

describe("timestamps — create-only interop", () => {
  test("create stamps createdAt only — never updatedAt", async () => {
    const { calls, client } = coClient([timestamps()])
    await client.logs.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
    expect(calls[0]?.sql).not.toContain("updatedAt")
  })

  test("a bypassed update (no guard) stamps nothing — the column does not exist", async () => {
    const { calls, client } = coClient([timestamps()])
    await client.logs.update({
      data: { name: "B" },
      where: { id: "co_log:1" },
    })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).not.toContain("time::now()")
  })

  test("a custom updatedAt column is skipped too", async () => {
    const { calls, client } = coClient([timestamps({ updatedAt: "modificadoEm" })])
    await client.logs.create({ data: { name: "A" } })
    expect(calls[0]?.sql).not.toContain("modificadoEm")
    expect(calls[0]?.sql).not.toContain("updatedAt")
  })

  test("tenant(…, { createOnly: true }) tables use the canonical marker", async () => {
    const { calls, client } = coClient([timestamps()])
    await client.tenantLogs.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
    expect(calls[0]?.sql).not.toContain("updatedAt")
  })

  test("order-independent: a guard registered BEFORE timestamps changes nothing", async () => {
    const { calls, client } = coClient([createOnlyGuard(), timestamps()])
    await client.logs.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
    expect(calls[0]?.sql).not.toContain("updatedAt")
  })
})
