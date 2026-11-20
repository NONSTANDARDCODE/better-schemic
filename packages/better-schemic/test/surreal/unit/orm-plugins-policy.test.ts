// `plugins/policy` — declarative deny/scope/require rules enforced in the transform pipeline, before
// compilation. The DB permission remains the boundary; `$withoutPlugins()` is the explicit escape.
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { isOrmError, isPolicyViolation, type OrmError } from "../../../src/surreal/orm/errors"
import { definePolicy, type PolicyRule } from "../../../src/surreal/plugins/policy"
import { s, table } from "../../../src/surreal/pure"
import { caught, fakeConn, ok } from "../orm-fixtures"

const User = table("user", {
  name: s.string(),
  org: s.string(),
  role: s.string(),
})
const Post = table("post", { title: s.string() })
const schemaDef = { users: User, posts: Post }

const clientOver = (rules: readonly PolicyRule<"posts" | "users">[]) => {
  const { conn, calls } = fakeConn(() => [ok([])])
  return {
    client: orm(conn, {
      schema: schemaDef,
      plugins: [definePolicy(schemaDef, { rules })],
    }),
    calls,
  }
}

const codeOf = (e: unknown) => (isOrmError(e) ? (e as OrmError).code : undefined)

describe("definePolicy()", () => {
  test("deny rejects a matching operation before any SQL is sent", async () => {
    const { client, calls } = clientOver([
      { tables: ["users"], operations: ["delete"], effect: "deny" },
    ])
    const err = await caught(() => client.users.delete({ where: { id: "user:1" } }))
    expect(codeOf(err)).toBe("PolicyDenied")
    expect(isPolicyViolation(err)).toBe(true)
    expect(calls).toHaveLength(0)
    // A different table/operation passes through.
    await client.posts.deleteMany({ all: true })
    expect(calls).toHaveLength(1)
  })

  test("field-scoped deny only fires when the write touches that field", async () => {
    const { client, calls } = clientOver([
      {
        tables: ["users"],
        operations: ["update"],
        fields: ["role"],
        effect: "deny",
      },
    ])
    expect(
      codeOf(
        await caught(() =>
          client.users.update({
            where: { id: "user:1" },
            data: { role: "admin" },
          }),
        ),
      ),
    ).toBe("PolicyDenied")
    await client.users.update({
      where: { id: "user:1" },
      data: { name: "Aeon" },
    })
    expect(calls).toHaveLength(1)
  })

  test("scope injects a filter ANDed by the compiler into reads AND writes", async () => {
    const { client, calls } = clientOver([
      {
        tables: ["users"],
        effect: "scope",
        filter: { org: "acme" },
      },
    ])
    const pending = client.users.findMany()
    const preview = pending.toSQL()
    expect(preview.statements[0]?.sql).toContain("WHERE org = $p0")
    expect(preview.statements[0]?.vars).toEqual({ p0: "acme" })
    expect(calls).toHaveLength(0)
    await pending
    expect(calls).toHaveLength(1)
  })

  test("require fails closed without the actor in meta", async () => {
    const { client } = clientOver([{ tables: ["users"], effect: "require", require: "actor" }])
    expect(codeOf(await caught(() => client.users.findMany()))).toBe("PolicyRequired")
    await client.users.findMany({ meta: { actor: "agent:1" } })
  })

  test("$withoutPlugins() escapes the client-side guard", async () => {
    const { client, calls } = clientOver([
      { tables: ["users"], operations: ["delete"], effect: "deny" },
    ])
    await client.users.$withoutPlugins().delete({ where: { id: "user:1" } })
    expect(calls).toHaveLength(1)
  })

  test("a mistyped field fails fast at bootstrap", () => {
    const { conn } = fakeConn()
    expect(() =>
      orm(conn, {
        schema: schemaDef,
        plugins: [
          definePolicy(schemaDef, {
            rules: [{ tables: ["users"], effect: "scope", filter: { orgz: "x" } }],
          }),
        ],
      }),
    ).toThrow("orgz")
  })

  test("a malformed rule fails fast at bootstrap", () => {
    const { conn } = fakeConn()
    expect(() =>
      orm(conn, {
        schema: schemaDef,
        plugins: [
          definePolicy(schemaDef, {
            rules: [{ tables: ["users"], effect: "scope" }],
          }),
        ],
      }),
    ).toThrow("scope")
  })
})
