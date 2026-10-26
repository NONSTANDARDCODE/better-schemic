// M14 — the `createOnlyGuard` runtime plugin: update-family operations on tagged tables throw
// `CreateOnlyViolation` BEFORE compiling; untagged tables pass untouched; `$withoutPlugins()`
// Escapes the client guard (the hard event, when declared, blocks the DB side instead). Offline.
import { describe, expect, test } from "bun:test"

import { surql } from "../../../src/surreal"
import { betterSchemic } from "../../../src/surreal/orm/client"
import { isBetterSchemicError, isCreateOnlyViolation } from "../../../src/surreal/orm/errors"
import { RuntimeOperation, createPluginPipeline } from "../../../src/surreal/orm/plugins"
import { buildSchemaIndex, defineSchema } from "../../../src/surreal/orm/schema"
import { createOnly, createOnlyGuard } from "../../../src/surreal/plugins/create-only"
import { softDelete } from "../../../src/surreal/plugins/soft-delete"
import { defineTable, s } from "../../../src/surreal/pure"
import { caught, fakeConn, lines, ok } from "../orm-fixtures"

import type { BetterSchemicError } from "../../../src/surreal/orm/errors"

const AuditLog = defineTable("audit_log", {
    action: s.string(),
    createdAt: s.datetime().optional(),
  }).use(createOnly()),
  HardLog = defineTable("hard_audit", { action: s.string() }).use(createOnly({ hard: true })),
  Plain = defineTable("plain", { name: s.string() }),
  /** A hand-rolled hard guard event (no preset marker) — the `tables` fallback's hard detection. */
  EventOnly = defineTable("event_only", { name: s.string() }).event("event_only_create_only", {
    when: surql`$event = 'UPDATE'`,

    then: surql`{ THROW "append-only"; }`,
  }),
  schema = defineSchema({
    logs: AuditLog,
    hardLogs: HardLog,
    plains: Plain,
    rawLogs: "raw_log",
  }),
  clientOver = (plugins: Parameters<typeof betterSchemic>[1]["plugins"]) => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([])))
    return { client: betterSchemic(conn, { schema, plugins }), calls }
  }

describe("createOnlyGuard — the update family never reaches the wire", () => {
  test("every update-family op throws CreateOnlyViolation", async () => {
    const { client, calls } = clientOver([createOnlyGuard()]),
      attempts = [
        async () =>
          client.logs.update({
            where: { id: "audit_log:1" },
            data: { action: "b" },
          }),
        async () => client.logs.updateMany({ data: { action: "b" } }),
        async () => client.logs.updateEach({ data: [{ id: "audit_log:1", action: "b" }] }),
        async () =>
          client.logs.patch({
            where: { id: "audit_log:1" },
            patches: [{ op: "replace", path: "/action", value: "b" }],
          }),
        async () => client.logs.upsert({ data: { action: "b" } }),
        async () => client.logs.upsertDelta({ data: { action: "b" } }),
        async () => client.logs.upsertMany({ data: [{ action: "b" }] }),
      ]
    for (const attempt of attempts) {
      const error = await caught(attempt)
      expect(isCreateOnlyViolation(error)).toBe(true)
      expect((error as BetterSchemicError).table).toBe("audit_log")
      expect((error as BetterSchemicError).status).toBe(403)
    }
    expect(calls).toHaveLength(0) // Every rejection happened BEFORE compiling
  })

  test("the error carries the operation + a teaching escape hatch", async () => {
    const { client } = clientOver([createOnlyGuard()]),
      error = (await caught(async () =>
        client.logs.update({
          where: { id: "audit_log:1" },
          data: { action: "b" },
        }),
      )) as BetterSchemicError
    expect(isBetterSchemicError(error)).toBe(true)
    expect(error.code).toBe("CreateOnlyViolation")
    expect(error.operation).toBe("update")
    expect(error.message).toContain('"audit_log" is create-only (append-only)')
    expect(error.message).toContain("$withoutPlugins() for an intentional admin operation")
  })

  test("with the hard event the hint names the DB barrier, not $withoutPlugins()", async () => {
    const { client } = clientOver([createOnlyGuard()]),
      error = (await caught(async () =>
        client.hardLogs.update({
          where: { id: "hard_audit:1" },
          data: { action: "b" },
        }),
      )) as BetterSchemicError
    expect(isCreateOnlyViolation(error)).toBe(true)
    expect(error.message).toContain("the hard guard event blocks $withoutPlugins() and raw SQL too")
  })
})

describe("createOnlyGuard — insert conflict policies", () => {
  test('onDuplicate "update" and a non-empty map are blocked', async () => {
    const { client, calls } = clientOver([createOnlyGuard()]),
      update = (await caught(async () =>
        client.logs.insert({ data: { action: "a" }, onDuplicate: "update" }),
      )) as BetterSchemicError
    expect(isCreateOnlyViolation(update)).toBe(true)
    expect(update.operation).toBe("insert")
    expect(update.message).toContain('onDuplicate "update" can UPDATE')

    const map = (await caught(async () =>
      client.logs.insert({
        data: { action: "a" },
        onDuplicate: { action: "b" },
      }),
    )) as BetterSchemicError
    expect(isCreateOnlyViolation(map)).toBe(true)
    expect(map.message).toContain("onDuplicate {…} can UPDATE")

    const many = await caught(async () =>
      client.logs.insertMany({
        data: [{ action: "a" }],
        onDuplicate: "update",
      }),
    )
    expect(isCreateOnlyViolation(many)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test('plain insert, "ignore" and an all-undefined map pass through', async () => {
    const { client, calls } = clientOver([createOnlyGuard()])
    await client.logs.insert({ data: { action: "a" } })
    await client.logs.insert({ data: { action: "a" }, onDuplicate: "ignore" })
    await client.logs.insertMany({
      data: [{ action: "a" }],
      onDuplicate: "ignore",
    })
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => !call.sql.includes("ON DUPLICATE"))).toBe(true)

    // An all-undefined map compiles nothing: the compiler's own teaching error must win
    // (the guard never masks it with a CreateOnlyViolation).
    const invalid = await caught(async () =>
      client.logs.insert({
        data: { action: "a" },
        onDuplicate: { action: undefined } as never,
      }),
    )
    expect(isCreateOnlyViolation(invalid)).toBe(false)
    expect((invalid as BetterSchemicError).code).toBe("ValidationError")
    expect(calls).toHaveLength(3)
  })
})

describe("createOnlyGuard — allowed operations and boundaries", () => {
  test("create/createMany/reads/delete pass through", async () => {
    const { client, calls } = clientOver([createOnlyGuard()])
    await client.logs.create({ data: { action: "a" } })
    await client.logs.createMany({ data: [{ action: "a" }] })
    await client.logs.findMany({})
    await client.logs.delete({ where: { id: "audit_log:1" } })
    expect(calls).toHaveLength(4)
    expect(calls[2]?.sql).toContain("SELECT")
    expect(calls[3]?.sql).toContain("DELETE")
  })

  test("untagged tables are untouched (zero behavior change)", async () => {
    const { client, calls } = clientOver([createOnlyGuard()])
    await client.plains.update({
      where: { id: "plain:1" },
      data: { name: "n" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain("UPDATE")
  })

  test("$withoutPlugins() escapes the client guard", async () => {
    const { client, calls } = clientOver([createOnlyGuard()])
    await client.logs.$withoutPlugins().update({
      where: { id: "audit_log:1" },
      data: { action: "b" },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain("UPDATE audit_log")
  })

  test("softDelete + createOnlyGuard is contradictory: a soft delete IS an update — rejected", async () => {
    const { client, calls } = clientOver([softDelete(), createOnlyGuard()]),
      error = (await caught(async () =>
        client.logs.delete({ where: { id: "audit_log:1" } }),
      )) as BetterSchemicError
    expect(isCreateOnlyViolation(error)).toBe(true)
    // SoftDelete rewrote the kind BEFORE the guard saw it: the message names the real mutation.
    expect(error.operation).toBe("update")
    expect(error.message).toContain("is an UPDATE")
    expect(calls).toHaveLength(0)
  })
})

describe("createOnlyGuard — the `tables` fallback", () => {
  test("extra physical names are guarded (typed + schemaless)", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([]))),
      client = betterSchemic(conn, {
        schema,
        plugins: [createOnlyGuard({ tables: ["plain", "raw_log"] })],
      }),
      typed = await caught(async () =>
        client.plains.update({ where: { id: "plain:1" }, data: { name: "n" } }),
      )
    expect(isCreateOnlyViolation(typed)).toBe(true)
    const loose = await caught(async () =>
      client.rawLogs.update({
        where: { id: "raw_log:1" },
        data: { name: "n" },
      }),
    )
    expect(isCreateOnlyViolation(loose)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("a hand-rolled guard event on an entry selects the hard hint", async () => {
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok([]))),
      client = betterSchemic(conn, {
        schema: defineSchema({ events: EventOnly, plains: Plain }),
        plugins: [createOnlyGuard({ tables: ["event_only"] })],
      }),
      error = (await caught(async () =>
        client.events.update({
          where: { id: "event_only:1" },
          data: { name: "n" },
        }),
      )) as BetterSchemicError
    expect(isCreateOnlyViolation(error)).toBe(true)
    expect(error.message).toContain("the hard guard event blocks")
  })

  test("an entry that already carries the preset marker keeps its hard flag", async () => {
    const { client } = clientOver([createOnlyGuard({ tables: ["hard_audit"] })]),
      error = (await caught(async () =>
        client.hardLogs.update({
          where: { id: "hard_audit:1" },
          data: { action: "b" },
        }),
      )) as BetterSchemicError
    expect(error.message).toContain("the hard guard event blocks")
  })

  test("a preset-less, entry-less schema is untouched", async () => {
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok([]))),
      client = betterSchemic(conn, {
        schema: defineSchema({ plains: Plain }),
        plugins: [createOnlyGuard()],
      })
    await client.plains.update({
      where: { id: "plain:1" },
      data: { name: "n" },
    })
    expect(calls).toHaveLength(1)
  })

  test("an unknown entry fails the bootstrap (SchemaInvalid)", () => {
    let error: unknown
    try {
      betterSchemic({} as never, {
        schema,
        plugins: [createOnlyGuard({ tables: ["ghost"] })],
      })
    } catch (e) {
      error = e
    }
    expect(isBetterSchemicError(error)).toBe(true)
    expect((error as BetterSchemicError).code).toBe("SchemaInvalid")
    expect((error as BetterSchemicError).message).toContain('"ghost" is not in the schema')
  })

  test("a non-string entry fails at the factory (PluginError)", () => {
    for (const bad of ["", 42, null]) {
      let error: unknown
      try {
        createOnlyGuard({ tables: [bad as never] })
      } catch (e) {
        error = e
      }
      expect(isBetterSchemicError(error)).toBe(true)
      expect((error as BetterSchemicError).code).toBe("PluginError")
      expect((error as BetterSchemicError).message).toContain("non-empty physical table name")
    }
  })

  test("a non-array tables option fails at the factory (a string would iterate chars)", () => {
    let error: unknown
    try {
      createOnlyGuard({ tables: "audit_log" as never })
    } catch (e) {
      error = e
    }
    expect(isBetterSchemicError(error)).toBe(true)
    expect((error as BetterSchemicError).message).toContain(
      "must be an array of physical table names",
    )
  })
})

describe("createOnlyGuard — hand-built pipelines + shared instances", () => {
  test("a hand-built pipeline lazily builds (and caches) the tag map", () => {
    const index = buildSchemaIndex(schema),
      pipeline = createPluginPipeline([createOnlyGuard()])!
    expect(() =>
      pipeline.transform(new RuntimeOperation("update", "audit_log", {}, {}, index)),
    ).toThrow(/create-only/)
    // The lazily-built map is cached: the hard tag survives the second (cached) lookup.
    expect(() =>
      pipeline.transform(new RuntimeOperation("update", "hard_audit", {}, {}, index)),
    ).toThrow(/hard guard event/)
  })

  test("one guard instance stays correct across schemas (per-index tags)", async () => {
    const guard = createOnlyGuard(),
      a = clientOver([guard]),
      { conn: oddConn, calls: oddCalls } = fakeConn((sql) => lines(sql).map(() => ok([]))),
      b = betterSchemic(oddConn, {
        schema: defineSchema({ plains: Plain }),
        plugins: [guard],
      })
    await b.plains.update({ where: { id: "plain:1" }, data: { name: "n" } })
    expect(oddCalls).toHaveLength(1)
    const blocked = await caught(async () =>
      a.client.logs.update({
        where: { id: "audit_log:1" },
        data: { action: "b" },
      }),
    )
    expect(isCreateOnlyViolation(blocked)).toBe(true)
  })
})
