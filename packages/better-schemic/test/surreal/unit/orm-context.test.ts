import { describe, expect, test } from "bun:test"
import type { QueryResponse } from "surrealdb"

import { defineFunction, s, table } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import { isOrmError } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import { caught, fakeConn, ok } from "../orm-fixtures"

// M5.3 — `$withContext` (USE prefix, per-call override, session-bound fail-fast, auth overload),
// `extends` reapplication across clones/transactions and `forkSession` isolation. Offline — the
// "connection" is a recording fake (with optional session getters / fork support).

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

const echo = (sql: string): QueryResponse[] =>
  sql.split("\n").map((line): QueryResponse => ok(line))

describe("$withContext — prefix scope", () => {
  test("reads are prefixed with USE NS … DB … in the same round-trip", async () => {
    const { calls, conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await tenant.users.findMany()
    expect(calls[0]?.sql).toBe("USE NS tenant_a DB app;\nSELECT * FROM user;")
  })

  test("a missing side is inherited from the session", async () => {
    const { calls, conn } = fakeConn(echo)
    Object.assign(conn, { database: "app", namespace: "tenant_a" })
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({ namespace: "other" })
    await tenant.users.findMany()
    expect(calls[0]?.sql).toContain("USE NS other DB app;")
  })

  test("a per-call context overrides the clone", async () => {
    const { calls, conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await tenant.users.findMany({ context: { database: "analytics" } })
    expect(calls[0]?.sql).toContain("USE NS tenant_a DB analytics;")
  })

  test("no namespace/database anywhere is a teaching ValidationError", async () => {
    const { conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({ namespace: "tenant_a" })
    const error = await caught(() => tenant.users.findMany())
    expect(isOrmError(error) && error.code).toBe("ValidationError")
  })

  test("an unknown option fails fast", () => {
    const { conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    expect(() =>
      client.$withContext({
        database: "b",
        namespace: "a",
        nope: true,
      } as never),
    ).toThrow(/unknown option "nope"/u)
  })

  test("session-bound operations are rejected on a prefix clone", async () => {
    const { conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await Promise.all(
      [
        (): Promise<unknown> => tenant.api.get("/x"),
        (): Promise<void> => tenant.auth.invalidate(),
        (): Promise<string> => tenant.export(),
      ].map(async (call) => {
        const error = await caught(call)
        expect(isOrmError(error) && error.code).toBe("UnsupportedCapability")
      }),
    )
  })
})

describe("$withContext — auth overload", () => {
  test("forks a session, selects the scope and authenticates", async () => {
    const { conn } = fakeConn(echo)
    const used: unknown[] = []
    const tokens: unknown[] = []
    Object.assign(conn, {
      forkSession: () =>
        Promise.resolve({
          authenticate: async (token: unknown): Promise<unknown> => {
            await Promise.resolve()
            tokens.push(token)
            return token
          },
          closeSession: async (): Promise<void> => {
            /* empty */
          },
          database: "parent_db",
          namespace: "parent_ns",
          query: (sql: string): { responses: () => Promise<QueryResponse[]> } => ({
            responses: (): Promise<QueryResponse[]> => Promise.resolve(echo(sql)),
          }),
          use: async (what: unknown): Promise<unknown> => {
            await Promise.resolve()
            used.push(what)
            return what
          },
        }),
    })
    const client = orm(conn, { schema: schemaDef })
    const scoped = await client.$withContext({
      auth: "token-123",
      database: "app",
      namespace: "tenant_a",
    })
    expect(used).toEqual([{ database: "app", namespace: "tenant_a" }])
    expect(tokens).toEqual(["token-123"])
    // The scoped session is a SESSION (no prefix) — session-bound ops allow them.
    expect((scoped as unknown as { context?: unknown }).context).toBeUndefined()
  })
})

describe("fn — key guard", () => {
  test('a schema function key "call" fails fast at bootstrap', () => {
    const { conn } = fakeConn(echo)
    const Call = defineFunction("call")
    expect(() =>
      orm(conn, {
        schema: schema({ call: Call, users: User }),
      }),
    ).toThrow(/would shadow/u)
  })
})

describe("extends — reapplication", () => {
  test("helpers are re-applied on clones and inside transactions", async () => {
    const { conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef }).extends({
      helper: () => "ok",
    })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    expect((tenant as unknown as { helper: () => string }).helper()).toBe("ok")

    const txConn = {
      beginTransaction: (): Promise<{
        cancel: () => Promise<void>
        commit: () => Promise<void>
        query: (sql: string) => { responses: () => Promise<QueryResponse[]> }
      }> =>
        Promise.resolve({
          cancel: async (): Promise<void> => {
            /* empty */
          },
          commit: async (): Promise<void> => {
            /* empty */
          },
          query: (sql: string): { responses: () => Promise<QueryResponse[]> } => ({
            responses: (): Promise<QueryResponse[]> => Promise.resolve(echo(sql)),
          }),
        }),
      query: (sql: string): { responses: () => Promise<QueryResponse[]> } => ({
        responses: (): Promise<QueryResponse[]> => Promise.resolve(echo(sql)),
      }),
    }
    const txClient = orm(txConn as never, { schema: schemaDef }).extends({
      helper: () => "ok",
    })
    const inTx = await txClient.transaction(async (tx) => {
      await Promise.resolve()
      return (tx as unknown as { helper: () => string }).helper()
    })
    expect(inTx).toBe("ok")
  })

  test("a colliding helper fails fast", () => {
    const { conn } = fakeConn(echo)
    const client = orm(conn, { schema: schemaDef })
    expect(() => client.extends({ users: 1 })).toThrow(/collides/u)
  })
})
