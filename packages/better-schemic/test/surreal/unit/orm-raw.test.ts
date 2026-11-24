import { describe, expect, test } from "bun:test"
import { type QueryResponse, ServerError, surql } from "surrealdb"

import { s, table } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import { isOrmError } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import { caught, fail, fakeConn, ok } from "../orm-fixtures"

const MAGIC_18 = 18
const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_42 = 42
// M5.1 — the raw escape hatches: `$raw`/`$query`/`$unsafe`, parameterization, `throwOnError:false`,
// `raw.requireComment`/`raw.timeoutMs`, and the `USE NS … DB …` scope prefix. Offline — the
// "connection" is a recording fake.

const User = table("user", { name: s.string() })
const schemaDef = schema({ users: User })

const rawResult =
  (result: unknown): ((sql: string) => QueryResponse[]) =>
  (sql: string): QueryResponse[] => [ok(result), ...(sql.includes("USE ") ? [] : [])]

describe("raw — $raw", () => {
  test("a tagged template binds every value as $p<n>", async () => {
    const { calls, conn } = fakeConn(rawResult([{ id: "user:1" }]))
    const client = orm(conn, { schema: schemaDef })
    const rows = await client.$raw<
      { id: string }[]
    >`SELECT * FROM user WHERE name = ${"Aeon"} AND age > ${MAGIC_18}`

    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE name = $p0 AND age > $p1;")
    expect(calls[0]?.vars).toEqual({ p0: "Aeon", p1: 18 })
    expect(rows).toEqual([{ id: "user:1" }])
  })

  test("a string source takes options (timeout applied to a SELECT)", async () => {
    const { calls, conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    await client.$raw("SELECT * FROM user", { timeout: "5s" })
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 5s;")
  })

  test("a BoundQuery source keeps its binds", async () => {
    const { calls, conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    await client.$raw(surql`SELECT * FROM user WHERE name = ${"Aeon"}`)
    // A BoundQuery keeps its OWN bind names (the SDK tag already lowered them) — the counter is
    // process-global, so assert the shape + the bound value.
    expect(calls[0]?.sql).toMatch(/^SELECT \* FROM user WHERE name = \$bind__\d+;$/u)
    expect(Object.values(calls[0]?.vars ?? {})).toEqual(["Aeon"])
  })

  test("an invalid source is a teaching ValidationError", async () => {
    const { conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    const error = await caught(() => client.$raw(MAGIC_42 as never))
    expect(isOrmError(error) && error.code).toBe("ValidationError")
  })

  test("the curried options-tag binds options to a template", async () => {
    const { calls, conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    await client.$raw({ timeout: 500 })`SELECT * FROM user`
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 500ms;")
  })

  test("a multi-statement script is refused instead of silently dropping the rest", async () => {
    const { calls, conn } = fakeConn(() => [ok([null]), ok([1])])
    const client = orm(conn, { schema: schemaDef })
    // A leading `LET` used to resolve `null` with no error: $raw returned the FIRST result .
    const error = await caught(() => client.$raw`LET $a = 1; SELECT * FROM user;`)
    expect(isOrmError(error) && error.code).toBe("ValidationError")
    const text = (error as Error | undefined)?.message ?? ""
    expect(text).toContain("2 statements")
    expect(text).toContain("$query")
    expect(calls).toHaveLength(0)
  })

  test("a `;` inside a string literal is not a second statement", async () => {
    const { calls, conn } = fakeConn(rawResult("a;b"))
    const client = orm(conn, { schema: schemaDef })
    const out = await client.$raw`RETURN ${"a;b"}`
    expect(out).toBe("a;b")
    expect(calls).toHaveLength(1)
  })

  test("comments and a trailing `;` do not count as statements", async () => {
    const { conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    const value = await client.$raw`-- pick the user\nSELECT * FROM user;`
    expect(value).toBe(1)
  })
})

describe("raw — $query", () => {
  test("returns one result per statement", async () => {
    const { conn } = fakeConn(() => [ok([1]), ok([MAGIC_2])])
    const client = orm(conn, { schema: schemaDef })
    const out = await client.$query<[number[], number[]]>`SELECT * FROM user; SELECT * FROM post;`
    expect(out).toEqual([[1], [MAGIC_2]])
  })

  test("throwOnError:false returns the StatementResult envelopes", async () => {
    const error = new ServerError({ kind: "Query", message: "boom" })
    const { conn } = fakeConn(() => [fail(error)])
    const client = orm(conn, { schema: schemaDef })
    const out = await client.$query("SELECT * FROM nope", {
      throwOnError: false,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.status).toBe("ERR")
    expect(out[0]?.error?.code).toBe("DatabaseError")
  })

  test("the curried options-tag keeps throwOnError:false on a template", async () => {
    const error = new ServerError({ kind: "Query", message: "boom" })
    const { conn } = fakeConn(() => [fail(error)])
    const client = orm(conn, { schema: schemaDef })
    const out = await client.$query({
      throwOnError: false,
    })`SELECT * FROM nope`
    expect(out[0]?.status).toBe("ERR")
  })
})

describe("raw — $unsafe", () => {
  test("is disabled unless raw.unsafe is true", async () => {
    const { conn } = fakeConn(rawResult(1))
    const client = orm(conn, { schema: schemaDef })
    const error = await caught(() => client.$unsafe("SELECT 1"))
    expect(isOrmError(error) && error.code).toBe("UnsafeDisabled")
  })

  test("runs with raw.unsafe:true and binds params", async () => {
    const { calls, conn } = fakeConn(rawResult(1))
    const client = orm(conn, { raw: { unsafe: true }, schema: schemaDef })
    await client.$unsafe("SELECT * FROM user WHERE id = $id", { id: "user:1" })
    expect(calls[0]?.sql).toBe("SELECT * FROM user WHERE id = $id;")
    expect(calls[0]?.vars).toEqual({ id: "user:1" })
  })
})

describe("raw — defaults", () => {
  test("requireComment demands meta.comment on a write script", async () => {
    const { conn } = fakeConn(rawResult(1))
    const client = orm(conn, {
      raw: { requireComment: true },
      schema: schemaDef,
    })
    const error = await caught(() => client.$raw("DELETE user"))
    expect(isOrmError(error) && error.code).toBe("ValidationError")

    const { conn: okConn } = fakeConn(rawResult(1))
    const okClient = orm(okConn, {
      raw: { requireComment: true },
      schema: schemaDef,
    })
    await okClient.$raw("DELETE user", { meta: { comment: "cleanup" } })
    // A read-script is exempt.
    await okClient.$raw("SELECT * FROM user")

    // The curried tag is the template-form escape hatch for requireComment.
    const { calls, conn: tagConn } = fakeConn(rawResult(1))
    const tagClient = orm(tagConn, {
      raw: { requireComment: true },
      schema: schemaDef,
    })
    await tagClient.$raw({ meta: { comment: "seed" } })`DELETE user`
    expect(calls[0]?.sql).toBe("DELETE user;")
    const stillMissing = await caught(() => tagClient.$raw`DELETE user`)
    expect(isOrmError(stillMissing) && stillMissing.code).toBe("ValidationError")
  })

  test("timeoutMs applies to a single capable statement only", async () => {
    const { calls, conn } = fakeConn(rawResult(1))
    const client = orm(conn, { raw: { timeoutMs: 250 }, schema: schemaDef })
    await client.$raw("SELECT * FROM user")
    expect(calls[0]?.sql).toBe("SELECT * FROM user TIMEOUT 250ms;")

    const { calls: otherCalls, conn: other } = fakeConn(() => [ok(1), ok(MAGIC_2), ok(MAGIC_3)])
    const otherClient = orm(other, {
      raw: { timeoutMs: 250 },
      schema: schemaDef,
    })
    await otherClient.$query`LET $a = 1; LET $b = 2; RETURN $a;`
    expect(otherCalls[0]?.sql).not.toContain("TIMEOUT")
  })
})

describe("raw — context scope", () => {
  test("a $withContext clone prefixes USE NS … DB … in the same round-trip", async () => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map((line) => ok(line)))
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await tenant.$raw("SELECT * FROM user")
    expect(calls[0]?.sql).toBe("USE NS tenant_a DB app;\nSELECT * FROM user;")
  })

  test("an implicit batch wrapper is prefixed before BEGIN", async () => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map((line) => ok(line)))
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await tenant.users.createMany({ data: [{ name: "a" }, { name: "b" }] })
    const sql = calls[0]?.sql ?? ""
    expect(sql.startsWith("USE NS tenant_a DB app;\nBEGIN TRANSACTION;")).toBe(true)
    expect(sql.trimEnd().endsWith("COMMIT TRANSACTION;")).toBe(true)
  })

  test("a per-call context overrides the clone's database", async () => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map((line) => ok(line)))
    const client = orm(conn, { schema: schemaDef })
    const tenant = client.$withContext({
      database: "app",
      namespace: "tenant_a",
    })
    await tenant.users.findMany({ context: { database: "analytics" } })
    expect(calls[0]?.sql).toContain("USE NS tenant_a DB analytics;")
  })
})
