#!/usr/bin/env bun
/**
 * Bun-native package build — replaces tsup.
 *
 * JS: `Bun.build` bundles one self-contained ESM file per entry (no code splitting; the package's
 * own dependencies stay external for libraries, and get bundled for self-contained bins), mirroring
 * `src/` under `lib/`.
 *
 * Types: `tsgo -p tsconfig.build.json` (TypeScript 7 native) emits the `.d.ts` tree. `bun check`
 * cannot emit declarations, so the TS7 native compiler keeps it for this one pass.
 *
 * Per-package config lives in `build.config.ts` (`defineBuild`). Each package's `build` script runs
 * `bun run ../../scripts/build.ts` from its own root.
 */
import { rm } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveTsgo } from "./tsgo"

export type PackageBuild = {
  /** Bundle the package's dependencies into the output (self-contained bins). Default: external. */
  bundleDependencies?: boolean
  /** Emit declarations with `tsgo -p <file>` (e.g. `tsconfig.build.json`). */
  dts?: false | string
  /** Entry source files, relative to the package root; outputs mirror `src/` under `lib/`. */
  entry: string[]
  /** Prepend `#!/usr/bin/env node` to each emitted JS entry (bins). Default: false. */
  shebang?: boolean
  /**
   * The entries that get the shebang, when the package mixes bins and libraries (e.g. the CLI entry
   * of a package that also ships library entries). Paths are SOURCE entries (as in `entry`).
   * Ignored when `shebang` is false; when `shebang` is true and this sets it,  these entries
   * get it.
   */
  shebangEntries?: string[]
  /** Emit linked `.js.map` files. Default: true. */
  sourcemap?: boolean
}

export function defineBuild(config: PackageBuild): PackageBuild {
  return config
}

const SHEBANG = "#!/usr/bin/env node\n"

async function main(): Promise<void> {
  const pkgDir = process.cwd()
  const configPath = join(pkgDir, "build.config.ts")
  if (!(await Bun.file(configPath).exists()))
    throw new Error(`no build.config.ts in ${pkgDir} — run this from a package root.`)

  const { default: config } = (await import(pathToFileURL(configPath).href)) as {
    default: PackageBuild
  }

  const started = performance.now()
  const outDir = join(pkgDir, "lib")
  // Own the clean: `lib/` generates it output , and a stale file must never survive a build.
  await rm(outDir, { force: true, recursive: true })

  const result = await Bun.build({
    entrypoints: config.entry.map((entry) => join(pkgDir, entry)),
    external: ["bun:test"],
    format: "esm",
    outdir: outDir,
    // Libraries keep deps external (tsup auto-externalized package deps/peers); bins bundle
    // everything they import so they run without node_modules.
    packages: config.bundleDependencies ? "bundle" : "external",
    root: join(pkgDir, "src"),
    sourcemap: (config.sourcemap ?? true) ? "linked" : "none",
    splitting: false,
    target: "node",
  })

  if (!result.success) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const log of result.logs) console.error(`[build] ${log.level}: ${log.message}`)

    process.exit(1)
  }

  if (config.shebang) {
    // The entry's OUTPUT path mirrors its source path under `lib/` — so a `shebangEntries` source
    // maps to the output that Bun wrote for it.
    const shebangOutputs = config.shebangEntries
      ? new Set(
          config.shebangEntries.map((entry) =>
            // the source entry mirrors under `lib/` with a `.js` extension
            join(
              outDir,
              relative(join(pkgDir, "src"), join(pkgDir, entry)).replace(/\.ts$/u, ".js"),
            ),
          ),
        )
      : null
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const output of result.outputs) {
      if (output.kind !== "entry-point" || !output.path.endsWith(".js")) continue

      if (shebangOutputs && !shebangOutputs.has(output.path)) continue

      const source = await output.text()
      // Bun.build has no `banner` in every Bun version we support — own the shebang instead.
      if (!source.startsWith("#!")) await Bun.write(output.path, SHEBANG + source)
    }
  }

  if (config.dts) {
    const tsgo = await resolveTsgo(pkgDir)
    const proc = Bun.spawnSync([tsgo, "-p", config.dts], {
      cwd: pkgDir,
      stdio: ["inherit", "inherit", "inherit"],
    })
    if (proc.exitCode !== 0) {
      console.error(`[build] declarations failed: tsgo -p ${config.dts}`)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `exitCode` pode ser null em runtime quando o processo foi sinalizado.
      process.exit(proc.exitCode ?? 1)
    }
  }

  const emitted = result.outputs.filter((output) => output.kind === "entry-point").length
  console.log(
    `[build] ${pkgDir}: ${emitted} entr${emitted === 1 ? "y" : "ies"}${
      config.dts ? " + declarations" : ""
    } in ${Math.round(performance.now() - started)}ms`,
  )
}

// `build.config.ts` imports `defineBuild` from this module — never run the build on a bare import.
if (import.meta.main) await main()
