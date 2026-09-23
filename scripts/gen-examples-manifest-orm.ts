#!/usr/bin/env bun
/**
 * Generate `examples-manifest-orm.json` — the ORM counterpart to `examples-manifest.json`. Where the
 * schema manifest catalogs authoring → DDL, this catalogs delegate call → **runtime SurrealQL**. It reads
 * the driver's `allOrmGroups`, RE-VERIFIES `capture(def) === { sql, vars }` at generation time (the same
 * honesty check `test/examples/orm-reference.test.ts` asserts), and writes a flat catalog stamped with the
 * source git commit + a content hash for vendoring consumers.
 *
 * Run: `bun run scripts/gen-examples-manifest-orm.ts` (or `bun run gen:examples:orm`).
 * See packages/core/docs/EXAMPLE-COOKBOOK-CONVENTION.md.
 */
import {
  allOrmGroups,
  capture,
} from "../drivers/surrealdb/examples/orm/index";
import { writeManifest } from "./manifest";

/** One flat catalog entry — the shape consumers render from. */
interface ManifestEntry {
  driver: string;
  group: string;
  title: string;
  note?: string;
  /** The verbatim delegate-call snippet (the TypeScript authoring). */
  code: string;
  /** The runtime SurrealQL the call emits. */
  sql: string;
  /** The bound values (`$p0`, …), JSON-stable. */
  vars: Record<string, unknown>;
  lang: string;
}

const driver = "surrealdb";
const entries: ManifestEntry[] = [];
let verified = 0;

for (const group of allOrmGroups) {
  for (const ex of group.examples) {
    // Re-verify the honesty invariant: the re-run statement must equal the golden.
    const got = await capture(ex);
    if (got.sql !== ex.sql || JSON.stringify(got.vars) !== JSON.stringify(ex.vars)) {
      throw new Error(
        `[${driver}/${group.file}] "${ex.title}": capture(def) !== golden — refusing to generate a stale manifest.\n` +
          `--- got ---\n${got.sql}\n${JSON.stringify(got.vars)}\n--- golden ---\n${ex.sql}\n${JSON.stringify(ex.vars)}`,
      );
    }
    verified++;
    const entry: ManifestEntry = {
      driver,
      group: group.file,
      title: ex.title,
      code: ex.code,
      sql: ex.sql,
      vars: ex.vars,
      lang: "surrealql",
    };
    if (ex.note) entry.note = ex.note;
    entries.push(entry);
  }
}

const { commit, hash } = writeManifest({
  file: "examples-manifest-orm.json",
  generator: "gen-examples-manifest-orm.ts",
  entries,
});

console.log(
  `examples-manifest-orm.json: ${entries.length} entries (${verified} verified capture===golden) ` +
    `from ${allOrmGroups.length} groups — source ${commit.slice(0, 7)} hash ${hash}`,
);
