import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { ResolvedConfig } from "better-schemic/core"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { seed } from "../../../src/cli/migrate"

/** A fake driver connection that records which seeds ran + any SQL they applied. */
function recorder(): {
  db: { query: (s: string) => number; ran: (n: string) => number }
  ran: string[]
  sql: string[]
} {
  const ran: string[] = []
  const sql: string[] = []
  return {
    db: { query: (s: string): number => sql.push(s), ran: (n: string): number => ran.push(n) },
    ran,
    sql,
  }
}

describe("seed (folder of named scripts)", () => {
  let root: string
  const cfg = (): ResolvedConfig => ({ root }) as unknown as ResolvedConfig

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "better-schemic-seed-"))
    const dir = path.join(root, "database/seed")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "schema.surql"), "DEFINE TABLE user;\n")
    writeFileSync(
      path.join(dir, "seeds.d.ts"),
      'declare module "*.surql" { const s: string; export default s; }\n',
    )
    writeFileSync(
      path.join(dir, "01-users.ts"),
      'import schema from "./schema.surql" with { type: "text" };\n' +
        "export default async (db: any) => { db.ran('users'); db.query(schema); };\n",
    )
    writeFileSync(
      path.join(dir, "02-data.ts"),
      "export default async (db: any) => { db.ran('data'); };\n",
    )
    writeFileSync(path.join(dir, "_helper.ts"), "export const x = 1;\n")
    writeFileSync(
      path.join(dir, "index.ts"),
      "export default async (db: any) => { db.ran('index'); };\n",
    )
  })
  afterEach(() => {
    rmSync(root, { force: true, recursive: true })
  })

  it("runs only index.ts when no name/--all is given", async () => {
    const r = recorder()
    await seed(r.db, cfg(), {})
    expect(r.ran).toEqual(["index"])
  })

  it("runs every script in filename order with --all (index excluded)", async () => {
    const r = recorder()
    await seed(r.db, cfg(), { all: true })
    expect(r.ran).toEqual(["users", "data"])
  })

  it("addresses a seed by name with the numeric prefix stripped", async () => {
    const r = recorder()
    await seed(r.db, cfg(), { name: "data" })
    expect(r.ran).toEqual(["data"])
  })

  it("loads a .surql supporting file via `with { type: 'text' }`", async () => {
    const r = recorder()
    await seed(r.db, cfg(), { name: "users" })
    expect(r.sql).toEqual(["DEFINE TABLE user;\n"])
  })

  it("errors with the available names on an unknown seed", async () => {
    const pending = seed(recorder().db, cfg(), { name: "nope" }) as unknown as Promise<unknown>
    let failure: unknown
    try {
      await pending
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/No seed named "nope".*users, data/u)
  })

  it("ignores `_`-prefixed files and `.d.ts` declarations", async () => {
    const r = recorder()
    await seed(r.db, cfg(), { all: true })
    expect(r.ran).not.toContain("helper")
    expect(r.ran).not.toContain("seeds")
  })
})
