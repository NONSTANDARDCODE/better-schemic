// M0.4 — executor against a REAL server + the SDK's `responses()` path (the offset mapping with
// BEGIN/COMMIT and the abort-on-failure atomicity are the load-bearing assumptions here).
// Skipped automatically when no `surreal` binary is available.
import { setDefaultTimeout } from "bun:test"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { Surreal } from "surrealdb"

import { spawnEphemeralServer, surrealBinaryAvailable } from "../../../src/surreal/cli/engine"
import { isBetterSchemicError, isUniqueViolation } from "../../../src/surreal/orm/errors"
import { execute } from "../../../src/surreal/orm/execute"

import type { EphemeralServer } from "../../../src/surreal/cli/engine"

setDefaultTimeout(120_000)

const ENABLED = surrealBinaryAvailable(),
  live = describe.skipIf(!ENABLED)
if (!ENABLED) console.warn("[orm-execute] `surreal` binary unavailable — skipping")

live("executor — live probes", () => {
  let db: Surreal, server: EphemeralServer

  const value = async <T>(sql: string): Promise<T> => {
      const out = (await db.query(sql)) as unknown[]
      return out.at(-1) as T
    },
    /** `SELECT VALUE id …` normalized to plain id strings (the SDK returns RecordId objects). */
    ids = async (sql: string): Promise<string[]> => (await value<unknown[]>(sql)).map(String)

  beforeAll(async () => {
    server = await spawnEphemeralServer()
    db = new Surreal()
    await db.connect(server.url, { reconnect: false })
    await db.signin({ username: server.username, password: server.password })
    await db.use({ namespace: "orm_execute", database: "live" })
  })

  afterAll(async () => {
    await db?.close().catch(() => {})
    await server?.stop()
  })

  test("one statement resolves its result", async () => {
    const out = await execute<number>(db, {
      statements: [{ sql: "RETURN 1" }],
    })
    expect(out.rows).toEqual([1])
    expect(out.responses[0]).toMatchObject({ status: "OK" })
  })

  test("N statements ride ONE query call, in order", async () => {
    const out = await execute<number>(db, {
      statements: [{ sql: "RETURN 1" }, { sql: "RETURN 2" }, { sql: "RETURN 3" }],
    })
    expect(out.rows).toEqual([1, 2, 3])
    expect(out.responses.map((r) => r.status)).toEqual(["OK", "OK", "OK"])
  })

  test("a transactional batch persists every statement", async () => {
    const out = await execute(db, {
      statements: [
        { sql: "CREATE ex_tx:a CONTENT { n: 1 }" },
        { sql: "CREATE ex_tx:b CONTENT { n: 2 }" },
      ],
      transactional: true,
      operation: "createMany",
    })
    expect(out.transactional).toBe(true)
    expect(await ids("SELECT VALUE id FROM ex_tx ORDER BY id")).toEqual(["ex_tx:a", "ex_tx:b"])
  })

  test("a failing statement aborts the transactional batch (nothing persists)", async () => {
    await db.query("CREATE ex_abort:dup CONTENT { n: 0 };")
    const err = (await execute(db, {
      statements: [
        { sql: "CREATE ex_abort:first CONTENT { n: 1 }" },
        { sql: "CREATE ex_abort:dup CONTENT { n: 2 }" },
      ],
      transactional: true,
      operation: "createMany",
      table: "ex_abort",
    }).catch((error: unknown) => error)) as Error & {
      code: string
      statementIndex: number
    }

    expect(isBetterSchemicError(err)).toBe(true)
    expect(isUniqueViolation(err)).toBe(true)
    expect(err.statementIndex).toBe(1)
    // The first CREATE was rolled back by the aborted transaction.
    expect(await ids("SELECT VALUE id FROM ex_abort")).toEqual(["ex_abort:dup"])
  })

  test("throwOnError: false surfaces the per-statement ERR (and the rest still runs)", async () => {
    await db.query("CREATE ex_partial:dup CONTENT { n: 0 };")
    const out = await execute(db, {
      statements: [
        { sql: "CREATE ex_partial:ok CONTENT { n: 1 }" },
        { sql: "CREATE ex_partial:dup CONTENT { n: 2 }" },
        { sql: "CREATE ex_partial:ok2 CONTENT { n: 3 }" },
      ],
      throwOnError: false,
    })
    expect(out.responses.map((r) => r.status)).toEqual(["OK", "ERR", "OK"])
    expect(out.responses[1]?.error?.code).toBe("RecordAlreadyExists")
    expect(await ids("SELECT VALUE id FROM ex_partial ORDER BY id")).toEqual([
      "ex_partial:dup",
      "ex_partial:ok",
      "ex_partial:ok2",
    ])
  })

  test("binds merge across statements and land on the right values", async () => {
    const out = await execute<number>(db, {
      statements: [
        { sql: "RETURN $p0", vars: { p0: 11 } },
        { sql: "RETURN $p1", vars: { p1: 22 } },
      ],
    })
    expect(out.rows).toEqual([11, 22])
  })
})
