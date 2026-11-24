const _MAGIC_2 = 2
import { defineConfig } from "better-schemic/config"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

import type { ChainedConfig } from "../../../src/core/config"
import type { ConnectionEntry } from "../../../src/core/connection"
import { surrealConnection } from "../../../src/surreal/connection"
import type { Client } from "../../../src/surreal/orm/client"

const MAGIC_120000 = 120_000

// The CHAINED defineConfig form (core ac74d90) with surrealConnection as the driver marker:
// .connection(name, surrealConnection, static | (ctx, args) => config|config[]) — the resolver's
// ctx.connections types it with the ACCUMULATED prior connections, each thenable to a full Client.

// The workspace gate runs every package's suite IN PARALLEL — parallel-suite CPU contention can slow live
// connects/DDL far past bun's 30s default, timing out beforeAll/afterAll hooks (reported as
// "(unnamed)" tests). Live work gets a generous ceiling; isolated runs unaffect them.
setDefaultTimeout(MAGIC_120000)

const base = {
  authLevel: "root" as const,
  password: process.env.SURREAL_PASS ?? "root",
  schema: "./x",
  url: "ws://127.0.0.1:8000/rpc",
  username: process.env.SURREAL_USER ?? "root",
}

const orm = defineConfig()
  .connection("main", surrealConnection, {
    ...base,
    database: "app",
    namespace: "chain_main",
  })
  .connection("tenant", surrealConnection, async (ctx, args: { org?: string }) => {
    if (args.org) return { ...base, database: "app", namespace: `chain_t_${args.org}` }
    // The typed path: the prior connection handle exposes `query()` (and is thenable to its
    // full ORM client).
    const orgs = await ctx.connections.main.query<{ slug: string }>("SELECT slug FROM chain_org")
    return orgs.map((o) => ({
      ...base,
      database: "app",
      key: o.slug,
      namespace: `chain_t_${o.slug}`,
    }))
  })

// --- type-level assertions -----------------------------------------------------------------------
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

// connect() types per entry: main takes no args; tenant takes { org?: string }.
type MainClient = Awaited<ReturnType<typeof orm.connect<"main">>>
type _mainClient = Expect<Equal<MainClient, Client>>

const _typedCtx = (): ChainedConfig<
  Record<never, never> & Record<"a", ConnectionEntry<Client>> & Record<"b", ConnectionEntry<Client>>
> =>
  defineConfig()
    .connection("a", surrealConnection, {
      ...base,
      database: "d",
      namespace: "n",
    })
    .connection("b", surrealConnection, async (ctx) => {
      const a = await ctx.connections.a // typed: the surreal Client
      const _c: Client = a
      // @ts-expect-error — forward/self reference: "b" is not visible in its own resolver
      const _probe_73 = ctx.connections.b
      return { ...base, database: "d", namespace: "n2" }
    })

const _argsTyping = (): void => {
  void orm.connect("tenant", { org: "acme" })
  // @ts-expect-error — wrong args shape for tenant
  void orm.connect("tenant", { org: 5 })
  // @ts-expect-error — unknown connection name
  void orm.connect("nope")
}

describe("chained defineConfig with surrealConnection as the driver marker", () => {
  test("the chain accumulates entries with the surreal driver tag", () => {
    expect(Object.keys(orm.connections)).toEqual(["main", "tenant"])
    expect(orm.connections.main.driver).toBe("surrealdb")
    expect(orm.connections.tenant.driver).toBe("surrealdb")
    expect(typeof orm.connections.tenant.client).toBe("function")
    expect(typeof orm.connections.main.label).toBe("function")
  })

  test("a chained parameterized resolver receives its typed args", async () => {
    const ctx = { connections: {}, env: process.env }
    const bases = await orm.connections.tenant.resolve(ctx, {
      org: "acme",
    })
    expect(bases).toHaveLength(1)
    expect((bases[0] as { namespace?: string }).namespace).toBe("chain_t_acme")
  })
})
