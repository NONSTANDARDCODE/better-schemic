// The driver-parametric LIVE diff path. `sz diff` (or a non-default `config.driver`)
// routes here: author with that driver's `s.*`, lower via its kind registry, introspect the live DB,
// and show the DDL gap — all generic over the registry (core-v2). Each DB is its own world: you author
// and diff with the SAME driver (kinds aren't cross-driver), so there is no cross-dialect lowering.

import type { ResolvedConfig } from "../core"
import {
  buildKindDiff,
  type DiffItem,
  formatItems,
  getDriver,
  loadDefs,
  lowerSchema,
  ok,
  plural,
  type PortableObject,
  style,
} from "../core"

/**
 * Run `sz diff` against a driver's LIVE database. Authoring is that driver's `s.*` surface (exploded +
 * lowered via its registry); the diff is the generic `buildKindDiff`.
 */
export async function portableDiff(
  config: ResolvedConfig,
  driverName: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const driver = getDriver(driverName)
  const reg = driver.registry

  // Desired = the declared schema, authored with this driver's s.* -> exploded -> lowered.
  const { defs, tables } = await loadDefs(config.schemaPath)
  const desired: PortableObject[] = lowerSchema(reg, driver.explode(tables, defs))

  // Live = the database, introspected through the driver, canonicalized identically to lowering.
  const conn = await driver.connect(config)
  let live: PortableObject[]
  try {
    // Exclude the migration bookkeeping tables (and their `_lock` companion) — they're CLI-owned, not
    // schema, so `diff` must not report them as "to remove". Same scoping as migrate's baseline read.
    live = await driver.introspectAll(
      conn,
      new Set([config.migrationsTable, `${config.migrationsTable}_lock`]),
    )
  } finally {
    await closeQuietly(conn)
  }

  // Generic kind-registry diff (field-level via each kind's overwrite/displayItems), so the
  // `diff` display matches what `gen`/`migrate` emit for that database.
  const diff = buildKindDiff(reg, live, desired)

  if (opts.json) {
    console.log(JSON.stringify({ down: diff.down, driver: driverName, up: diff.up }))
    return
  }

  console.log(style.dim(`  driver: ${driverName}`))
  if (diff.up.length === 0) {
    console.log(ok("Schema is in sync with the target database."))
    return
  }
  const items = diff.items ?? []
  console.log(formatItems(items))
  const n = (op: DiffItem["op"]) => items.filter((i) => i.op === op).length
  console.log(
    style.dim(
      `\n${plural(items.length, "change")} — ${n("add")} added, ${n("change")} changed, ${n("remove")} removed.`,
    ),
  )
}

async function closeQuietly(conn: unknown): Promise<void> {
  const close = (conn as null | { close?: () => Promise<void> })?.close
  if (typeof close === "function") {
    try {
      await close.call(conn)
    } catch {
      // best-effort: a failed close shouldn't mask the diff result
    }
  }
}
