#!/usr/bin/env bun
/**
 * Generate `examples-manifest.json` — the single, drift-proof catalog of every driver's verified
 * example cookbook, for external consumers (the schemichq/web examples gallery vendors a pinned copy).
 *
 * It reads each driver's `allGroups` (authoring `code` + the asserted golden `ddl`), RE-VERIFIES
 * `emit(defs) === ddl` at generation time (the same honesty check the cookbooks assert), and writes a
 * flat catalog stamped with the source git commit + a content hash so a vendoring consumer can spot
 * staleness and re-sync .
 *
 * Run: `bun run scripts/gen-examples-manifest.ts` (or `bun run gen:examples`).
 * See packages/better-schemic/docs/engine/EXAMPLE-COOKBOOK-CONVENTION.md.
 */
import {
  allGroups as surrealGroups,
  type Definable,
  emit as surrealEmit,
  type Example,
  type ExampleGroup,
} from "../packages/better-schemic/examples"

import { writeManifest } from "./manifest"

/** A driver's cookbook + how its DDL emits it + the language tag for that DDL. */
type DriverCatalog = {
  driver: string
  emit: (defs: Definable[]) => string
  groups: ExampleGroup[]
  lang: string
}

const CATALOGS: DriverCatalog[] = [
  {
    driver: "surrealdb",
    emit: surrealEmit,
    groups: surrealGroups,
    lang: "surrealql",
  },
]

/** One flat catalog entry — the shape consumers render from. */
type ManifestEntry = {
  code: string
  ddl: string
  driver: string
  group: string
  lang: string
  note?: string
  title: string
}

/** A group's source filename → a stable slug: `01-tables.ts` → `tables`, `field-clauses.ts` → `field-clauses`. */
function groupSlug(file: string): string {
  return file
    .replace(/^.*\//u, "")
    .replace(/\.[tj]s$/u, "")
    .replace(/^\d+[-_]?/u, "")
}

const entries: ManifestEntry[] = []
let verified = 0

/** Re-verify the honesty invariant, then build one flat catalog entry. */
function buildEntry(cat: DriverCatalog, slug: string, ex: Example): ManifestEntry {
  const got = cat.emit(ex.defs)
  if (got !== ex.ddl) {
    throw new Error(
      `[${cat.driver}/${slug}] "${ex.title}": emit(defs) !== ddl — refusing to generate a stale manifest.\n` +
        `--- emit ---\n${got}\n--- golden ---\n${ex.ddl}`,
    )
  }
  const entry: ManifestEntry = {
    code: ex.code,
    ddl: ex.ddl,
    driver: cat.driver,
    group: slug,
    lang: cat.lang,
    title: ex.title,
  }
  if (ex.note) entry.note = ex.note
  return entry
}

// eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
for (const cat of CATALOGS) {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const group of cat.groups) {
    const slug = groupSlug(group.file)
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const ex of group.examples) {
      entries.push(buildEntry(cat, slug, ex))
      verified++
    }
  }
}

const { commit, hash } = writeManifest({
  entries,
  file: "examples-manifest.json",
  generator: "gen-examples-manifest.ts",
})

console.log(
  `examples-manifest.json: ${entries.length} entries (${verified} verified emit===ddl) ` +
    `from ${CATALOGS.length} drivers — source ${commit.slice(0, 7)} hash ${hash}`,
)
