// M0.5 — the `/orm` bootstrap client: one delegate per schema key, `repository()` by key or
// Physical name, `tables`, schemaless entries, reserved-key collisions, `extends` fail-fast and the
// BYO no-op close rule. Offline — the "connection" is a recording fake.
import { describe, expect, test } from "bun:test"

import { betterSchemic } from "../../../src/surreal/orm/client"
import { BetterSchemicError, isBetterSchemicError } from "../../../src/surreal/orm/errors"
import { defineSchema } from "../../../src/surreal/orm/schema"
import {
  defineFunction,
  defineRelation,
  defineSingleton,
  defineTable,
  s,
} from "../../../src/surreal/pure"
import { fakeConn } from "../orm-fixtures"

import type { Client } from "../../../src/surreal/orm/client"
import type { Delegate } from "../../../src/surreal/orm/delegate"

const User = defineTable("user", { name: s.string(), age: s.int() }),
  Post = defineTable("post", {
    title: s.string(),
    author: s.recordId(User),
  }),
  Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post),
  Config = defineSingleton("config", { theme: s.string() }),
  greet = defineFunction("greet", { name: s.string() }).returns(s.string()),
  schema = defineSchema({
    users: User,
    posts: Post,
    likes: Likes,
    config: Config,
    greet,
    audit: "audit_log",
  })

describe("betterSchemic — delegates and lookup", () => {
  const { conn } = fakeConn(),
    client = betterSchemic(conn, { schema })

  test("every schema key with a table/relation/schemaless entry gets a delegate", () => {
    expect(client.users.$model).toMatchObject({
      key: "users",
      name: "user",
      kind: "table",
    })
    expect(client.likes.$model.kind).toBe("relation")
    expect(client.likes.$model.hasField("score")).toBe(true)
    expect(client.config.$model.singletonId).toBe("default")
  })

  test("a schemaless entry has a delegate with any-field access", () => {
    expect(client.audit.$model).toMatchObject({
      key: "audit",
      name: "audit_log",
      kind: "schemaless",
    })
    expect(client.audit.$model.hasField("anything")).toBe(true)
  })

  test("functions are NOT delegates yet (they land with client.fn in M5.2)", () => {
    expect("greet" in client).toBe(false)
    expect(client.tables).not.toContain("greet")
  })

  test("$model.hasField reflects the schema columns", () => {
    expect(client.users.$model.hasField("name")).toBe(true)
    expect(client.users.$model.hasField("nope")).toBe(false)
  })

  test("repository() resolves by schema key AND physical name to the SAME delegate", () => {
    const users = client.users as unknown as Delegate
    expect(client.repository("users")).toBe(users)
    expect(client.repository("user")).toBe(users)
    expect(client.repository("audit_log")).toBe(client.audit as unknown as Delegate)
  })

  test("repository() on an unknown name throws RepositoryNotFound", () => {
    const err = (() => {
      try {
        client.repository("nope")
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(isBetterSchemicError(err)).toBe(true)
    expect((err as BetterSchemicError).code).toBe("RepositoryNotFound")
    expect((err as Error).message).toContain("users")
  })

  test("tables lists the delegate keys", () => {
    expect([...client.tables].sort()).toEqual(["audit", "config", "likes", "posts", "users"])
  })

  test("$sdk is the wrapped connection", () => {
    expect(client.$sdk).toBe(conn)
    expect(client.$index.tables.size).toBe(4) // Typed tables/edges (audit is schemaless)
  })

  test("a plain literal schema (unbranded) works too", () => {
    const literal = betterSchemic(fakeConn().conn, { schema: { users: User } })
    expect(literal.users.$model.name).toBe("user")
    expect(literal.tables).toEqual(["users"])
  })

  test("the client is typed: Client<typeof schema> keys map to delegates", () => {
    const typed: Client<typeof schema> = client,
      delegate: Delegate<typeof User> = typed.users
    expect(delegate.$model.key).toBe("users")
  })
})

describe("betterSchemic — reserved keys fail fast", () => {
  const collision = (key: string, re = /collides with a client member/) => {
    const T = defineTable("t", { x: s.string() }),
      err = (() => {
        try {
          betterSchemic(fakeConn().conn, { schema: { [key]: T } as never })
          return undefined
        } catch (error) {
          return error
        }
      })()
    expect(err).toBeInstanceOf(BetterSchemicError)
    expect((err as BetterSchemicError).code).toBe("SchemaInvalid")
    expect((err as Error).message).toMatch(re)
  }

  test("a schema key shadowing a client member throws SchemaInvalid", () => {
    collision("close")
    collision("tables")
    collision("repository")
    collision("then")
  })

  test("a `$`-prefixed schema key is reserved", () => {
    collision("$raw")
  })
})

describe("betterSchemic — extends", () => {
  test("attaches helpers and returns them typed", () => {
    const client = betterSchemic(fakeConn().conn, { schema }),
      extended = client.extends({
        hello: () => "hi",
      })
    expect(extended.hello()).toBe("hi")
    expect(extended.users.$model.key).toBe("users")
  })

  test("a factory receives the client", () => {
    const client = betterSchemic(fakeConn().conn, { schema }),
      extended = client.extends((db) => ({
        countModels: () => db.tables.length,
      }))
    expect(extended.countModels()).toBe(5)
  })

  test("collisions (existing member, reserved name, or a prior helper) throw PluginError", () => {
    const client = betterSchemic(fakeConn().conn, { schema }),
      err = (() => {
        try {
          client.extends({ close: () => {} })
          return undefined
        } catch (error) {
          return error
        }
      })()
    expect((err as BetterSchemicError).code).toBe("PluginError")

    client.extends({ helper: 1 })
    expect(() => client.extends({ helper: 2 })).toThrow(/collides/)
    expect(() => client.extends({ $secret: 1 })).toThrow(/collides/)
  })
})

describe("lifecycle", () => {
  test("BYO close() is a NO-OP (never close the user's connection)", async () => {
    const { conn } = fakeConn(),
      client = betterSchemic(conn, { schema })
    await client.close()
    expect(conn.closeCalls).toBe(0)
    expect(conn.closed).toBe(false)
  })

  test("forkSession() without an SDK connection is UnsupportedCapability", async () => {
    const client = betterSchemic(fakeConn().conn, { schema }),
      err = (await client.forkSession().catch((error: unknown) => error)) as BetterSchemicError
    expect(err.code).toBe("UnsupportedCapability")
  })
})
