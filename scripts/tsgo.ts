/**
 * Shared `tsgo` (TypeScript 7 native) resolution — used by the package builder (`build.ts`) and the
 * instantiation-budget runner (`type-bench.ts`).
 */
import nodePath from "node:path"

/** Locate the `tsgo` binary: the package's own devDep first, then the workspace root, then PATH. */
export async function resolveTsgo(pkgDir: string): Promise<string> {
  const root = nodePath.resolve(pkgDir, "../..")
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const candidate of [
    nodePath.join(pkgDir, "node_modules/.bin/tsgo"),
    nodePath.join(root, "node_modules/.bin/tsgo"),
  ])
    if (await Bun.file(candidate).exists()) return candidate

  const which = Bun.which("tsgo", { cwd: pkgDir })
  if (which) return which

  throw new Error(
    "tsgo not found — add `@typescript/native-preview` to the package's devDependencies.",
  )
}
