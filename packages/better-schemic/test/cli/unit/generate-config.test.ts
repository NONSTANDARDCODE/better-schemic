// `sc generate` end-to-end: config-declared generators, jiti aliases, directives and bootstrap install.
import "../../../src/driver"

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { generate } from "../../../src/cli/generate"

const BASE = path.join(import.meta.dir, "..", ".tmp-generate")
const SRC = path.resolve(import.meta.dir, "../../../src")
let root = ""
let previous = ""

const fromRoot = (rel: string): string => path.join(root, rel)
const read = (rel: string): string => readFileSync(fromRoot(rel), "utf8")

beforeAll(() => {
  rmSync(BASE, { force: true, recursive: true })
  mkdirSync(BASE, { recursive: true })
  root = mkdtempSync(path.join(BASE, "p-"))
  mkdirSync(fromRoot("src/db"), { recursive: true })
  const srcSpec = SRC.replaceAll("\\", "/")
  writeFileSync(fromRoot("src/env.ts"), `export const PREFIX = "app";\n`)
  writeFileSync(
    fromRoot("src/db/schema.ts"),
    [
      `import { s, table } from "${srcSpec}/surreal";`,
      `import { schema as defineSchema } from "${srcSpec}/surreal/orm/schema";`,
      `import { PREFIX } from "@/env";`,
      `export const User = table("user", { name: s.string() }).stringIds();`,
      `export const prefix = PREFIX;`,
      `export const schema = defineSchema({ users: User });`,
      "",
    ].join("\n"),
  )
  writeFileSync(
    fromRoot("src/db/orm-provider.ts"),
    `export function getOrmClient(): unknown { return {}; }\n`,
  )
  writeFileSync(fromRoot("src/index.ts"), `export const app = 1;\n`)
  // zod-compiler resolves aliases via the app's tsconfig (jiti uses `resolve.alias` above).
  writeFileSync(
    fromRoot("tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } })}\n`,
  )
  writeFileSync(
    fromRoot("better-schemic.config.ts"),
    [
      `import { defineConfig, surrealConnection } from "${srcSpec}/config";`,
      `export default defineConfig({`,
      `  connections: {`,
      `    default: surrealConnection({ schema: "./src/db/schema.ts", url: "http://127.0.0.1:8000", namespace: "t", database: "t" }),`,
      `  },`,
      `  resolve: { alias: { "@": "./src" } },`,
      `  generators: {`,
      `    orm: { out: "src/db/generated/orm.generated.ts", schema: "./src/db/orm-schema.ts", schemaExport: "schema", provider: "./src/db/orm-provider.ts", client: "getOrmClient", surface: "orm" },`,
      `    aot: { out: ".better-schemic/schema.aot.ts", dir: ".better-schemic/aot", importIn: ["src/index.ts"] },`,
      `  },`,
      `  generated: { tsNocheck: true, eslintDisable: true },`,
      `});`,
      "",
    ].join("\n"),
  )
  // The ORM generator reads a SCHEMA_DEF artifact — keep it in a separate module, like the app does.
  writeFileSync(
    fromRoot("src/db/orm-schema.ts"),
    [
      `import { s, table } from "${srcSpec}/surreal";`,
      `import { schema as defineSchema } from "${srcSpec}/surreal/orm/schema";`,
      `export const User = table("user", { name: s.string() }).stringIds();`,
      `export const schema = defineSchema({ users: User });`,
      "",
    ].join("\n"),
  )
  previous = process.cwd()
  process.chdir(root)
})

afterAll(() => {
  process.chdir(previous)
  rmSync(BASE, { force: true, recursive: true })
})

describe("sc generate — declared generators", () => {
  test("runs both generators, applies directives and installs the bootstrap", async () => {
    const result = await generate({ only: "all" })
    expect(result.orm).toContain("orm.generated.ts")
    expect(result.aot?.targets).toBeDefined()
    expect(result.aot?.schemaCount).toBeGreaterThan(1)

    const orm = read("src/db/generated/orm.generated.ts")
    expect(orm).toContain("// @ts-nocheck — generated")
    expect(orm).toContain("/* eslint-disable */")
    expect(orm).toContain("get users()")
    expect(orm).toContain("// better-schemic:aot-install")

    const compiled = read(".better-schemic/aot/schemas.compiled.ts")
    expect(compiled).toContain('from "better-schemic/zod"')
    expect(compiled).not.toContain('from "zod"')
    expect(compiled).toContain("// @ts-nocheck — generated")

    // `@/env` resolved through `resolve.alias` — no symlink in node_modules/@.
    expect(read("src/db/generated/orm.generated.ts")).toContain("satisfies OrmSurface")
    expect(read("src/index.ts")).toContain("// better-schemic:aot-install")

    // Idempotent: a second run does not duplicate the inserted imports.
    await generate({ only: "all" })
    const entry = read("src/index.ts")
    expect(entry.match(/better-schemic:aot-install/gu)).toHaveLength(1)
  })

  test("--only aot skips the ORM façade", async () => {
    const result = await generate({ only: "aot" })
    expect(result.orm).toBeUndefined()
    expect(result.aot?.bootstrap).toContain("schema.aot.ts")
  })
})
