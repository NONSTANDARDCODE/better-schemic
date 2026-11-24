import { existsSync, readdirSync, statSync } from "node:fs"
import nodePath from "node:path"

import type { Authored, AuthoredDef } from "../index"

import { makeJiti } from "./config"

/**
 * The NEUTRAL view of a loaded table the engine reads —  `name` plus the `config.relation` flag
 * used for ordering. A driver casts this to its own concrete table builder in `lower`. (The runtime
 * object is the driver's real `TableDef`; the engine never names that type.)
 */

/** Import one schema module, wrapping a crash with the FAILING FILE path (original as `cause`). */
async function importSchemaModule(
  jiti: ReturnType<typeof makeJiti>,
  file: string,
): Promise<unknown> {
  try {
    return await jiti.import(file)
  } catch (error) {
    throw new Error(
      `failed to load schema module ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

export type AnyTable = {
  readonly config: { readonly relation?: unknown }
} & Authored

/**
 * Duck-typed `TableDef` check. We avoid `instanceof` on purpose: the user's schema and the
 * CLI may end up with different module instances of the engine, so we recognize a table
 * by shape instead. (Structural access into `emitStatements` works regardless.)
 */
function isTableDef(v: unknown): v is AnyTable {
  if (!v || typeof v !== "object") return false

  const t = v as Record<string, unknown>
  return (
    typeof t.name === "string" &&
    typeof t.fields === "object" &&
    t.fields !== null &&
    typeof t.config === "object" &&
    t.config !== null &&
    typeof t.record === "function"
  )
}

/**
 * Duck-typed standalone-def check — DRIVER-AGNOSTIC: any non-table object carrying a string `kind`
 * and `name` is a standalone definable (event/function/access/enum/view/sequence/…). Core must not
 * hardcode a dialect's kinds — the driver's `registry`/`explode` owns which kinds are valid. Tables
 * match them by `isTableDef` first, so they never reach here. See `isTableDef` on why not `instanceof`.
 */
function isStandaloneDef(v: unknown): v is AuthoredDef {
  if (!v || typeof v !== "object") return false

  const d = v as Record<string, unknown>
  return typeof d.kind === "string" && d.kind.length > 0 && typeof d.name === "string"
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const p = nodePath.join(dir, entry)
      if (statSync(p).isDirectory()) return tsFiles(p)
      return /\.(ts|mts|js|mjs)$/u.test(entry) && !entry.endsWith(".d.ts") ? [p] : []
    })
}

/** The schema module file(s) for a path: the file itself, or every module under the directory. */
function schemaFiles(path: string): string[] {
  return statSync(path).isFile() ? [path] : tsFiles(path)
}

/**
 * Load every schema object from `schemaPath` (a single `.ts` module, or a directory of them): the
 * tables/relations (ordered normal-before-relation, then by name, for stable DDL) and the standalone
 * defs (any non-table `{ kind, name }` definable — the driver's registry owns the kinds). One pass.
 */
/** Record one exported schema value into the per-file collector's shared maps. */
function recordEntry(
  exportName: string,
  value: unknown,
  file: string,
  tables: Map<string, AnyTable>,
  defs: AuthoredDef[],
  fileOf: Map<AnyTable | AuthoredDef, string>,
  seen: Map<string, string[]>,
  entities: LocalFileEntities["entities"],
): void {
  if (isTableDef(value)) {
    const files = seen.get(value.name)
    if (files) files.push(file)
    else seen.set(value.name, [file])
    tables.set(value.name, value) // last def of a name wins
    fileOf.set(value, file)
    entities.push({ exportName, kind: "table", name: value.name })
    return
  }
  if (!isStandaloneDef(value)) return
  defs.push(value)
  fileOf.set(value, file)
  if (value.kind === "function" || value.kind === "access")
    entities.push({ exportName, kind: "def", name: value.name })
}

export async function loadDefs(schemaPath: string): Promise<{
  defs: AuthoredDef[]
  /** Table names defined in more than one file (same-name defs collapse; this is how `check`/
   *  `doctor` surface the conflict). A file repeats when it defines the same name twice. */
  duplicates: Map<string, string[]>
  /** Absolute source file each table/def loads it from (for `diff`'s file annotations). */
  fileOf: Map<AnyTable | AuthoredDef, string>
  /** Per-file exported entities (see {@link LocalFileEntities}) — collected in the SAME pass so
   *  `pull` never re-imports every module to scan exports. */
  localEntities: Map<string, LocalFileEntities>
  tables: AnyTable[]
}> {
  if (!existsSync(schemaPath)) throw new Error(`Schema path not found: ${schemaPath}`)

  const jiti = makeJiti()
  const tables = new Map<string, AnyTable>()
  const defs: AuthoredDef[] = []
  const fileOf = new Map<AnyTable | AuthoredDef, string>()
  const seen = new Map<string, string[]>()
  const localEntities = new Map<string, LocalFileEntities>()
  // Sequential reduce (not Promise.all): "last def of a name wins" depends on module order.
  await schemaFiles(schemaPath).reduce(async (previous, file) => {
    await previous
    const entries = Object.entries(
      (await importSchemaModule(jiti, file)) as Record<string, unknown>,
    )
    const entities: LocalFileEntities["entities"] = []
    entries.forEach(([exportName, value]) => {
      recordEntry(exportName, value, file, tables, defs, fileOf, seen, entities)
    })
    if (entities.length > 0) {
      localEntities.set(file, {
        entities,
        pureSchema: entities.length === entries.length,
      })
    }
  }, Promise.resolve())
  const rank = (t: AnyTable): number => (t.config.relation ? 1 : 0)
  const sorted = [...tables.values()].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  )
  return {
    defs,
    duplicates: new Map([...seen].filter(([, files]) => files.length > 1)),
    fileOf,
    localEntities,
    tables: sorted,
  }
}

/** A schema file's exported entities (tables/functions/accesses) and whether it holds those. */
export type LocalFileEntities = {
  /** Each schema entity by its export-const identifier + its DB name (table/function/access name). */
  entities: { exportName: string; kind: "def" | "table"; name: string }[]
  /** True when EVERY runtime export of the file is a schema entity (no helpers / other exports). */
  pureSchema: boolean
}
