import type { QueryResponse, ServerError } from "surrealdb"

import type { Queryable } from "../../src/surreal/orm/execute"
import { KEEP_ORDER } from "../order-barrier"

/**
 * Shared ORM unit-test fixtures: SDK-shaped `QueryResponse` builders and a recording fake
 * connection. Kept in one place so every `/orm` unit suite answers statements the same way
 * (and a change in the SDK response shape breaks in ONE file, not five).
 */

/** A successful response (`type` requires it by the SDK union). */
export const ok = (result: unknown): QueryResponse => ({
  success: true,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  result,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  type: "other",
})

/** A failed response carrying a real SDK error. */
export const fail = (error: ServerError): QueryResponse => ({
  success: false,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  ...KEEP_ORDER,
  error,
})

/**
 * Await a thunk and return whatever it threw (`null` when it resolved) — for asserting teaching
 * errors, including the compile errors that throw at compile time (wrap the call in `() => …`).
 */
export const caught = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

/** The statement lines of a script (the executor separates them with `\n`). */
export const lines = (sql: string): string[] => sql.split("\n")

/** Answer every line with `ok(line)` — control statements included. */
export const echoLines = (sql: string): QueryResponse[] => lines(sql).map((line) => ok(line))

export type FakeCall = {
  readonly sql: string
  readonly vars?: Record<string, unknown>
}

export type FakeConn = Queryable & { closeCalls: number; closed: boolean }

/**
 * A fake connection that records every `query()` call and answers through `handler` (default:
 * one empty response per line). `close()` tracks it so lifecycle tests can assert the
 * BYO/managed rules.
 */
export function fakeConn(
  handler: (sql: string, vars?: Record<string, unknown>) => QueryResponse[] = (sql) =>
    lines(sql).map(() => ok(null)),
): { calls: FakeCall[]; conn: FakeConn } {
  const calls: FakeCall[] = []
  const conn = {
    closeCalls: 0,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    closed: false,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    query(
      sql: string,
      vars?: Record<string, unknown>,
    ): { responses: () => Promise<QueryResponse[]> } {
      calls.push({ sql, vars })
      return {
        responses: async (): Promise<QueryResponse[]> => {
          await Promise.resolve()
          return handler(sql, vars)
        },
      }
    },
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    close(): Promise<void> {
      conn.closeCalls++
      conn.closed = true
      return Promise.resolve()
    },
  }
  return {
    conn: conn as unknown as FakeConn,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    calls,
  }
}
