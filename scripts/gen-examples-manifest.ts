#!/usr/bin/env bun
/**
 * Generate `examples-manifest.json` — the single, drift-proof catalog of every driver's verified
 * example cookbook, for external consumers (the schemichq/web examples gallery vendors a pinned copy).
 *
 * It reads each driver's `allGroups` (authoring `code` + the asserted golden `ddl`), RE-VERIFIES
 * `emit(defs) === ddl` at generation time (the same honesty check the cookbooks assert), and writes a
 * flat catalog stamped with the source git commit + a content hash so a vendoring consumer can spot
 * staleness and re-sync deliberately.
 *
 * Run: `bun run scripts/gen-examples-manifest.ts` (or `bun run gen:examples`).
 * See packages/core/docs/EXAMPLE-COOKBOOK-CONVENTION.md.
 */
import {
  emit as surrealEmit,
  allGroups as surrealGroups,
} from "../drivers/surrealdb/examples/index";
import { writeManifest } from "./manifest";

/** A driver's cookbook + how its DDL is emitted + the language tag for that DDL. */
interface DriverCatalog {
  driver: string;
  lang: string;
  // biome-ignore lint/suspicious/noExplicitAny: each driver's Definable type is its own; we only emit.
  groups: { file: string; about: string; examples: any[] }[];
  // biome-ignore lint/suspicious/noExplicitAny: driver-specific Definable[].
  emit: (defs: any[]) => string;
}

const CATALOGS: DriverCatalog[] = [
  {
    driver: "surrealdb",
    lang: "surrealql",
    groups: surrealGroups,
    emit: surrealEmit,
  },
];

/** One flat catalog entry — the shape consumers render from. */
interface ManifestEntry {
  driver: string;
  group: string;
  title: string;
  note?: string;
  code: string;
  ddl: string;
  lang: string;
}

/** A group's source filename → a stable slug: `01-tables.ts` → `tables`, `field-clauses.ts` → `field-clauses`. */
function groupSlug(file: string): string {
  return file
    .replace(/^.*\//, "")
    .replace(/\.[tj]s$/, "")
    .replace(/^\d+[-_]?/, "");
}

const entries: ManifestEntry[] = [];
let verified = 0;

for (const cat of CATALOGS) {
  for (const group of cat.groups) {
    const slug = groupSlug(group.file);
    for (const ex of group.examples) {
      // Re-verify the honesty invariant at generation time: the emitted DDL must equal the golden.
      const got = cat.emit(ex.defs);
      if (got !== ex.ddl) {
        throw new Error(
          `[${cat.driver}/${slug}] "${ex.title}": emit(defs) !== ddl — refusing to generate a stale manifest.\n` +
            `--- emit ---\n${got}\n--- golden ---\n${ex.ddl}`,
        );
      }
      verified++;
      const entry: ManifestEntry = {
        driver: cat.driver,
        group: slug,
        title: ex.title,
        code: ex.code,
        ddl: ex.ddl,
        lang: cat.lang,
      };
      if (ex.note) entry.note = ex.note;
      entries.push(entry);
    }
  }
}

const { commit, hash } = writeManifest({
  file: "examples-manifest.json",
  generator: "gen-examples-manifest.ts",
  entries,
});

console.log(
  `examples-manifest.json: ${entries.length} entries (${verified} verified emit===ddl) ` +
    `from ${CATALOGS.length} drivers — source ${commit.slice(0, 7)} hash ${hash}`,
);
