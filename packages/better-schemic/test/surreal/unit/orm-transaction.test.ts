import { describe, expect, test } from "bun:test"
import type { QueryResponse } from "surrealdb"

import { type Client, orm } from "../../../src/surreal/orm/client"
import { isOrmError, OrmError } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { caught, lines, ok } from "../orm-fixtures"

const MAGIC_150 = 150
const MAGIC_2 = 2
const MAGIC_200 = 200
const MAGIC_3 = 3
const MAGIC_42 = 42
const MAGIC_50 = 50
// M4.1 — `client.transaction`: the managed-transaction runtime over a recording fake. Covers
// commit/cancel, rollback, nested scope, afterCommit/afterRollback, retries, deadline, the
// `inTransaction` threading (batches skip their implicit BEGIN) and option validation.

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

type TxCall = {
  readonly sql: string
  readonly vars?: Record<string, unknown>
}

/** A fake managed transaction: records statements, counts commit/cancel. */
function fakeTx(): {
  calls: TxCall[]
  cancel(): Promise<void>
  cancelled: number
  commit(): Promise<void>
  committed: number
  query(sql: string, vars?: Record<string, unknown>): { responses: () => Promise<QueryResponse[]> }
} {
  const calls: TxCall[] = []
  const tx = {
    calls,
    cancel(): Promise<void> {
      tx.cancelled++
      return Promise.resolve()
    },
    cancelled: 0,
    commit(): Promise<void> {
      tx.committed++
      return Promise.resolve()
    },
    committed: 0,
    query(
      sql: string,
      vars?: Record<string, unknown>,
    ): { responses: () => Promise<QueryResponse[]> } {
      calls.push({ sql, vars })
      return {
        responses: async (): Promise<QueryResponse[]> => {
          await Promise.resolve()
          return lines(sql).map(() => ok([]))
        },
      }
    },
  }
  return tx
}

/** A fake root connection whose `beginTransaction()` hands back a fresh {@link fakeTx}. */
function fakeRoot(
  onBegin?: (count: number) => void,
  handler?: (sql: string, vars?: Record<string, unknown>) => QueryResponse[],
): {
  beginCalls: number
  beginTransaction(): Promise<{
    calls: TxCall[]
    cancel(): Promise<void>
    cancelled: number
    commit(): Promise<void>
    committed: number
    query(
      sql: string,
      vars?: Record<string, unknown>,
    ): { responses: () => Promise<QueryResponse[]> }
  }>
  query(sql: string, vars?: Record<string, unknown>): { responses: () => Promise<QueryResponse[]> }
  rootCalls: TxCall[]
  transactions: {
    calls: TxCall[]
    cancel(): Promise<void>
    cancelled: number
    commit(): Promise<void>
    committed: number
    query(
      sql: string,
      vars?: Record<string, unknown>,
    ): { responses: () => Promise<QueryResponse[]> }
  }[]
} {
  const rootCalls: TxCall[] = []
  const transactions: ReturnType<typeof fakeTx>[] = []
  const conn = {
    beginCalls: 0,
    beginTransaction(): Promise<{
      calls: TxCall[]
      cancel(): Promise<void>
      cancelled: number
      commit(): Promise<void>
      committed: number
      query(
        sql: string,
        vars?: Record<string, unknown>,
      ): { responses: () => Promise<QueryResponse[]> }
    }> {
      conn.beginCalls++
      onBegin?.(conn.beginCalls)
      const tx = fakeTx()
      transactions.push(tx)
      return Promise.resolve(tx)
    },
    query(
      sql: string,
      vars?: Record<string, unknown>,
    ): { responses: () => Promise<QueryResponse[]> } {
      rootCalls.push({ sql, vars })
      return {
        responses: async (): Promise<QueryResponse[]> => {
          await Promise.resolve()
          return handler ? handler(sql, vars) : lines(sql).map(() => ok([]))
        },
      }
    },
    rootCalls,
    transactions,
  }
  return conn
}

const clientOver = (
  conn: ReturnType<typeof fakeRoot>,
  transaction?: Parameters<typeof orm>[1]["transaction"],
): Client<typeof schemaDef, never> =>
  orm(conn as never, {
    schema: schemaDef,
    ...(transaction === undefined ? {} : { transaction }),
  })

const codeOf = (e: unknown): string | undefined => (isOrmError(e) ? e.code : undefined)

describe("client.transaction — commit/cancel/rollback", () => {
  test("success commits once, returns the callback value and runs delegates on the tx", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const value = await client.transaction(async (tx) => {
      await tx.users.findMany({ where: { name: "A" } })
      return MAGIC_42
    })
    expect(value).toBe(MAGIC_42)
    expect(conn.beginCalls).toBe(1)
    expect(conn.transactions[0]?.committed).toBe(1)
    expect(conn.transactions[0]?.cancelled).toBe(0)
    expect(conn.transactions[0]?.calls[0]?.sql).toBe("SELECT * FROM user WHERE name = $p0;")
    expect(conn.rootCalls).toHaveLength(0)
  })

  test("batches inside the transaction SKIP the implicit BEGIN/COMMIT wrapper", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    await client.transaction(async (tx) => {
      await tx.users.createMany({ data: [{ name: "A" }, { name: "B" }] })
    })
    const sql = conn.transactions[0]?.calls[0]?.sql ?? ""
    expect(sql).toContain('CREATE type::record(s"user", rand::ulid()) CONTENT $p0;')
    expect(sql).not.toContain("BEGIN TRANSACTION")
    expect(sql).not.toContain("COMMIT TRANSACTION")
  })

  test("an exception cancels, propagates and does NOT commit", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(async () => {
        await Promise.resolve()
        throw new OrmError("AssertionFailed", "nope")
      }),
    )
    expect(codeOf(err)).toBe("AssertionFailed")
    expect(conn.transactions[0]?.committed).toBe(0)
    expect(conn.transactions[0]?.cancelled).toBe(1)
  })

  test("tx.rollback(reason) cancels and rejects with TransactionRollback + details.reason", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await Promise.resolve()
        tx.rollback("saldo insuficiente")
        return "unreachable"
      }),
    )
    expect(codeOf(err)).toBe("TransactionRollback")
    expect((err as OrmError).details).toMatchObject({
      reason: "saldo insuficiente",
    })
    expect(conn.transactions[0]?.cancelled).toBe(1)
    expect(conn.transactions[0]?.committed).toBe(0)
  })

  test("a swallowed rollback signal still aborts (state is the source of truth)", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await Promise.resolve()
        try {
          tx.rollback("swallowed")
        } catch {
          // user code ignores the unwind
        }
        return "kept going"
      }),
    )
    expect(codeOf(err)).toBe("TransactionRollback")
    expect(conn.transactions[0]?.committed).toBe(0)
  })

  test("nested tx.transaction runs in the SAME transaction (no second begin)", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const out = await client.transaction(async (tx) => {
      const inner = await tx.transaction(async (inner) => {
        await inner.users.findMany()
        return "inner"
      })
      return inner
    })
    expect(out).toBe("inner")
    expect(conn.beginCalls).toBe(1)
    expect(conn.transactions[0]?.committed).toBe(1)
    expect(conn.transactions[0]?.calls).toHaveLength(1)
  })

  test("root re-entry while a transaction is active throws TransactionAlreadyActive", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(async () => {
        await client.transaction(async () => {
          await Promise.resolve()
          return "again"
        })
      }),
    )
    expect(codeOf(err)).toBe("TransactionAlreadyActive")
    expect(conn.beginCalls).toBe(1)
  })

  test("afterCommit runs after the commit; afterRollback on failure", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const events: string[] = []
    await client.transaction(async (tx) => {
      await Promise.resolve()
      tx.afterCommit(() => {
        events.push("commit")
      })
      tx.afterRollback(() => {
        events.push("rollback")
      })
      events.push("body")
    })
    expect(events).toEqual(["body", "commit"])
    const conn2 = fakeRoot()
    const client2 = clientOver(conn2)
    await caught(() =>
      client2.transaction(async (tx) => {
        await Promise.resolve()
        tx.afterCommit(() => {
          events.push("commit2")
        })
        tx.afterRollback((reason) => {
          events.push(`rollback2:${String(reason)}`)
        })
        throw new Error("boom")
      }),
    )
    expect(events).toEqual(["body", "commit", "rollback2:Error: boom"])
  })

  test("client.afterCommit reaches the CURRENT scope; outside a transaction it fails fast", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const events: string[] = []
    await client.transaction(async () => {
      await Promise.resolve()
      client.afterCommit(() => {
        events.push("root-scope")
      })
    })
    expect(events).toEqual(["root-scope"])
    const err = ((): unknown => {
      try {
        client.afterCommit(() => {
          /* empty */
        })
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(codeOf(err)).toBe("ValidationError")
    expect((err as Error).message).toContain("active transaction")
  })

  test("afterCommit/afterRollback fail once the transaction settled", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    let tx: undefined | { afterCommit(cb: () => void): void }
    await client.transaction(async (handle) => {
      await Promise.resolve()
      tx = handle
    })
    const err = ((): unknown => {
      try {
        tx?.afterCommit(() => {
          /* empty */
        })
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(codeOf(err)).toBe("ValidationError")
  })
})

describe("client.transaction — retries and deadline", () => {
  test("no retry by default: a WriteConflict propagates on the first attempt", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    let attempts = 0
    const err = await caught(() =>
      client.transaction(async () => {
        await Promise.resolve()
        attempts++
        throw new OrmError("WriteConflict", "conflict")
      }),
    )
    expect(codeOf(err)).toBe("WriteConflict")
    expect(attempts).toBe(1)
    expect(conn.beginCalls).toBe(1)
  })

  test("retries on writeConflict and re-runs the callback from scratch", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn, {
      retries: { attempts: 3, delayMs: (attempt) => attempt },
    })
    let attempts = 0
    const value = await client.transaction(async () => {
      await Promise.resolve()
      attempts++
      if (attempts < MAGIC_3) throw new OrmError("WriteConflict", "again")
      return "ok"
    })
    expect(value).toBe("ok")
    expect(attempts).toBe(MAGIC_3)
    expect(conn.beginCalls).toBe(MAGIC_3)
    // Every failed attempt cancells it; the last one committed.
    expect(conn.transactions.map((t) => t.cancelled)).toEqual([1, 1, 0])
    expect(conn.transactions.map((t) => t.committed)).toEqual([0, 0, 1])
  })

  test("a non-retryable failure is not retried even with attempts > 1", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn, { retries: { attempts: 5 } })
    let attempts = 0
    await caught(() =>
      client.transaction(async () => {
        await Promise.resolve()
        attempts++
        throw new OrmError("AssertionFailed", "no retry")
      }),
    )
    expect(attempts).toBe(1)
  })

  test("connectionError retry maps socket-style failures", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn, {
      retries: { attempts: 2, on: ["connectionError"] },
    })
    let attempts = 0
    const value = await client.transaction(async () => {
      await Promise.resolve()
      attempts++
      if (attempts === 1) throw new OrmError("DatabaseError", "connection reset by peer")
      return "recovered"
    })
    expect(value).toBe("recovered")
    expect(attempts).toBe(MAGIC_2)
  })

  test("timeout cancels the transaction and fails with DatabaseError details.timedOut", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(
        async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, MAGIC_200)
          })
          return "late"
        },
        { timeout: 20 },
      ),
    )
    expect(codeOf(err)).toBe("DatabaseError")
    expect((err as OrmError).details).toMatchObject({
      timedOut: true,
      timeoutMs: 20,
    })
    expect(conn.transactions[0]?.cancelled).toBe(1)
  })

  test("a timed-out transaction whose late commit fails still surfaces the timeout error", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const started = client.transaction(
      async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, MAGIC_50)
        })
        return "late"
      },
      { timeout: 10 },
    )
    // The managed tx creates it synchronously inside the call; a cancelled transaction can't
    // commit, so the late settle throws — exercising the `if (timedOut)` catch arm. The final
    // wait lets that background settle land inside this test (not after the process exits).
    conn.transactions[0].commit = (): Promise<void> => Promise.reject(new Error("cancelled"))
    const err = await caught(() => started)
    expect(codeOf(err)).toBe("DatabaseError")
    expect((err as OrmError).details).toMatchObject({
      timedOut: true,
    })
    expect(conn.transactions[0]?.cancelled).toBe(1)
    await new Promise((resolve) => {
      setTimeout(resolve, MAGIC_150)
    })
  })

  test("duration strings are accepted for timeout", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const value = await client.transaction(
      async () => {
        await Promise.resolve()
        return "fast"
      },
      {
        timeout: "1s",
      },
    )
    expect(value).toBe("fast")
  })
})

describe("client.transaction — options validation and unsupported features", () => {
  test("mode 'sql' fails fast with UnsupportedCapability", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const err = await caught(() =>
      client.transaction(
        async () => {
          await Promise.resolve()
          return "x"
        },
        {
          mode: "sql" as never,
        },
      ),
    )
    expect(codeOf(err)).toBe("UnsupportedCapability")
    expect((err as Error).message).toContain("sdk")
  })

  test("isolation honours onUnsupported: throw/warn/ignore", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const thrown = await caught(() =>
      client.transaction(
        async () => {
          await Promise.resolve()
          return "x"
        },
        {
          isolation: "snapshot",
          onUnsupported: "throw",
        },
      ),
    )
    expect(codeOf(thrown)).toBe("UnsupportedCapability")
    const ignored = await client.transaction(
      async () => {
        await Promise.resolve()
        return "x"
      },
      {
        isolation: "snapshot",
        onUnsupported: "ignore",
      },
    )
    expect(ignored).toBe("x")
  })

  test("invalid retry/timeout options throw ValidationError", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn)
    const cases = [
      { retries: { attempts: 0 } },
      { retries: { on: ["nope" as never] } },
      { retries: { delayMs: -1 } },
      { retries: { delayMs: "soon" as never } },
      { timeout: "30 minutes" },
      { timeout: -5 },
    ]
    await Promise.all(
      [...cases].map(async (options) => {
        const err = await caught(() =>
          client.transaction(async () => {
            await Promise.resolve()
            return "x"
          }, options),
        )
        expect(codeOf(err)).toBe("ValidationError")
      }),
    )
  })

  test("a connection without beginTransaction fails with UnsupportedCapability", async () => {
    const conn = fakeRoot()
    // Strip the managed transaction surface (an HTTP engine behaves like this).
    const bare = {
      query: conn.query.bind(conn),
    }
    const client = orm(bare as never, { schema: schemaDef })
    const err = await caught(() =>
      client.transaction(async () => {
        await Promise.resolve()
        return "x"
      }),
    )
    expect(codeOf(err)).toBe("UnsupportedCapability")
  })

  test("client-level defaults apply (retries/attempts) and are overridable per call", async () => {
    const conn = fakeRoot()
    const client = clientOver(conn, { retries: { attempts: 2 } })
    let attempts = 0
    const err = await caught(() =>
      client.transaction(
        async () => {
          await Promise.resolve()
          attempts++
          throw new OrmError("WriteConflict", "conflict")
        },
        { retries: { attempts: 1 } },
      ),
    )
    expect(codeOf(err)).toBe("WriteConflict")
    expect(attempts).toBe(1)
  })
})
