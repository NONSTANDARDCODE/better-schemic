const MAGIC_5 = 5
// M6.2 — `definePlugin`: transforms (mutate where/data/kind), operationArgs passthrough, hooks,
// extendClient/extendModel, setup fail-fast, per-delegate state and `$withoutPlugins`. Offline.

import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import type { Delegate } from "../../../src/surreal/orm/delegate"
import { isOrmError, OrmError } from "../../../src/surreal/orm/errors"
import {
  createPluginPipeline,
  definePlugin,
  isPlugin,
  RuntimeOperation,
} from "../../../src/surreal/orm/plugins"
import type { ThrowingResult } from "../../../src/surreal/orm/results"
import { schema } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { required } from "../../required"
import { type FakeCall, type FakeConn, fakeConn, lines, ok } from "../orm-fixtures"

const User = table("user", {
  flag: s.boolean().optional(),
  name: s.string(),
})
const schemaDef = schema({ users: User })

const row = (): { flag: boolean; id: RecordId<"user", number>; name: string }[] => [
  { flag: false, id: new RecordId("user", 1), name: "A" },
]

function conn(): { calls: FakeCall[]; conn: FakeConn } {
  return fakeConn((sql) => lines(sql).map(() => ok(row())))
}

describe("definePlugin — transforms", () => {
  test("a transform mutates data before compile", async () => {
    const timestamps = definePlugin({
      config: { createdAt: "createdAt" },
      id: "timestamps",
      transform(op) {
        if (op.kind === "create") op.data[this.config.createdAt] = surql`time::now()`
      },
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [timestamps], schema: schemaDef })
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.sql).toContain("createdAt: time::now()")
  })

  test("a transform can change the operation kind (delete -> update)", async () => {
    const softDelete = definePlugin({
      config: { column: "deletedAt" },
      id: "soft-delete",
      transform(op) {
        if (op.kind === "delete") {
          op.kind = "update"
          op.data[this.config.column] = surql`time::now()`
        }
      },
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [softDelete], schema: schemaDef })
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
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [stamper], schema: schemaDef })
    await client.users.create({ data: { name: "A" } })
    expect(calls[0]?.vars?.p0).toEqual({ name: "A" })
    calls.length = 0
    await client.users.$withState({ stamp: true }).create({ data: { name: "A" } })
    expect(calls[0]?.vars?.p0).toEqual({ flag: true, name: "A" })
  })

  test("$withoutPlugins skips transforms", async () => {
    const timestamps = definePlugin({
      id: "timestamps",
      transform(op) {
        if (op.kind === "create") op.data.createdAt = surql`time::now()`
      },
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [timestamps], schema: schemaDef })
    await client.users.$withoutPlugins().create({ data: { name: "A" } })
    expect(calls[0]?.sql).not.toContain("time::now()")
  })

  test("a transform returning false skips the operation", async () => {
    const skipper = definePlugin({
      id: "skipper",
      transform: () => false,
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [skipper], schema: schemaDef })
    const result = await client.users.findMany({})
    expect(result).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

describe("definePlugin — hooks and extensions", () => {
  test("a plugin's hooks are merged with the client's", async () => {
    const events: string[] = []
    const observer = definePlugin({
      hooks: {
        beforeQuery: () => {
          events.push("plugin")
        },
      },
      id: "observer",
    })
    const { conn: c } = conn()
    const client = orm(c, {
      hooks: {
        beforeQuery: () => {
          events.push("client")
        },
      },
      plugins: [observer],
      schema: schemaDef,
    })
    await client.users.findMany({})
    expect(events).toEqual(["client", "plugin"])
  })

  test("extendClient grafts methods onto the client", () => {
    const ext = definePlugin({
      extendClient() {
        return { hello: (): "hi" => "hi" }
      },
      id: "ext",
    })
    const { conn: c } = conn()
    const client = orm(c, { plugins: [ext], schema: schemaDef })
    expect((client as unknown as { hello(): string }).hello()).toBe("hi")
  })

  test("extendModel grafts methods onto every delegate (restore recipe)", async () => {
    const soft = definePlugin({
      config: { column: "deletedAt" },
      extendModel({ model }) {
        return {
          restore: (args: { where: unknown }): ThrowingResult<Record<string, unknown>> =>
            (model as Delegate).update({
              data: { [this.config.column]: null },
              mode: "set",
              where: args.where as never,
            }),
        }
      },
      id: "soft",
    })
    const { calls, conn: c } = conn()
    const client = orm(c, { plugins: [soft], schema: schemaDef })
    const delegate = client.users as unknown as {
      restore(args: { where: unknown }): Promise<unknown>
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
    })
    const { conn: c } = conn()
    orm(c, { plugins: [plugin], schema: schemaDef })
    expect(setups).toBe(1)
  })

  test("a duplicate plugin id fails fast with PluginError", () => {
    const plugin = definePlugin({ id: "dup" })
    const { conn: c } = conn()
    try {
      orm(c, { plugins: [plugin, plugin], schema: schemaDef })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect(isOrmError(error)).toBe(true)
      expect((error as { code: string }).code).toBe("PluginError")
    }
  })

  test("a throwing setup is wrapped in PluginError", () => {
    const plugin = definePlugin({
      id: "bad",
      setup() {
        throw new Error("misconfigured")
      },
    })
    const { conn: c } = conn()
    try {
      orm(c, { plugins: [plugin], schema: schemaDef })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect(isOrmError(error)).toBe(true)
      expect((error as { code: string }).code).toBe("PluginError")
    }
  })

  test("an extendClient collision fails fast", () => {
    const plugin = definePlugin({
      extendClient() {
        return { close: 1 }
      },
      id: "collide",
    })
    const { conn: c } = conn()
    try {
      orm(c, { plugins: [plugin], schema: schemaDef })
      throw new Error("expected a PluginError")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PluginError")
    }
  })
})

describe("plugin runtime — edge paths", () => {
  test("a non-string or empty plugin id fails fast", () => {
    expect(() => createPluginPipeline([{ id: "" } as never])).toThrow(/non-empty/u)
    expect(() => createPluginPipeline([{ id: 5 } as never])).toThrow(/non-empty/u)
  })

  test("a plugin without transform is skipped by the pipeline", () => {
    const pipeline = required(createPluginPipeline([definePlugin({ id: "noop" })]))
    expect(pipeline.hasTransforms).toBe(false)
    const op = new RuntimeOperation("create", "user", {}, {}, {} as never)
    expect(pipeline.transform(op)).toBe(false)
  })

  test("a OrmError thrown by a plugin method is returned unchanged", () => {
    const mine = new OrmError("PluginError", "custom")
    const plugin = definePlugin({
      id: "p",
      setup() {
        throw mine
      },
    })
    const pipeline = required(createPluginPipeline([plugin]))
    try {
      pipeline.setup({} as never)
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBe(mine)
    }
  })

  test("extendClient / extendModel failures wrap in PluginError", () => {
    const p = definePlugin({
      extendClient() {
        throw new Error("x")
      },
      extendModel() {
        throw new Error("y")
      },
      id: "p",
    })
    const pipeline = required(createPluginPipeline([p]))
    expect(() => pipeline.extendClient({} as never)).toThrow(/extendClient/u)
    expect(() => pipeline.extendModel({} as never, {})).toThrow(/extendModel/u)
  })

  test("RuntimeOperation proxies where/data/scope and commits only what changed", () => {
    const op = new RuntimeOperation(
      "create",
      "user",
      { data: { b: 2 }, scope: { e: 5 }, where: { a: 1 } },
      {},
      {} as never,
    )
    expect(op.where).toEqual({ a: 1 }) // existing args.where
    expect(op.data).toEqual({ b: 2 }) // existing args.data
    expect(op.scope).toEqual({ e: 5 }) // existing args.scope
    op.where = { c: 3 }
    op.data = { d: 4 }
    op.scope = { f: 6 }
    expect(op.where).toEqual({ c: 3 })
    expect(op.scope).toEqual({ f: 6 })
    op.commit()
    expect(op.args.where).toEqual({ c: 3 })
    expect(op.args.data).toEqual({ d: 4 })
    expect(op.args.scope).toEqual({ f: 6 })

    // A fresh op creates empty bags (and returns the SAME bag on re-read).
    const fresh = new RuntimeOperation("create", "user", {}, {}, {} as never)
    const bag = fresh.where
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
    expect(isPlugin(MAGIC_5)).toBe(false)
  })
})
