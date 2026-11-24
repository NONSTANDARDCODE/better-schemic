// M0.4 — the executor: one round-trip for N statements, per-statement status via `responses()`,
// implicit BEGIN/COMMIT for batches, first-failure attribution (statementIndex/surql/vars) and the
// unique-binds guardrail. All offline — the "connection" is a recording fake.
import { describe, expect, test } from "bun:test"
import { AlreadyExistsError, ServerError } from "surrealdb"

import { isOrmError } from "../../../src/surreal/orm/errors"
import { execute, type Queryable } from "../../../src/surreal/orm/execute"
import { echoLines, fail, fakeConn, lines, ok } from "../orm-fixtures"
const dup = (): AlreadyExistsError =>
  new AlreadyExistsError({
    kind: "AlreadyExists",
    message: "Database record `t:dup` already exists",
  })

describe("execute — one round-trip, order preserved", () => {
  test("N statements run in a single query call", async () => {
    const { calls, conn } = fakeConn(echoLines)
    const out = await execute<string>(conn, {
      operation: "findMany",
      statements: [{ sql: "SELECT 1" }, { sql: "SELECT 2" }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe("SELECT 1;\nSELECT 2;")
    expect(out.responses.map((r) => r.status)).toEqual(["OK", "OK"])
    expect(out.rows).toEqual(["SELECT 1;", "SELECT 2;"])
    expect(out.transactional).toBe(false)
  })

  test("an existing trailing semicolon is not duplicated", async () => {
    const { calls, conn } = fakeConn(echoLines)
    await execute(conn, { statements: [{ sql: "SELECT 1;" }] })
    expect(calls[0].sql).toBe("SELECT 1;")
  })

  test("zero statements never touch the connection", async () => {
    const { calls, conn } = fakeConn(echoLines)
    const out = await execute(conn, { statements: [] })
    expect(calls).toHaveLength(0)
    expect(out).toEqual({ responses: [], rows: [], transactional: false })
  })
})

describe("execute — implicit transactions", () => {
  test("wraps the batch in BEGIN/COMMIT and hides the control statements", async () => {
    const { calls, conn } = fakeConn(echoLines)
    const out = await execute<string>(conn, {
      operation: "createMany",
      statements: [{ sql: "CREATE a" }, { sql: "CREATE b" }],
      transactional: true,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe("BEGIN TRANSACTION;\nCREATE a;\nCREATE b;\nCOMMIT TRANSACTION;")
    expect(out.transactional).toBe(true)
    // Responses are the USER statements (BEGIN/COMMIT excluded, offsets honored).
    expect(out.rows).toEqual(["CREATE a;", "CREATE b;"])
  })

  test("skips the wrapper inside a transaction", async () => {
    const { calls, conn } = fakeConn(echoLines)
    const out = await execute(conn, {
      inTransaction: true,
      statements: [{ sql: "CREATE a" }],
      transactional: true,
    })
    expect(calls[0].sql).toBe("CREATE a;")
    expect(out.transactional).toBe(false)
  })
})

describe("execute — failure attribution", () => {
  test("throws the FIRST failure with its user-statement index, surql and context", async () => {
    const { conn } = fakeConn((sql) => {
      const out = lines(sql).map((line) => ok(line))
      out[1] = fail(dup())
      return out
    })

    const err = (await execute(conn, {
      operation: "createMany",
      statements: [{ sql: "CREATE t:a" }, { sql: "CREATE t:dup" }],
      table: "t",
    }).catch((error: unknown) => error)) as Error & {
      code: string
      operation: string
      statementIndex: number
      surql: string
      table: string
      vars: unknown
    }

    expect(isOrmError(err)).toBe(true)
    expect(err.code).toBe("RecordAlreadyExists")
    expect(err.statementIndex).toBe(1)
    expect(err.surql).toBe("CREATE t:dup")
    expect(err.operation).toBe("createMany")
    expect(err.table).toBe("t")
    expect(err.vars).toBeUndefined() // censored by default
  })

  test("debug: true attaches the failing statement's binds", async () => {
    const { conn } = fakeConn((sql) => {
      const out = lines(sql).map((line) => ok(line))
      out[0] = fail(dup())
      return out
    })
    const err = (await execute(conn, {
      debug: true,
      statements: [{ sql: "CREATE t:dup", vars: { p0: { a: 1 } } }],
    }).catch((error: unknown) => error)) as { vars?: unknown }
    expect(err.vars).toEqual({ p0: { a: 1 } })
  })

  test("a transactional batch reports the GENUINE failure, not the aborted statements", async () => {
    // Live shape (3.2.0): the abort marks the EARLIER statement as "not executed due to a failed
    // transaction" and fails COMMIT — the root cause is the statement that actually failed.
    const { conn } = fakeConn((sql) =>
      lines(sql).map((line) => {
        if (line.startsWith("COMMIT")) {
          return fail(
            new ServerError({
              kind: "Query",
              message: "Cannot COMMIT: the transaction was aborted due to a prior error",
            }),
          )
        }
        if (line.includes("dup")) return fail(dup())
        if (line.startsWith("CREATE")) {
          return fail(
            new ServerError({
              kind: "Query",
              message: "The query was not executed due to a failed transaction",
            }),
          )
        }
        return ok(null)
      }),
    )
    const err = (await execute(conn, {
      operation: "createMany",
      statements: [{ sql: "CREATE t:a" }, { sql: "CREATE t:dup" }],
      transactional: true,
    }).catch((error: unknown) => error)) as Error & {
      code: string
      statementIndex: number
    }
    expect(err.code).toBe("RecordAlreadyExists")
    expect(err.statementIndex).toBe(1)
  })

  test("throwOnError: false returns every StatementResult (ERR included)", async () => {
    const { conn } = fakeConn((sql) => {
      const out = lines(sql).map((line) => ok(line))
      out[1] = fail(dup())
      return out
    })
    const out = await execute<string>(conn, {
      statements: [{ sql: "CREATE t:a" }, { sql: "CREATE t:dup" }],
      throwOnError: false,
    })
    expect(out.responses.map((r) => r.status)).toEqual(["OK", "ERR"])
    expect(out.responses[1]?.error?.code).toBe("RecordAlreadyExists")
    expect(out.rows[1]).toBeUndefined()
  })
})

describe("execute — binds", () => {
  test("merges binds across statements", async () => {
    const { calls, conn } = fakeConn(echoLines)
    await execute(conn, {
      statements: [
        { sql: "SELECT 1", vars: { p0: true } },
        { sql: "SELECT 2", vars: { p1: 7 } },
      ],
    })
    expect(calls[0].vars).toEqual({ p0: true, p1: 7 })
  })

  test("rejects the same bind name with different values", async () => {
    const { conn } = fakeConn(echoLines)
    let caughtVoid0: unknown
    try {
      await execute(conn, {
        statements: [
          { sql: "CREATE a", vars: { p0: 1 } },
          { sql: "CREATE b", vars: { p0: 2 } },
        ],
      })
    } catch (error) {
      caughtVoid0 = error
    }
    expect(String(caughtVoid0)).toMatch(/duplicate bind "\$p0"/u)
  })

  test("the same bind reused with the SAME reference is fine", async () => {
    const shared = { a: 1 }
    const { calls, conn } = fakeConn(echoLines)
    await execute(conn, {
      statements: [
        { sql: "CREATE a", vars: { p0: shared } },
        { sql: "CREATE b", vars: { p0: shared } },
      ],
    })
    expect(calls[0].vars).toEqual({ p0: shared })
  })
})

describe("execute — protocol surprises and transport errors", () => {
  test("a response-count mismatch is a DatabaseError naming the script", async () => {
    const { conn } = fakeConn(() => [])
    const err = (await execute(conn, {
      operation: "findMany",
      statements: [{ sql: "SELECT 1" }],
    }).catch((error: unknown) => error)) as Error & { code: string; surql: string }
    expect(err.code).toBe("DatabaseError")
    expect(err.message).toMatch(/expected 1 statement responses, got 0/u)
    expect(err.surql).toBe("SELECT 1;")
  })

  test("a transport rejection is normalized with context", async () => {
    const conn = {
      query() {
        return {
          responses: async (): Promise<never> => {
            await Promise.resolve()
            throw new Error("connection lost")
          },
        }
      },
    } as unknown as Queryable
    const err = (await execute(conn, {
      operation: "findMany",
      statements: [{ sql: "SELECT 1" }],
    }).catch((error: unknown) => error)) as Error & { code: string; operation: string }
    expect(isOrmError(err)).toBe(true)
    expect(err.code).toBe("DatabaseError")
    expect(err.operation).toBe("findMany")
  })
})
