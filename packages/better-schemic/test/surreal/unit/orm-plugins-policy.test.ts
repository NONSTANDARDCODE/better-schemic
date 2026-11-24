import { describe, expect, test } from "bun:test"
import type { ZodString } from "zod"

import { orm } from "../../../src/surreal/orm/client"
import { isOrmError, isPolicyViolation, type OrmErrorCode } from "../../../src/surreal/orm/errors"
import type { Client } from "../../../src/surreal/orm/types/client"
import type { Plugin } from "../../../src/surreal/orm/types/plugins"
import { definePolicy, type PolicyRule } from "../../../src/surreal/plugins/policy"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"
import type { FakeConn } from "../../../test/surreal/orm-fixtures"
import { caught, type FakeCall, fakeConn, ok } from "../orm-fixtures"

// `plugins/policy` — declarative deny/scope/require rules enforced in the transform pipeline, before
// compilation. The DB permission remains the boundary; `$withoutPlugins()` is the explicit escape.

const User = table("user", {
  name: s.string(),
  org: s.string(),
  role: s.string(),
})
const Post = table("post", { title: s.string() })
const schemaDef = { posts: Post, users: User }

const clientOver = (
  rules: readonly PolicyRule<"posts" | "users">[],
): {
  calls: FakeCall[]
  client: Client<
    {
      posts: TableDef<"post", WithSmartId<"post", { title: SField<ZodString> }>>
      users: TableDef<
        "user",
        WithSmartId<
          "user",
          {
            name: SField<ZodString>
            org: SField<ZodString>
            role: SField<ZodString>
          }
        >
      >
    },
    FakeConn,
    readonly [Plugin]
  >
} => {
  const { calls, conn } = fakeConn(() => [ok([])])
  return {
    calls,
    client: orm(conn, {
      plugins: [definePolicy(schemaDef, { rules })],
      schema: schemaDef,
    }),
  }
}

const codeOf = (e: unknown): OrmErrorCode | undefined => (isOrmError(e) ? e.code : undefined)

describe("definePolicy()", () => {
  test("deny rejects a matching operation before any SQL is sent", async () => {
    const { calls, client } = clientOver([
      { effect: "deny", operations: ["delete"], tables: ["users"] },
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
    const { calls, client } = clientOver([
      {
        effect: "deny",
        fields: ["role"],
        operations: ["update"],
        tables: ["users"],
      },
    ])
    expect(
      codeOf(
        await caught(() =>
          client.users.update({
            data: { role: "admin" },
            where: { id: "user:1" },
          }),
        ),
      ),
    ).toBe("PolicyDenied")
    await client.users.update({
      data: { name: "Aeon" },
      where: { id: "user:1" },
    })
    expect(calls).toHaveLength(1)
  })

  test("scope injects a filter ANDed by the compiler into reads AND writes", async () => {
    const { calls, client } = clientOver([
      {
        effect: "scope",
        filter: { org: "acme" },
        tables: ["users"],
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
    const { client } = clientOver([{ effect: "require", require: "actor", tables: ["users"] }])
    expect(codeOf(await caught(() => client.users.findMany()))).toBe("PolicyRequired")
    await client.users.findMany({ meta: { actor: "agent:1" } })
  })

  test("$withoutPlugins() escapes the client-side guard", async () => {
    const { calls, client } = clientOver([
      { effect: "deny", operations: ["delete"], tables: ["users"] },
    ])
    await client.users.$withoutPlugins().delete({ where: { id: "user:1" } })
    expect(calls).toHaveLength(1)
  })

  test("a mistyped field fails fast at bootstrap", () => {
    const { conn } = fakeConn()
    expect(() =>
      orm(conn, {
        plugins: [
          definePolicy(schemaDef, {
            rules: [{ effect: "scope", filter: { orgz: "x" }, tables: ["users"] }],
          }),
        ],
        schema: schemaDef,
      }),
    ).toThrow("orgz")
  })

  test("a malformed rule fails fast at bootstrap", () => {
    const { conn } = fakeConn()
    expect(() =>
      orm(conn, {
        plugins: [
          definePolicy(schemaDef, {
            rules: [{ effect: "scope", tables: ["users"] }],
          }),
        ],
        schema: schemaDef,
      }),
    ).toThrow("scope")
  })
})
