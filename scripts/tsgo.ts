/**
 * Shared `tsgo` (TypeScript 7 native) resolution — used by the package builder (`build.ts`) and the
 * instantiation-budget runner (`type-bench.ts`).
 */
import nodePath from "node:path"

/** Locate the `tsgo` binary: the package's own devDep first, then the workspace root, then PATH. */
export async function resolveTsgo(pkgDir: string): Promise<string> {
  const root = nodePath.resolve(pkgDir, "../..")
  const found = await Promise.all(
    [
      nodePath.join(pkgDir, "node_modules/.bin/tsgo"),
      nodePath.join(root, "node_modules/.bin/tsgo"),
    ].map(async (candidate) => ((await Bun.file(candidate).exists()) ? candidate : undefined)),
  )
  const candidate = found.find((path) => path !== undefined)
  if (candidate) return candidate

  const which = Bun.which("tsgo", { cwd: pkgDir })
  if (which) return which

  throw new Error(
    "tsgo not found — add `@typescript/native-preview` to the package's devDependencies.",
  )
}
