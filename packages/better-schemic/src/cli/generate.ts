/**
 * `sc generate` — run every generator declared in `better-schemic.config.ts` in one shot.
 *
 * Before this command an app needed a `scripts/generate.ts` (symlink `@` → `src`, seven CLI flags,
 * handwritten directives, manual bootstrap imports). The config now owns paths, aliases and tool
 * conventions; this command resolves the project ONCE and drives both generators against it.
 */
import { existsSync, readFileSync, watch as fsWatch, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

import type { ResolvedConfig } from "../core"
import { type GeneratedOpts, ignorePatterns, writeIgnores } from "../core/cli-kit/generated"

import { compileAotWith, type CompileResult } from "./compile"
import { generateOrmWith } from "./generate-orm"
import { resolveOne, type ResolveOpts } from "./resolve"

export type GenerateOnly = "all" | "aot" | "orm"

export type GenerateOpts = {
  /** Restrict to one generator. Default: every enabled generator in the config. */
  readonly only?: GenerateOnly
  /** Re-run on schema/config changes. */
  readonly watch?: boolean
} & ResolveOpts

export type GenerateResult = {
  readonly aot?: CompileResult
  /** Every artifact written in this run (for knip/tsconfig ignore merging). */
  readonly artifacts: readonly string[]
  /** Patterns suggested for knip/tsconfig/bunfig when `generated.knipAutoWrite` is off. */
  readonly ignores: readonly string[]
  /** Files that now carry an inserted bootstrap import. */
  readonly installedIn: readonly string[]
  readonly orm?: string
}

const MODULE_SPEC = (from: string, to: string): string => {
  const spec = relative(dirname(from), to).replaceAll("\\", "/")
  return spec.startsWith("../") ? spec : `./${spec}`
}

const INSTALL_MARKER = "// better-schemic:aot-install"

/** Collapse a burst of file events into one re-run; the delay is a default value, not a magic number. */
const debounce = (run: () => void, delay = 150): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer) clearTimeout(timer)

    timer = setTimeout(run, delay)
  }
}

/** Idempotently insert a side-effect bootstrap import into an app source file. */
export function insertBootstrapImport(file: string, specifier: string): boolean {
  if (!existsSync(file)) return false

  const source = readFileSync(file, "utf8")
  if (
    source.includes(INSTALL_MARKER) ||
    source.includes(`import "${specifier}"`) ||
    source.includes(`import '${specifier}'`)
  )
    return false

  const lines = source.split("\n")
  const at = lines[0]?.startsWith("#!") ? 1 : 0
  lines.splice(at, 0, INSTALL_MARKER, `import "${specifier}";`)
  writeFileSync(file, lines.join("\n"))
  return true
}

/** One generation pass against a config that is already resolved. */
export async function generateWith(
  config: ResolvedConfig,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const configured = config.project?.generators ?? {}
  const enabled = (kind: "aot" | "orm"): boolean => {
    if (opts.only && opts.only !== "all" && opts.only !== kind) return false

    return configured[kind] !== false
  }
  const orm = enabled("orm") ? await generateOrmWith(config, opts) : undefined
  const aot = enabled("aot") ? await compileAotWith(config, opts) : undefined

  const generated = config.project?.generated
  const directives: GeneratedOpts = {
    eslintDisable: generated?.eslintDisable,
    knip: generated?.knip,
    knipAutoWrite: generated?.knipAutoWrite,
    marker: generated?.marker,
    tsNocheck: generated?.tsNocheck,
  }
  const aotConfig = configured.aot
  const aotSettings = typeof aotConfig === "object" ? aotConfig : undefined
  const installVia = aotSettings?.installVia ?? "orm"
  const installedIn: string[] = []

  // `installVia: 'orm'` makes the generated façade install the validators on import, so the app
  // needs no manual bootstrap import in its entry point or test setup.
  if (
    aot &&
    orm &&
    installVia === "orm" &&
    insertBootstrapImport(orm, MODULE_SPEC(orm, aot.bootstrap))
  )
    installedIn.push(orm)

  ;(aotSettings?.importIn ?? []).forEach((entry) => {
    const file = resolve(config.root, entry)
    if (aot && insertBootstrapImport(file, MODULE_SPEC(file, aot.bootstrap))) installedIn.push(file)
  })

  const artifacts = [
    ...(orm ? [orm] : []),
    ...(aot ? [aot.synthetic, aot.compiled, aot.bootstrap] : []),
    ...installedIn,
  ]
  const suggested = ignorePatterns(artifacts, config.root)
  const written =
    generated?.knipAutoWrite === true && generated.knip !== "off"
      ? writeIgnores(config.root, artifacts, directives).written
      : []
  return {
    ...(orm ? { orm } : {}),
    ...(aot ? { aot } : {}),
    artifacts,
    ignores: written.length > 0 ? written : suggested,
    installedIn,
  }
}

/** CLI action: resolve the project once, run the configured generators, optionally watch. */
export async function generate(opts: GenerateOpts): Promise<GenerateResult> {
  const config = await resolveOne(opts)
  const result = await generateWith(config, opts)
  if (!opts.watch) return result

  // Watch app SOURCE files — generated files live under `.better-schemic/`, so re-running on our
  // own output would loop forever. One debounced re-run covers multi-file edits.
  const watched = resolve(config.root, dirname(relative(config.root, config.schemaPath)))
  const rerun = debounce(() => {
    void generateWith(config, opts).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
    })
  })
  const onChange = (_event: string, filename: null | string = ""): void => {
    const name = filename ?? ""
    if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(name)) return

    if (name.includes(".better-schemic") || name.includes("generated")) return

    rerun()
  }
  fsWatch(watched, { recursive: true }, onChange)
  console.log(`Watching ${watched} for schema changes…`)
  return result
}
