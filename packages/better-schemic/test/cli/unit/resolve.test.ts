import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { type Driver, driverNames, registerDriver } from "better-schemic/core"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { resolveOne, resolveTargets } from "../../../src/cli/resolve"

// Fixtures live UNDER the package so a jiti-loaded config's `import "better-schemic/core"` resolves through
// packages/cli/node_modules (a /tmp dir has no node_modules to walk up into).
const BASE = path.join(import.meta.dir, "..", ".tmp-resolve")

// A minimal fake driver so the engine's ensureDriver/getDriver are no-ops (no real package import).
// connect/close/query exercis them (by the cross-connection proxy tests); the IR ops unus them.
// The registry shars it with jiti-loaded config modules (core is native-imported), so registering
// "faux" here makes `connectionEntry("faux", …)` configs resolvable.
const queries: { sql: string; url: unknown }[] = []
const faux = {
  async close() {
    /* empty */
  },
  async connect(config: { params: Record<string, unknown> }) {
    await Promise.resolve()
    return { url: config.params.url }
  },
  name: "faux",
  async query(conn: { url: unknown }, sql: string) {
    await Promise.resolve()
    queries.push({ sql, url: conn.url })
    return [{ ok: 1 }]
  },
} as unknown as Driver

function writeConfig(body: string): string {
  const dir = mkdtempSync(path.join(BASE, "p-"))
  mkdirSync(path.join(dir, "schema"), { recursive: true })
  writeFileSync(path.join(dir, "better-schemic.config.ts"), body, "utf8")
  return path.join(dir, "better-schemic.config.ts")
}

beforeAll(() => {
  rmSync(BASE, { force: true, recursive: true })
  mkdirSync(BASE, { recursive: true })
  if (!driverNames().includes("faux")) registerDriver(faux)
})
afterAll(() => {
  rmSync(BASE, { force: true, recursive: true })
})

// A project with a single default connection + a 2-element tenant collection (resolver, --arg-aware).
const COLLECTION = `
import { connectionEntry } from "better-schemic/core";
import { defineConfig } from "better-schemic/config";
export default defineConfig({
  defaultConnection: "primary",
  connections: {
    primary: connectionEntry("faux", { schema: "./schema", url: "ws://primary" }),
    tenants: connectionEntry("faux", (_ctx, args?: { only?: string }) =>
      (args?.only ? [args.only] : ["acme", "globex"]).map((k) => ({
        schema: "./schema", key: k, url: "ws://" + k,
      }))),
  },
});
`

describe("resolveTargets — addressing", () => {
  test("default resolves the defaultConnection", async () => {
    const config = writeConfig(COLLECTION)
    const targets = await resolveTargets({ config })
    expect(targets.map((t) => t.connection)).toEqual(["primary"])
    expect(targets[0].driver).toBe("faux")
    expect(targets[0].params.url).toBe("ws://primary")
  })

  test("--connection on a collection fans out to every keyed element", async () => {
    const config = writeConfig(COLLECTION)
    const targets = await resolveTargets({ config, connection: "tenants" })
    expect(targets.map((t) => t.connection)).toEqual(["tenants:acme", "tenants:globex"])
  })

  test("--connection <name>:<key> pins one collection element", async () => {
    const config = writeConfig(COLLECTION)
    const targets = await resolveTargets({
      config,
      connection: "tenants:globex",
    })
    expect(targets.map((t) => t.connection)).toEqual(["tenants:globex"])
    expect(targets[0].params.url).toBe("ws://globex")
  })

  test("--all resolves every connection, collections fanned out", async () => {
    const config = writeConfig(COLLECTION)
    const targets = await resolveTargets({ all: true, config })
    expect(targets.map((t) => t.connection)).toEqual(["primary", "tenants:acme", "tenants:globex"])
  })

  test("--arg is fed to resolvers (yields a subset)", async () => {
    const config = writeConfig(COLLECTION)
    const targets = await resolveTargets({
      arg: ["only=acme"],
      config,
      connection: "tenants",
    })
    expect(targets.map((t) => t.connection)).toEqual(["tenants:acme"])
  })

  test("unknown connection errors with the known names", async () => {
    const config = writeConfig(COLLECTION)
    let caughtVoid0: unknown
    try {
      await resolveTargets({ config, connection: "nope" })
    } catch (error) {
      caughtVoid0 = error
    }
    expect(String(caughtVoid0)).toMatch(/No connection named "nope"/u)
  })
})

describe("resolveOne — single-connection guard", () => {
  test("rejects --all", async () => {
    const config = writeConfig(COLLECTION)
    let caughtVoid1: unknown
    try {
      await resolveOne({ all: true, config })
    } catch (error) {
      caughtVoid1 = error
    }
    expect(String(caughtVoid1)).toMatch(/--all/u)
  })

  test("rejects a bare collection (must pin a :key)", async () => {
    const config = writeConfig(COLLECTION)
    let caughtVoid2: unknown
    try {
      await resolveOne({ config, connection: "tenants" })
    } catch (error) {
      caughtVoid2 = error
    }
    expect(String(caughtVoid2)).toMatch(/collection/u)
  })

  test("resolves a pinned collection element", async () => {
    const config = writeConfig(COLLECTION)
    const one = await resolveOne({ config, connection: "tenants:acme" })
    expect(one.connection).toBe("tenants:acme")
  })
})

describe("resolveTargets — lazy cross-connection proxy", () => {
  test("a resolver can query a sibling, which is opened then closed", async () => {
    queries.length = 0
    const config = writeConfig(`
import { connectionEntry } from "better-schemic/core";
import { defineConfig } from "better-schemic/config";
export default defineConfig({
  defaultConnection: "child",
  connections: {
    parent: connectionEntry("faux", { schema: "./schema", url: "ws://parent" }),
    child: connectionEntry("faux", async (ctx) => {
      const rows = await ctx.connections.parent.query("SELECT 1");
      return { schema: "./schema", url: "ws://child", probed: rows.length };
    }),
  },
});
`)
    const targets = await resolveTargets({ config, connection: "child" })
    expect(targets.map((t) => t.connection)).toEqual(["child"])
    expect(targets[0].params.probed).toBe(1)
    expect(queries).toEqual([{ sql: "SELECT 1", url: "ws://parent" }])
  })

  test("a resolution cycle errors instead of looping", async () => {
    const config = writeConfig(`
import { connectionEntry } from "better-schemic/core";
import { defineConfig } from "better-schemic/config";
export default defineConfig({
  defaultConnection: "a",
  connections: {
    a: connectionEntry("faux", async (ctx) => {
      await ctx.connections.b.query("x");
      return { schema: "./schema", url: "ws://a" };
    }),
    b: connectionEntry("faux", async (ctx) => {
      await ctx.connections.a.query("x");
      return { schema: "./schema", url: "ws://b" };
    }),
  },
});
`)
    let caughtVoid3: unknown
    try {
      await resolveTargets({ config, connection: "a" })
    } catch (error) {
      caughtVoid3 = error
    }
    expect(String(caughtVoid3)).toMatch(/cycle/u)
  })
})
