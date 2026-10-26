// M0.3 — result wrappers: `attachThrow` (thenable + `.throw()`), `BatchResult` and the
// `QueryResponse` -> `StatementResult` mapping used by the executor's raw multi-statement path.
import { describe, expect, test } from "bun:test"

import { ServerError } from "surrealdb"

import { BetterSchemicError, isNotFound } from "../../../src/surreal/orm/errors"
import { attachThrow, statementResult } from "../../../src/surreal/orm/results"

import type { BatchResult, ThrowingResult } from "../../../src/surreal/orm/results"

const info = { table: "user", operation: "findUnique" }

describe("attachThrow", () => {
  test("awaiting a miss yields null; `.throw()` throws ResultNotFound with the info", async () => {
    const result = attachThrow(Promise.resolve(null), info)
    expect(await result).toBeNull()

    const err = await result.throw().catch((error: unknown) => error)
    expect(err).toBeInstanceOf(BetterSchemicError)
    expect((err as BetterSchemicError).code).toBe("ResultNotFound")
    expect((err as Error).message).toContain("user: no record matched findUnique")
    expect((err as BetterSchemicError).table).toBe("user")
    expect((err as BetterSchemicError).operation).toBe("findUnique")
    expect(isNotFound(err)).toBe(true)
  })

  test("a `where` is summarized into the message and kept in `details`", async () => {
    const where = { email: "aeon@surreal.db" },
      result = attachThrow(Promise.resolve(null), { ...info, where }),
      err = (await result.throw().catch((error: unknown) => error)) as BetterSchemicError
    expect(err.message).toContain('matching {"email":"aeon@surreal.db"}')
    expect(err.details).toEqual(where)
  })

  test("a custom factory wins (and receives the info)", async () => {
    const result = attachThrow(Promise.resolve(undefined), info),
      err = (await result
        .throw((i) => new Error(`custom: ${i.table}`))
        .catch((error: unknown) => error)) as Error
    expect(err.message).toBe("custom: user")
    expect(err).not.toBeInstanceOf(BetterSchemicError)
  })

  test("a present value resolves through `.throw()`", async () => {
    const row = { id: "user:a" },
      result = attachThrow(Promise.resolve(row), info)
    expect(await result.throw()).toBe(row)
    expect(await result).toBe(row)
  })

  test("surql/vars flow into the thrown error", async () => {
    const result = attachThrow(Promise.resolve(null), {
        ...info,
        surql: "SELECT * FROM ONLY user:missing",
        vars: { p: 1 },
      }),
      err = (await result.throw().catch((error: unknown) => error)) as BetterSchemicError
    expect(err.surql).toBe("SELECT * FROM ONLY user:missing")
    expect(err.vars).toEqual({ p: 1 })
  })

  test("a lazy info factory is only evaluated on a miss", async () => {
    let calls = 0
    const hit = attachThrow(Promise.resolve(42), () => {
      calls++
      return info
    })
    expect(await hit.throw()).toBe(42)
    expect(calls).toBe(0)

    const miss = attachThrow(Promise.resolve(null), () => {
      calls++
      return info
    })
    await miss.throw().catch(() => {})
    expect(calls).toBe(1)
  })

  test("the wrapper is still a plain thenable (await/catch/finally work)", async () => {
    const result: ThrowingResult<number> = attachThrow(Promise.resolve(7), info)
    expect(await result.then((v) => (v ?? 0) * 2)).toBe(14)
  })
})

describe("BatchResult shape", () => {
  test("carries count, data, skipped and statements", () => {
    const batch: BatchResult<{ id: string }> = {
      count: 2,
      data: [{ id: "a" }, { id: "b" }],
      skipped: 1,
      statements: 3,
    }
    expect(batch.count).toBe(2)
    expect(batch.data).toHaveLength(2)
    expect(batch.statements).toBe(3)
  })
})

describe("statementResult — QueryResponse -> StatementResult", () => {
  test("a successful response maps to OK with the server time", () => {
    const duration = { toString: () => "1.2ms" },
      result = statementResult<number[]>({
        success: true,
        result: [1, 2],
        type: "other",
        stats: { duration } as never,
      })
    expect(result).toMatchObject({
      status: "OK",
      result: [1, 2],
      time: "1.2ms",
    })
    expect(result.error).toBeUndefined()
  })

  test("a failure response maps to ERR with the NORMALIZED error", () => {
    const server = new ServerError({
        kind: "AlreadyExists",
        message: "Database record `user:u1` already exists",
      }),
      result = statementResult<unknown[]>({
        success: false,
        error: server,
      })
    expect(result.status).toBe("ERR")
    expect(result.error).toBeInstanceOf(BetterSchemicError)
    expect(result.error?.code).toBe("RecordAlreadyExists")
    expect(result.time).toBeUndefined()
  })
})
