/* eslint-disable perfectionist/sort-objects -- Object key order mirrors expected serialized output and must stay as authored. */
// Server-free SQL preview: `.toSQL()` on lazy reads and the compile-`delegate.$sql.<op>`.
// The preview derivs it from the SAME compiled statements the executor runs, so these goldens
// compare it against the script a real call captures — no hardcoded SQL, no connection for preview.
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { OrmError } from "../../../src/surreal/orm/errors"
import { definePlugin } from "../../../src/surreal/orm/plugins"
import { s, table } from "../../../src/surreal/pure"
import { fakeConn } from "../orm-fixtures"

const User = table("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
})

describe("SQL preview (server-free)", () => {
  test("read .toSQL() matches the script the real call sends, without a round-trip", async () => {
    const { conn, calls } = fakeConn()
    const client = orm(conn, { schema: { users: User } })

    const pending = client.users.findMany({
      where: { age: { gte: 18 } },
      orderBy: [{ age: "desc" }],
      limit: 10,
    })
    const preview = pending.toSQL()
    expect(calls).toHaveLength(0)
    expect(preview.operation).toBe("findMany")
    expect(preview.table).toBe("user")
    expect(preview.transactional).toBe(false)
    expect(preview.statements).toHaveLength(1)
    expect(preview.statements[0]?.vars).toEqual({ p0: 18, p1: 10 })

    await pending
    expect(calls).toHaveLength(1)
    expect(preview.script).toBe(calls[0]?.sql)
    expect(preview.statements[0]?.sql).toContain("SELECT * FROM user")
  })

  test("explain: true results are still previewable", async () => {
    const { conn, calls } = fakeConn()
    const client = orm(conn, { schema: { users: User } })
    // `explain: true` is eager (it runs EXPLAIN at call time) — `.toSQL()` adds no round-trip.
    const pending = client.users.findMany({ explain: true })
    const before = calls.length
    expect(pending.toSQL().script).toContain("SELECT * FROM user")
    expect(calls).toHaveLength(before)
    await pending
  })

  test("$withContext scopes are part of the previewed script", () => {
    const { conn, calls } = fakeConn()
    const client = orm(conn, { schema: { users: User } })
    const preview = client
      .$withContext({ namespace: "app", database: "main" })
      .users.findMany()
      .toSQL()
    expect(preview.script.startsWith("USE NS app DB main;\n")).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("write $sql preview is a true dry run (no connection, BEGIN/COMMIT included)", async () => {
    const { conn, calls } = fakeConn()
    const client = orm(conn, { schema: { users: User } })

    const preview = client.users.$sql.create({
      data: { name: "Aeon", age: 30, active: true },
    })
    expect(calls).toHaveLength(0)
    expect(preview.operation).toBe("create")
    expect(preview.transactional).toBe(false)

    await client.users.create({
      data: { name: "Aeon", age: 30, active: true },
    })
    expect(preview.script).toBe(calls[0]?.sql)
    expect(preview.statements[0]?.vars).toEqual(calls[0]?.vars ?? {})

    const batch = client.users.$sql.createMany({
      data: [
        { name: "A", age: 1, active: true },
        { name: "B", age: 2, active: false },
      ],
    })
    expect(batch.transactional).toBe(true)
    expect(batch.script).toContain("BEGIN TRANSACTION;")
    expect(calls).toHaveLength(1)
  })

  test("plugin transforms and guards apply to previews", () => {
    const { conn } = fakeConn()
    const deny = definePlugin({
      id: "test/deny-preview",
      transform(op) {
        if (op.table === "user" && op.kind === "findMany")
          throw new OrmError("ValidationError", "preview denied")
      },
    })
    const client = orm(conn, { schema: { users: User }, plugins: [deny] })
    expect(() => client.users.$sql.findMany()).toThrow("preview denied")
    expect(() => client.users.findMany()).toThrow("preview denied")
  })
})
