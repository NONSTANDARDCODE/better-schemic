/**
 * Shared ORM unit-test fixtures: SDK-shaped `QueryResponse` builders and a recording fake
 * connection. Kept in one place so every `/orm` unit suite answers statements the same way
 * (and a change in the SDK response shape breaks in ONE file, not five).
 */
import type { QueryResponse, ServerError } from "surrealdb";
import type { Queryable } from "../src/orm/execute";

/** A successful response (`type` is required by the SDK union). */
export const ok = (result: unknown): QueryResponse<unknown> => ({
  success: true,
  result,
  type: "other",
});

/** A failed response carrying a real SDK error. */
export const fail = (error: ServerError): QueryResponse<unknown> => ({
  success: false,
  error,
});

/** The statement lines of a script (the executor separates them with `\n`). */
export const lines = (sql: string): string[] => sql.split("\n");

/** Answer every line with `ok(line)` — control statements included. */
export const echoLines = (sql: string): QueryResponse<unknown>[] =>
  lines(sql).map((line) => ok(line));

export interface FakeCall {
  readonly sql: string;
  readonly vars?: Record<string, unknown>;
}

export type FakeConn = Queryable & { closeCalls: number; closed: boolean };

/**
 * A fake connection that records every `query()` call and answers through `handler` (default:
 * one empty response per line). `close()` is tracked so lifecycle tests can assert the
 * BYO/managed rules.
 */
export function fakeConn(
  handler: (
    sql: string,
    vars?: Record<string, unknown>,
  ) => QueryResponse<unknown>[] = (sql) => lines(sql).map(() => ok(null)),
): { conn: FakeConn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const conn = {
    closeCalls: 0,
    closed: false,
    query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return { responses: async () => handler(sql, vars) };
    },
    close() {
      conn.closeCalls++;
      conn.closed = true;
      return Promise.resolve();
    },
  };
  return { conn: conn as unknown as FakeConn, calls };
}
