// M6.4 — the OFFICIAL plugins against a REAL server: `soft-delete` (delete -> update, read hiding,
// `restore`) and `timestamps` (app mode). M14 adds `create-only` (guard + hard event). Ephemeral
// Server; skipped without `surreal`.
import { setDefaultTimeout } from "bun:test"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { surrealBinaryAvailable } from "../../../src/surreal/cli/engine"
import { emitTable } from "../../../src/surreal/ddl"
import { betterSchemic } from "../../../src/surreal/orm/client"
import { BetterSchemicError, isCreateOnlyViolation } from "../../../src/surreal/orm/errors"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { createOnly, createOnlyGuard } from "../../../src/surreal/plugins/create-only"
import { softDelete } from "../../../src/surreal/plugins/soft-delete"
import { timestamps } from "../../../src/surreal/plugins/timestamps"
import { defineTable, s } from "../../../src/surreal/pure"
import { caught } from "../orm-fixtures"

import { startLiveServer } from "./harness"

import type { LiveServer } from "./harness"
import type { Delegate } from "../../../src/surreal/orm/delegate"

setDefaultTimeout(120_000)

const ENABLED = surrealBinaryAvailable(),
  live = describe.skipIf(!ENABLED)
if (!ENABLED) console.warn("[orm-plugins] `surreal` binary unavailable — skipping")

const User = defineTable("sd_user", {
    name: s.string(),
    deletedAt: s.datetime().optional(),
  }),
  schema = defineSchema({ users: User })

/** A model with the soft-delete `extendModel` methods. */
type SoftModel = Delegate<typeof User> & {
  restore: (args: { where: unknown }) => Promise<unknown>
  restoreById: (id: unknown) => Promise<unknown>
}

live("orm plugins — live", () => {
  let live_: LiveServer

  beforeAll(async () => {
    live_ = await startLiveServer({
      namespace: "orm_plugins",
      database: "live",
      ddl: "DEFINE TABLE IF NOT EXISTS sd_user SCHEMALESS;",
    })
  })

  afterAll(async () => {
    await live_?.stop()
  })

  test("soft-delete: delete becomes an update and reads hide deleted rows", async () => {
    const client = betterSchemic(live_.db, { schema, plugins: [softDelete()] }),
      created = await client.users.create({ data: { name: "ada" } })
    expect(created.id).toBeDefined()

    expect((await client.users.findMany({})).some((row) => row.name === "ada")).toBe(true)

    await client.users.delete({ where: { id: created.id } })

    // The row still exists (soft-deleted), so the unfiltered read hides it…
    expect((await client.users.findMany({})).some((row) => row.name === "ada")).toBe(false)
    // …but `deleted: "with"` reveals it, with the timestamp set.
    const all = await client.users.findMany({ deleted: "with" }),
      gone = all.find((row) => row.name === "ada") as { deletedAt?: unknown } | undefined
    expect(gone?.deletedAt).toBeDefined()

    // Restore() clears the column and the row is visible again.
    await (client.users as unknown as SoftModel).restoreById(created.id)
    expect((await client.users.findMany({})).some((row) => row.name === "ada")).toBe(true)
  })

  test("timestamps: app mode stamps createdAt/updatedAt", async () => {
    const Stamp = defineTable("ts_user", {
        name: s.string(),
        createdAt: s.datetime().optional(),
        updatedAt: s.datetime().optional(),
      }),
      tsSchema = defineSchema({ users: Stamp })
    await live_.db.query("DEFINE TABLE IF NOT EXISTS ts_user SCHEMALESS;")
    const client = betterSchemic(live_.db, {
        schema: tsSchema,
        plugins: [timestamps()],
      }),
      created = await client.users.create({ data: { name: "ada" } })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)
  })

  test("create-only (soft): create stamps createdAt only; the guard blocks update; $withoutPlugins escapes (root)", async () => {
    const CoSoft = defineTable("co_soft", {
        action: s.string(),
        createdAt: s.datetime().optional(),
      }).use(createOnly()),
      coSchema = defineSchema({ logs: CoSoft })
    await live_.db.query(emitTable(CoSoft))
    const client = betterSchemic(live_.db, {
        schema: coSchema,
        plugins: [timestamps(), createOnlyGuard()],
      }),
      created = await client.logs.create({ data: { action: "login" } })
    expect(created.createdAt).toBeInstanceOf(Date)
    expect((created as { updatedAt?: unknown }).updatedAt).toBeUndefined()

    // The runtime guard rejects BEFORE compiling…
    const blocked = await caught(async () =>
      client.logs.update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    )
    expect(isCreateOnlyViolation(blocked)).toBe(true)

    // …and the unchanged row survives; `$withoutPlugins()` is the documented root/admin escape
    // (the DB permission only gates record users — root sessions pass).
    const raw = await client.logs.$withoutPlugins().update({
      where: { id: created.id },
      data: { action: "logout" },
    })
    expect(raw?.action).toBe("logout")
  })

  test("create-only (hard): the event blocks even $withoutPlugins (root) at the database", async () => {
    const CoHard = defineTable("co_hard", {
        action: s.string(),
        createdAt: s.datetime().optional(),
      }).use(createOnly({ hard: true })),
      coSchema = defineSchema({ logs: CoHard })
    await live_.db.query(emitTable(CoHard))
    const client = betterSchemic(live_.db, {
        schema: coSchema,
        plugins: [timestamps(), createOnlyGuard()],
      }),
      created = await client.logs.create({ data: { action: "login" } })
    expect(created.createdAt).toBeInstanceOf(Date)

    const blocked = await caught(async () =>
      client.logs.update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    )
    expect(isCreateOnlyViolation(blocked)).toBe(true)

    // The hard event runs without permission checks: even this root session's escape is rejected
    // By the database (THROW), and the row is untouched.
    const hardBlocked = await caught(async () =>
      client.logs.$withoutPlugins().update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    )
    expect(hardBlocked).toBeInstanceOf(BetterSchemicError)
    expect(String(hardBlocked)).toContain("append-only")
    const after = await client.logs.findFirst({ where: { id: created.id } })
    expect(after?.action).toBe("login")
  })
})
