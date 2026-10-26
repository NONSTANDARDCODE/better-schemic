#!/usr/bin/env bun
/**
 * Bun-native package build — replaces tsup.
 *
 * JS: `Bun.build` bundles one self-contained ESM file per entry (no code splitting; the package's
 * own dependencies stay external for libraries, and get bundled for self-contained bins), mirroring
 * `src/` under `lib/`.
 *
 * Types: `tsgo -p tsconfig.build.json` (TypeScript 7 native) emits the `.d.ts` tree. `bun check`
 * cannot emit declarations, so the TS7 native compiler is kept for this one pass.
 *
 * Per-package config lives in `build.config.ts` (`defineBuild`). Each package's `build` script runs
 * `bun run ../../scripts/build.ts` from its own root.
 */
import { rm } from "node:fs/promises"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveTsgo } from "./tsgo"

export interface PackageBuild {
  /** Entry source files, relative to the package root; outputs mirror `src/` under `lib/`. */
  entry: string[]
  /** Emit declarations with `tsgo -p <file>` (e.g. `tsconfig.build.json`). */
  dts?: string | false
  /** Bundle the package's dependencies into the output (self-contained bins). Default: external. */
  bundleDependencies?: boolean
  /** Emit linked `.js.map` files. Default: true. */
  sourcemap?: boolean
  /** Prepend `#!/usr/bin/env node` to each emitted JS entry (bins). Default: false. */
  shebang?: boolean
  /**
   * The entries that get the shebang, when the package mixes bins and libraries (e.g. the CLI entry
   * of a package that also ships library entries). Paths are SOURCE entries (as in `entry`).
   * Ignored when `shebang` is false; when `shebang` is true and this is set, ONLY these entries
   * get it.
   */
  shebangEntries?: string[]
}

export function defineBuild(config: PackageBuild): PackageBuild {
  return config
}

const SHEBANG = "#!/usr/bin/env node\n"

async function main(): Promise<void> {
  const pkgDir = process.cwd(),
    configPath = join(pkgDir, "build.config.ts")
  if (!(await Bun.file(configPath).exists()))
    throw new Error(`no build.config.ts in ${pkgDir} — run this from a package root.`)

  const { default: config } = (await import(pathToFileURL(configPath).href)) as {
      default: PackageBuild
    },
    started = performance.now(),
    outDir = join(pkgDir, "lib")
  // Own the clean: `lib/` is generated output only, and a stale file must never survive a build.
  await rm(outDir, { recursive: true, force: true })

  const result = await Bun.build({
    entrypoints: config.entry.map((entry) => join(pkgDir, entry)),
    root: join(pkgDir, "src"),
    outdir: outDir,
    format: "esm",
    target: "node",
    splitting: false,
    sourcemap: (config.sourcemap ?? true) ? "linked" : "none",
    // Libraries keep deps external (tsup auto-externalized package deps/peers); bins bundle
    // Everything they import so they run without node_modules.
    packages: config.bundleDependencies ? "bundle" : "external",
    external: ["bun:test"],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(`[build] ${log.level}: ${log.message}`)

    process.exit(1)
  }

  if (config.shebang) {
    // The entry's OUTPUT path mirrors its source path under `lib/` — so a `shebangEntries` source
    // Maps to the output that Bun wrote for it.
    const shebangOutputs = config.shebangEntries
      ? new Set(
          config.shebangEntries.map((entry) =>
            // The source entry mirrors under `lib/` with a `.js` extension
            join(
              outDir,
              relative(join(pkgDir, "src"), join(pkgDir, entry)).replace(/\.ts$/, ".js"),
            ),
          ),
        )
      : null
    for (const output of result.outputs) {
      if (output.kind !== "entry-point" || !output.path.endsWith(".js")) continue

      if (shebangOutputs && !shebangOutputs.has(output.path)) continue
      const source = await output.text()
      // Bun.build has no `banner` in every Bun version we support — own the shebang instead.
      if (!source.startsWith("#!")) await Bun.write(output.path, SHEBANG + source)
    }
  }

  if (config.dts) {
    const tsgo = await resolveTsgo(pkgDir),
      proc = Bun.spawnSync([tsgo, "-p", config.dts], {
        cwd: pkgDir,
        stdio: ["inherit", "inherit", "inherit"],
      })
    if (proc.exitCode !== 0) {
      console.error(`[build] declarations failed: tsgo -p ${config.dts}`)
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
