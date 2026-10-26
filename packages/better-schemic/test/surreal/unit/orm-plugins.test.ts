// M6.2 — `definePlugin`: transforms (mutate where/data/kind), operationArgs passthrough, hooks,
// ExtendClient/extendModel, setup fail-fast, per-delegate state and `$withoutPlugins`. Offline.
import { describe, expect, test } from "bun:test"

import { RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { betterSchemic } from "../../../src/surreal/orm/client"
import { BetterSchemicError, isBetterSchemicError } from "../../../src/surreal/orm/errors"
import {
  RuntimeOperation,
  createPluginPipeline,
  definePlugin,
  isPlugin,
} from "../../../src/surreal/orm/plugins"
import { defineSchema } from "../../../src/surreal/orm/schema"
import { defineTable, s } from "../../../src/surreal/pure"
import { fakeConn, lines, ok } from "../orm-fixtures"

import type { Delegate } from "../../../src/surreal/orm/delegate"

const User = defineTable("user", {
    name: s.string(),
    flag: s.boolean().optional(),
  }),
  schema = defineSchema({ users: User }),
  row = () => [{ id: new RecordId("user", 1), name: "A", flag: false }]

function conn() {
  return fakeConn((sql) => lines(sql).map(() => ok(row())))
}

describe("definePlugin — transforms", () => {
  test("a transform mutates data before compile", async () => {
    const timestamps = definePlugin({
        id: "timestamps",
        config: { createdAt: "createdAt" },
        transform(op) {
          if (op.kind === "create") op.data[this.config.createdAt] = surql`time::now()`
        },
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [timestamps] })
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
  })

  test("a transform can change the operation kind (delete -> update)", async () => {
    const softDelete = definePlugin({
        id: "soft-delete",
        config: { column: "deletedAt" },
        transform(op) {
          if (op.kind === "delete") {
            op.kind = "update"
            op.data[this.config.column] = surql`time::now()`
          }
        },
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [softDelete] })
    await client.users.delete({ where: { id: "user:1" } })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).not.toContain("DELETE")
  })

  test("a transform reads the delegate state set via $withState", async () => {
    const stamper = definePlugin({
        id: "stamper",
        transform(op) {
          if (op.state.stamp === true) op.data.flag = true
        },
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [stamper] })
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.vars?.p0).toEqual({ name: "A" })
    calls.length = 0
    await client.users.$withState({ stamp: true }).create({ data: { name: "A" } })
    expect(calls[0]?.vars?.p0).toEqual({ name: "A", flag: true })
  })

  test("$withoutPlugins skips transforms", async () => {
    const timestamps = definePlugin({
        id: "timestamps",
        transform(op) {
          if (op.kind === "create") op.data.createdAt = surql`time::now()`
        },
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [timestamps] })
    await client.users.$withoutPlugins().create({ data: { name: "A" } })
    expect(calls[0]?.sql).not.toContain("time::now()")
  })

  test("a transform returning false skips the operation", async () => {
    const skipper = definePlugin({
        id: "skipper",
        transform: () => false,
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [skipper] }),
      result = await client.users.findMany({})
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe("definePlugin — hooks and extensions", () => {
  test("a plugin's hooks are merged with the client's", async () => {
    const events: string[] = [],
      observer = definePlugin({
        id: "observer",
        hooks: {
          beforeQuery: () => {
            events.push("plugin")
          },
        },
      }),
      { conn: c } = conn(),
      client = betterSchemic(c, {
        schema,
        plugins: [observer],
        hooks: {
          beforeQuery: () => {
            events.push("client")
          },
        },
      })
    await client.users.findMany({})
    expect(events).toEqual(["client", "plugin"])
  })

  test("extendClient grafts methods onto the client", () => {
    const ext = definePlugin({
        id: "ext",
        extendClient() {
          return { hello: () => "hi" }
        },
      }),
      { conn: c } = conn(),
      client = betterSchemic(c, { schema, plugins: [ext] })
    expect((client as unknown as { hello: () => string }).hello()).toBe("hi")
  })

  test("extendModel grafts methods onto every delegate (restore recipe)", async () => {
    const soft = definePlugin({
        id: "soft",
        config: { column: "deletedAt" },
        extendModel({ model }) {
          return {
            restore: async (args: { where: unknown }) =>
              (model as Delegate).update({
                where: args.where as never,
                mode: "set",
                data: { [this.config.column]: null },
              }),
          }
        },
      }),
      { conn: c, calls } = conn(),
      client = betterSchemic(c, { schema, plugins: [soft] }),
      delegate = client.users as unknown as {
        restore: (args: { where: unknown }) => Promise<unknown>
      }
    await delegate.restore({ where: { id: "user:1" } })
    expect(calls[0]?.sql).toContain("UPDATE")
    expect(calls[0]?.sql).toContain("deletedAt = $p0")
    expect(calls[0]?.vars?.p0).toBeNull()
  })
})

describe("definePlugin — bootstrap validation", () => {
  test("setup runs exactly once at bootstrap", () => {
    let setups = 0
    const plugin = definePlugin({
        id: "setup",
        setup() {
          setups++
        },
      }),
      { conn: c } = conn()
    betterSchemic(c, { schema, plugins: [plugin] })
    expect(setups).toBe(1)
  })

  test("a duplicate plugin id fails fast with PluginError", () => {
    const plugin = definePlugin({ id: "dup" }),
      { conn: c } = conn()
    try {
      betterSchemic(c, { schema, plugins: [plugin, plugin] })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect(isBetterSchemicError(error)).toBe(true)
      expect((error as { code: string }).code).toBe("PluginError")
    }
  })

  test("a throwing setup is wrapped in PluginError", () => {
    const plugin = definePlugin({
        id: "bad",
        setup() {
          throw new Error("misconfigured")
        },
      }),
      { conn: c } = conn()
    try {
      betterSchemic(c, { schema, plugins: [plugin] })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect(isBetterSchemicError(error)).toBe(true)
      expect((error as { code: string }).code).toBe("PluginError")
    }
  })

  test("an extendClient collision fails fast", () => {
    const plugin = definePlugin({
        id: "collide",
        extendClient() {
          return { close: 1 }
        },
      }),
      { conn: c } = conn()
    try {
      betterSchemic(c, { schema, plugins: [plugin] })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PluginError")
    }
  })
})

describe("plugin runtime — edge paths", () => {
  test("a non-string or empty plugin id fails fast", () => {
    expect(() => createPluginPipeline([{ id: "" } as never])).toThrow(/non-empty/)
    expect(() => createPluginPipeline([{ id: 5 } as never])).toThrow(/non-empty/)
  })

  test("a plugin without transform is skipped by the pipeline", () => {
    const pipeline = createPluginPipeline([definePlugin({ id: "noop" })])!
    expect(pipeline.hasTransforms).toBe(false)
    const op = new RuntimeOperation("create", "user", {}, {}, {} as never)
    expect(pipeline.transform(op)).toBe(false)
  })

  test("a BetterSchemicError thrown by a plugin method is returned unchanged", () => {
    const mine = new BetterSchemicError("PluginError", "custom"),
      plugin = definePlugin({
        id: "p",
        setup() {
          throw mine
        },
      }),
      pipeline = createPluginPipeline([plugin])!
    try {
      pipeline.setup({} as never)
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBe(mine)
    }
  })

  test("extendClient / extendModel failures wrap in PluginError", () => {
    const p = definePlugin({
        id: "p",
        extendClient() {
          throw new Error("x")
        },
        extendModel() {
          throw new Error("y")
        },
      }),
      pipeline = createPluginPipeline([p])!
    expect(() => pipeline.extendClient({} as never)).toThrow(/extendClient/)
    expect(() => pipeline.extendModel({} as never, {})).toThrow(/extendModel/)
  })

  test("RuntimeOperation proxies where/data/scope and commits only what changed", () => {
    const op = new RuntimeOperation(
      "create",
      "user",
      { where: { a: 1 }, data: { b: 2 }, scope: { e: 5 } },
      {},
      {} as never,
    )
    expect(op.where).toEqual({ a: 1 }) // Existing args.where
    expect(op.data).toEqual({ b: 2 }) // Existing args.data
    expect(op.scope).toEqual({ e: 5 }) // Existing args.scope
    op.where = { c: 3 }
    op.data = { d: 4 }
    op.scope = { f: 6 }
    expect(op.where).toEqual({ c: 3 })
    expect(op.scope).toEqual({ f: 6 })
    op.commit()
    expect(op.args.where).toEqual({ c: 3 })
    expect(op.args.data).toEqual({ d: 4 })
    expect(op.args.scope).toEqual({ f: 6 })

    // A fresh op lazily creates empty bags (and returns the SAME bag on re-read).
    const fresh = new RuntimeOperation("create", "user", {}, {}, {} as never),
      bag = fresh.where
    expect(bag).toEqual({})
    expect(fresh.where).toBe(bag)
    expect(fresh.data).toEqual({})
    const scopeBag = fresh.scope
    expect(scopeBag).toEqual({})
    expect(fresh.scope).toBe(scopeBag)
    fresh.commit()
    expect(fresh.args.scope).toBe(scopeBag)
    // A transform that never touches `scope` does not inject an empty bag.
    const untouched = new RuntimeOperation("create", "user", {}, {}, {} as never)
    untouched.commit()
    expect("scope" in untouched.args).toBe(false)
  })

  test("isPlugin brand check", () => {
    expect(isPlugin(definePlugin({ id: "p" }))).toBe(true)
    expect(isPlugin({})).toBe(false)
    expect(isPlugin(null)).toBe(false)
    expect(isPlugin(5)).toBe(false)
  })
})
