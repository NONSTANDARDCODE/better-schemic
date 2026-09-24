// The neutral stored-snapshot + migration-file engine: the empty/mismatch fallbacks, the migration
// listing, and the pure helpers (timestamp / checksum / slug).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checksum,
  EMPTY_STORED,
  listMigrations,
  readSnapshot,
  slug,
  timestamp,
  writeSnapshot,
} from "../../src/cli-kit/meta";

const dir = mkdtempSync(join(tmpdir(), "meta-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readSnapshot / writeSnapshot", () => {
  test("an absent snapshot reads as EMPTY (version 3, surrealdb)", () => {
    const empty = readSnapshot(join(dir, "none"));
    expect(empty.version).toBe(3);
    expect(empty.driver).toBe("surrealdb");
    expect(empty.schema).toEqual({ kinds: {} });
    expect(EMPTY_STORED.version).toBe(3);
  });

  test("round-trips a written snapshot", () => {
    const meta = join(dir, "round");
    writeSnapshot(meta, {
      version: 3,
      driver: "surrealdb",
      schema: { kinds: { table: [] } },
      files: { t: "t.ts" },
    });
    const back = readSnapshot(meta);
    expect(back.files).toEqual({ t: "t.ts" });
    expect(back.schema).toEqual({ kinds: { table: [] } });
  });

  test("a wrong-version snapshot reads as EMPTY", () => {
    const meta = join(dir, "v2");
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      join(meta, "_snapshot.json"),
      JSON.stringify({ version: 2, driver: "surrealdb", schema: {} }),
    );
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} });
  });

  test("a snapshot missing driver reads as EMPTY", () => {
    const meta = join(dir, "nodriver");
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      join(meta, "_snapshot.json"),
      JSON.stringify({ version: 3, schema: {} }),
    );
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} });
  });

  test("a snapshot missing schema reads as EMPTY", () => {
    const meta = join(dir, "noschema");
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      join(meta, "_snapshot.json"),
      JSON.stringify({ version: 3, driver: "surrealdb" }),
    );
    expect(readSnapshot(meta).schema).toEqual({ kinds: {} });
  });
});

describe("listMigrations", () => {
  test("an absent directory lists nothing", () => {
    expect(listMigrations(join(dir, "no-migrations"))).toEqual([]);
  });

  test("filters by extension, ignores the meta dir, and sorts chronologically", () => {
    const mig = join(dir, "migrations");
    mkdirSync(join(mig, "meta"), { recursive: true });
    writeFileSync(join(mig, "20260102000000_second.surql"), "SELECT 1;");
    writeFileSync(join(mig, "20260101000000_first.surql"), "SELECT 1;");
    writeFileSync(join(mig, "notes.txt"), "ignore me");
    expect(listMigrations(mig).map((m) => m.tag)).toEqual([
      "20260101000000_first",
      "20260102000000_second",
    ]);
  });

  test("a custom extension is honored", () => {
    const mig = join(dir, "sql-migrations");
    mkdirSync(mig, { recursive: true });
    writeFileSync(join(mig, "0001_init.sql"), "SELECT 1;");
    writeFileSync(join(mig, "0002_skip.surql"), "SELECT 1;");
    expect(listMigrations(mig, ".sql").map((m) => m.file)).toEqual([
      "0001_init.sql",
    ]);
  });
});

describe("pure helpers", () => {
  test("timestamp is a sortable UTC stamp", () => {
    expect(timestamp(new Date("2026-06-07T15:30:45Z"))).toBe("20260607153045");
  });

  test("checksum is a stable 16-char hex", () => {
    const a = checksum("SELECT 1;");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(checksum("SELECT 1;")).toBe(a);
    expect(checksum("SELECT 2;")).not.toBe(a);
  });

  test("slug normalizes free-form names and falls back to 'migration'", () => {
    expect(slug("  Add Users! ")).toBe("add_users");
    expect(slug("__")).toBe("migration");
  });
});
