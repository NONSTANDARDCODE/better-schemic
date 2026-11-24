import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { asyncDisposable, resolveConnection } from "../../../src/core/client"

describe("asyncDisposable mixin", () => {
  test("adds [Symbol.asyncDispose] that calls close", async () => {
    let closed = 0
    class Client {
      async close(): Promise<void> {
        await Promise.resolve()
        closed++
      }
    }
    asyncDisposable(Client.prototype)
    const c = new Client() as Client & AsyncDisposable
    await c[Symbol.asyncDispose]()
    expect(closed).toBe(1)
  })

  test("await using disposes at block exit", async () => {
    let closed = 0
    class Client {
      async close(): Promise<void> {
        await Promise.resolve()
        closed++
      }
    }
    asyncDisposable(Client.prototype)
    {
      await using _c = new Client() as Client & AsyncDisposable
      expect(closed).toBe(0)
    }
    expect(closed).toBe(1)
  })
})

// Integration: resolveConnection against a real temp config (loadProject reads it from disk).
// The temp dir sits under the repo checkout so `better-schemic/core` resolves via the workspace node_modules.
describe("resolveConnection", () => {
  const dir = mkdtempSync(path.join(import.meta.dir, "..", "..", ".orm-test-"))
  afterAll(() => {
    rmSync(dir, { force: true, recursive: true })
  })

  const writeConfig = (body: string): void => {
    writeFileSync(
      path.join(dir, "better-schemic.config.ts"),
      `import { defineConfig } from "better-schemic/config";\n` +
        `import { connectionEntry } from "better-schemic/core";\n` +
        `const conn = (over = {}) => connectionEntry("testdriver", { schema: "./database/schema", ...over });\n` +
        body,
    )
  }

  test("resolves the sole connection (no name)", async () => {
    writeConfig(`export default defineConfig({ connections: { default: conn() } });`)
    const rc = await resolveConnection({ cwd: dir })
    expect(rc.connection).toBe("default")
    expect(rc.driver).toBe("testdriver")
    expect(rc.schemaPath.endsWith("database/schema")).toBe(true)
  })

  test("honors defaultConnection + resolves a named one", async () => {
    writeConfig(
      `export default defineConfig({ defaultConnection: "primary", connections: { primary: conn(), reporting: conn() } });`,
    )
    const primary = await resolveConnection({ cwd: dir })
    expect(primary.connection).toBe("primary")
    const reporting = await resolveConnection({ cwd: dir, name: "reporting" })
    expect(reporting.connection).toBe("reporting")
  })

  test("throws for an unknown connection name", async () => {
    writeConfig(`export default defineConfig({ connections: { default: conn() } });`)
    let caughtVoid0: unknown
    try {
      await resolveConnection({ cwd: dir, name: "nope" })
    } catch (error) {
      caughtVoid0 = error
    }
    expect(String(caughtVoid0)).toMatch('connection "nope" is not defined')
  })
})
