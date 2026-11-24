/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- Object key order mirrors expected serialized output and must stay as authored. Mock fixtures pass untyped values to exercise runtime SQL emission. Fixtures use any for duck-typed mocks. Type queries and callback signatures need fixture values. */
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { relation, s, table } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

const User = table("user", { name: s.string(), email: s.string() })
const Agent = table("agent", { name: s.string(), model: s.string() })
const Knows = relation("knows", {}).from(User).to(User) // simplified
const schema = { users: User, agents: Agent, knows: Knows }

describe("graph match", () => {
  test("where match", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.users
      .from("user:A")
      .graph((g: any) => g.out(Knows).where((r: any) => r.match(User, (u: any) => u.name.eq("x"))))
    console.log("MATCHW:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("record::tb(id) = 'user'")
  })

  test("select match", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.users
      .from("user:A")
      .graph((g: any) =>
        g.out(Knows).select((r: any) => ({ email: r.match(User, (u: any) => u.email) })),
      )
    console.log("MATCHS:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("IF record::tb(id) = 'user' THEN email ELSE NONE END")
  })
})
