/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-meaningless-void-operator, @typescript-eslint/no-explicit-any, unicorn/consistent-function-scoping, @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/explicit-function-return-type -- Object key order mirrors expected serialized output and must stay as authored. Literal values are intentional test data and must stay as authored. The void operator discards intentionally unused type-probe values. Fixtures use any for duck-typed mocks. Helpers stay colocated with the tests that use them. Mock methods match async interfaces without awaiting. The void operator discards intentionally ignored values. test callbacks: types inferred by the assertion helpers; annotating each one would add noise with no value. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { resolveConnection } from "../../../src/core/client"
import { defineConfig } from "../../../src/core/config"
import {
  connectionEntry,
  type ConnectionInput,
  isConnectionEntry,
} from "../../../src/core/connection"

// A fake driver entry whose embedded client opener reflects the resolved config back.
// Direct connectionEntry call so the Client generic INFERS from the opener's return type.
const fake = () =>
  connectionEntry(
    "fakedriver",
    { schema: "./database/schema" },
    {
      client: async (cfg) => ({ connection: cfg.connection, closed: false }),
    },
  )

describe("config-as-factory (defineConfig().connect)", () => {
  test("connect() opens the entry's embedded client (default resolution)", async () => {
    const orm = defineConfig({ connections: { default: fake() } })
    const db = await orm.connect()
    expect(db.connection).toBe("default")
  })

  test("connect(name) is typed to the config's connection names", async () => {
    const orm = defineConfig({
      defaultConnection: "main",
      connections: { main: fake(), reporting: fake() },
    })
    const reporting = await orm.connect("reporting")
    expect(reporting.connection).toBe("reporting")
    const main = await orm.connect()
    expect(main.connection).toBe("main")
    // @ts-expect-error — "nope" is not a configured connection name
    await expect(orm.connect("nope")).rejects.toThrow("not defined")
  })

  test("an entry without an embedded client opener fails with a clear error", async () => {
    const orm = defineConfig({
      connections: { default: connectionEntry("olddriver", { schema: "./s" }) },
    })
    await expect(orm.connect()).rejects.toThrow("predates config.connect()")
  })

  test("resolver args are the TYPED 2nd param; connect(name, args) selects one config", async () => {
    let seen: undefined | { tenant: string }
    const entry = connectionEntry(
      "fakedriver",
      (_ctx, args: { tenant: string }) => {
        seen = args
        return { schema: "./s", key: args.tenant }
      },
      { client: async (cfg) => ({ connection: cfg.connection }) },
    )
    const orm = defineConfig({ connections: { tenants: entry } })
    const db = await orm.connect("tenants", { tenant: "acme" })
    expect(db.connection).toBe("tenants:acme")
    expect(seen).toEqual({ tenant: "acme" })
  })

  test("a BULK (array) resolution throws a teaching error from connect", async () => {
    const entry = connectionEntry(
      "fakedriver",
      () => [
        { schema: "./s", key: "a" },
        { schema: "./s", key: "b" },
      ],
      { client: async (cfg) => ({ connection: cfg.connection }) },
    )
    const orm = defineConfig({ connections: { fleet: entry } })
    await expect(orm.connect("fleet")).rejects.toThrow(
      /resolved to 2 configs \(a, b\).*Pass args/su,
    )
  })

  test("labels: config key > entry label hook > positional", async () => {
    const { resolveFromConfig } = await import("../../../src/core/client")
    const entry = connectionEntry(
      "fakedriver",
      () => [{ schema: "./s", key: "keyed" }, { schema: "./s" }],
      { label: (cfg) => `lbl:${cfg.connection}` },
    )
    const config = defineConfig({ connections: { fleet: entry } })
    const r = await resolveFromConfig(config, "/proj", { name: "fleet" })
    expect(r.labels).toEqual(["keyed", "lbl:fleet"])
  })
})

describe("better-schemic.ts discovery", () => {
  const dir = mkdtempSync(path.join(import.meta.dir, "..", "..", ".cfg-test-"))
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A real project has its deps installed — link this workspace package into the temp
  // project's node_modules so the fixture's bare `better-schemic/*` imports resolve
  // (same symlink-farm idea as the e2e harness).
  {
    const abs = path.join(dir, "node_modules", "better-schemic")
    mkdirSync(path.join(dir, "node_modules"), { recursive: true })
    if (!existsSync(abs)) symlinkSync(path.join(import.meta.dir, "..", "..", ".."), abs)
  }

  const CONFIG_BODY =
    `import { defineConfig } from "better-schemic/config";\n` +
    `import { connectionEntry } from "better-schemic/core";\n` +
    `export const orm = defineConfig({ connections: { default: connectionEntry("testdriver", { schema: "./database/schema" }) } });\n` +
    `export default orm;\n`

  test("a bare better-schemic.ts (named + default export) is discovered", async () => {
    writeFileSync(path.join(dir, "better-schemic.ts"), CONFIG_BODY)
    const rc = await resolveConnection({ cwd: dir })
    expect(rc.driver).toBe("testdriver")
  })

  test("a NAMED-ONLY `orm` export (no default) loads — the scaffolded form", async () => {
    writeFileSync(
      path.join(dir, "better-schemic.config.ts"),
      CONFIG_BODY.replace("export default orm;\n", "").replace("testdriver", "nameddriver"),
    )
    const rc = await resolveConnection({ cwd: dir })
    expect(rc.driver).toBe("nameddriver")
    rmSync(path.join(dir, "better-schemic.config.ts"))
  })

  test("better-schemic.config.ts wins over better-schemic.ts when both exist", async () => {
    writeFileSync(
      path.join(dir, "better-schemic.config.ts"),
      CONFIG_BODY.replace("testdriver", "configdriver"),
    )
    const rc = await resolveConnection({ cwd: dir })
    expect(rc.driver).toBe("configdriver")
    rmSync(path.join(dir, "better-schemic.config.ts"))
  })

  test("legacy `schemic.config.ts` + named `schemic` export still load", async () => {
    rmSync(path.join(dir, "better-schemic.ts"))
    writeFileSync(
      path.join(dir, "schemic.config.ts"),
      CONFIG_BODY.replaceAll("orm", "schemic")
        .replace("export default schemic;\n", "")
        .replace("testdriver", "legacydriver"),
    )
    const rc = await resolveConnection({ cwd: dir })
    expect(rc.driver).toBe("legacydriver")
    rmSync(path.join(dir, "schemic.config.ts"))
    writeFileSync(path.join(dir, "better-schemic.ts"), CONFIG_BODY)
  })

  test("an unrelated better-schemic.ts (no connections) errors helpfully", async () => {
    writeFileSync(path.join(dir, "better-schemic.ts"), `export const helper = 42;\n`)
    await expect(resolveConnection({ cwd: dir })).rejects.toThrow("doesn't export a config")
  })
})

describe("isConnectionEntry", () => {
  test("distinguishes a real factory output from stray values", () => {
    expect(isConnectionEntry(connectionEntry("d", { schema: "./s" }))).toBe(true)
    expect(isConnectionEntry({})).toBe(false)
    expect(isConnectionEntry(null)).toBe(false)
    expect(isConnectionEntry(42)).toBe(false)
  })
})

describe("chained config (defineConfig().connection(...))", () => {
  const fakeFactory = (input: ConnectionInput<{ key?: string; schema: string }, any>) =>
    connectionEntry("fakedriver", input, {
      client: async (cfg) => ({
        connection: cfg.connection,
        query: async () => ["row"],
      }),
    })

  test("chained static + parameterized with typed accumulated ctx", async () => {
    let sawSibling: unknown
    const orm = defineConfig()
      .connection("main", fakeFactory, { schema: "./s" })
      .connection("tenants", fakeFactory, async (ctx, args: { org: string }) => {
        const main = await ctx.connections.main // thenable handle -> full client
        sawSibling = await main.query()
        return { schema: "./s", key: args.org }
      })
    const db = await orm.connect("tenants", { org: "acme" })
    expect(db.connection).toBe("tenants:acme")
    expect(sawSibling).toEqual(["row"])
    const mainConn = await orm.connect("main")
    expect(mainConn.connection).toBe("main")
    // @ts-expect-error — "nope" is not a chained connection name
    await expect(orm.connect("nope")).rejects.toThrow("not defined")
  })

  test("order = visibility: a resolver reaching FORWARD is a compile error (and later a cycle guard)", async () => {
    defineConfig().connection("a", fakeFactory, (ctx) => {
      // @ts-expect-error — "b" declars it AFTER "a", so it's not visible here
      void ctx.connections.b
      return { schema: "./s" }
    })
  })
})
