import { defineBuild } from "../../scripts/build"

// Runs in the USER's environment via `npm create better-schemic` / `bunx`, so it bundles to a single
// self-contained file (no runtime deps) with a node shebang.
export default defineBuild({
  bundleDependencies: true,
  entry: ["src/index.ts"],
  shebang: true,
  sourcemap: false,
})
