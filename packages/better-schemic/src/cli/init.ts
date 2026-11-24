import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import nodePath from "node:path"

import type { Driver } from "../core"

/** Pretty-print indent for generated JSON. */
const JSON_INDENT = 2

export type InitResult = {
  created: string[]
  skipped: string[]
}

/**
 * The empty migration snapshot a fresh project starts from. Dialect-NEUTRAL (the KindSnapshot shape is
 * core's), tagged with the driver so the snapshot reader knows who owns its `schema` payload.
 */
function initialSnapshot(driver: string): string {
  return `${JSON.stringify(
    {
      driver,
      files: {},
      schema: { kinds: {} },
      version: 3,
    },
    null,
    JSON_INDENT,
  )}\n`
}

/**
 * Scaffold a fresh project for `driver`. The dialect files (config, sample schema, seed, env) come
 * from the driver's {@link Driver.initScaffold}; the CLI adds the neutral migration snapshot. Never
 * overwrites existing files. The CLI itself stays dialect-free — it  knows the file map.
 */
export function init(cwd: string, driver: Driver): InitResult {
  const scaffold = driver.initScaffold?.()
  if (!scaffold) {
    throw new Error(
      `the "${driver.name}" driver does not support \`better-schemic init\` scaffolding.`,
    )
  }
  const files: Record<string, string> = {
    ...scaffold,
    "database/migrations/meta/_snapshot.json": initialSnapshot(driver.name),
  }

  const created: string[] = []
  const skipped: string[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [rel, content] of Object.entries(files)) {
    const abs = nodePath.resolve(cwd, rel)
    if (existsSync(abs)) {
      skipped.push(rel)
      continue
    }
    mkdirSync(nodePath.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    created.push(rel)
  }
  return { created, skipped }
}
