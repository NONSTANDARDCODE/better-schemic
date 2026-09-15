import { defineConfig } from "tsup";

// The `create-better-schemic` bin — runs in the USER's environment via `npm create better-schemic` / `bunx`, so it
// targets node (clean shebang) and bundles to a single self-contained file with no runtime deps.
export default defineConfig({
  entry: { index: "src/index.ts" },
  outDir: "lib",
  format: ["esm"],
  target: "node18",
  dts: false,
  clean: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
