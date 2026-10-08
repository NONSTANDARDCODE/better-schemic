import { defineBuild } from "../../scripts/build";

// Runs in the USER's environment via `npm create better-schemic` / `bunx`, so it bundles to a single
// self-contained file (no runtime deps) with a node shebang.
export default defineBuild({
  entry: ["src/index.ts"],
  bundleDependencies: true,
  sourcemap: false,
  shebang: true,
});
