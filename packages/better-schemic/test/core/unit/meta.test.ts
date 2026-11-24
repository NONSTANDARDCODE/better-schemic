const MAGIC_3 = 3
// The neutral stored-snapshot + migration-file engine: the empty/mismatch fallbacks, the migration
// listing, and the pure helpers (timestamp / checksum / slug).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import {
  checksum,
  EMPTY_STORED,
  listMigrations,
  readSnapshot,
  slug,
  timestamp,
  writeSnapshot,
} from "../../../src/core/cli-kit/meta"

const dir = mkdtempSync(path.join(tmpdir(), "meta-test-"))
afterAll(() => {
  rmSync(dir, { force: true, recursive: true })
})

describe("readSnapshot / writeSnapshot", () => {
  test("an absent snapshot reads as EMPTY (version 3, surrealdb)", () => {
    const empty = readSnapshot(path.join(dir, "none"))
    expect(empty.version).toBe(MAGIC_3)
    expect(empty.driver).toBe("surrealdb")
    expect(empty.schema).toEqual({ kinds: {} })
    expect(EMPTY_STORED.version).toBe(MAGIC_3)
  })

  test("round-trips a written snapshot", () => {
    const meta = path.join(dir, "round")
    writeSnapshot(meta, {
      driver: "surrealdb",
      files: { t: "t.ts" },
      schema: { kinds: { table: [] } },
      version: 3,
    })
    const back = readSnapshot(meta)
    expect(back.files).toEqual({ t: "t.ts" })
    expect(back.schema).toEqual({ kinds: { table: [] } })
  })

  test("a wrong-version snapshot reads as EMPTY", () => {
    const meta = path.join(dir, "v2")
    mkdirSync(meta, { recursive: true })
    writeFileSync(
      path.join(meta, "_snapshot.json"),
      JSON.stringify({ driver: "surrealdb", schema: {}, version: 2 }),
    )
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} })
  })

  test("a snapshot missing driver reads as EMPTY", () => {
    const meta = path.join(dir, "nodriver")
    mkdirSync(meta, { recursive: true })
    writeFileSync(path.join(meta, "_snapshot.json"), JSON.stringify({ schema: {}, version: 3 }))
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} })
  })

  test("a snapshot missing schema reads as EMPTY", () => {
    const meta = path.join(dir, "noschema")
    mkdirSync(meta, { recursive: true })
    writeFileSync(
      path.join(meta, "_snapshot.json"),
      JSON.stringify({ driver: "surrealdb", version: 3 }),
    )
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} })
  })

  test("a malformed snapshot throws a teaching error (never a raw SyntaxError)", () => {
    const meta = path.join(dir, "malformed")
    mkdirSync(meta, { recursive: true })
    writeFileSync(path.join(meta, "_snapshot.json"), "{ not json")
    expect(() => readSnapshot(meta)).toThrow(/not valid JSON/u)
  })

  test("a doctored snapshot never reaches the walkers (unsafe kinds / bad shapes read as EMPTY)", () => {
    const meta = path.join(dir, "doctored")
    mkdirSync(meta, { recursive: true })
    ;[
      { kinds: { __proto__: [] } },
      { kinds: { table: "not-an-array" } },
      { kinds: { table: [{ kind: 1, name: "x" }] } },
    ].forEach((schema) => {
      writeFileSync(
        path.join(meta, "_snapshot.json"),
        JSON.stringify({ driver: "surrealdb", schema, version: 3 }),
      )
      expect(readSnapshot(meta).schema).toEqual({ kinds: {} })
    })
    writeFileSync(
      path.join(meta, "_snapshot.json"),
      JSON.stringify({
        driver: "surrealdb",
        files: { t: 42 },
        schema: { kinds: {} },
        version: 3,
      }),
    )
    expect(readSnapshot(meta).files).toEqual({})
  })
})

describe("listMigrations", () => {
  test("an absent directory lists nothing", () => {
    expect(listMigrations(path.join(dir, "no-migrations"))).toEqual([])
  })

  test("filters by extension, ignores the meta dir, and sorts chronologically", () => {
    const mig = path.join(dir, "migrations")
    mkdirSync(path.join(mig, "meta"), { recursive: true })
    writeFileSync(path.join(mig, "20260102000000_second.surql"), "SELECT 1;")
    writeFileSync(path.join(mig, "20260101000000_first.surql"), "SELECT 1;")
    writeFileSync(path.join(mig, "notes.txt"), "ignore me")
    expect(listMigrations(mig).map((m) => m.tag)).toEqual([
      "20260101000000_first",
      "20260102000000_second",
    ])
  })

  test("a custom extension is honored", () => {
    const mig = path.join(dir, "sql-migrations")
    mkdirSync(mig, { recursive: true })
    writeFileSync(path.join(mig, "0001_init.sql"), "SELECT 1;")
    writeFileSync(path.join(mig, "0002_skip.surql"), "SELECT 1;")
    expect(listMigrations(mig, ".sql").map((m) => m.file)).toEqual(["0001_init.sql"])
  })
})

describe("pure helpers", () => {
  test("timestamp is a sortable UTC stamp", () => {
    expect(timestamp(new Date("2026-06-07T15:30:45Z"))).toBe("20260607153045")
  })

  test("checksum is a stable 16-char hex", () => {
    const a = checksum("SELECT 1;")
    expect(a).toMatch(/^[0-9a-f]{16}$/u)
    expect(checksum("SELECT 1;")).toBe(a)
    expect(checksum("SELECT 2;")).not.toBe(a)
  })

  test("slug normalizes free-form names and falls back to 'migration'", () => {
    expect(slug("  Add Users! ")).toBe("add_users")
    expect(slug("__")).toBe("migration")
  })
})
