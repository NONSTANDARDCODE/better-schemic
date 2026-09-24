import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    driver: "src/driver.ts",
    connection: "src/connection.ts",
    query: "src/query.ts",
    logger: "src/logger.ts",
    "orm/index": "src/orm/index.ts",
    "plugins/rules": "src/plugins/rules.ts",
    "plugins/zod": "src/plugins/zod.ts",
    "plugins/timestamps": "src/plugins/timestamps.ts",
    "plugins/soft-delete": "src/plugins/soft-delete.ts",
  },
  outDir: "lib",
  format: ["esm"],
  target: "esnext",
  // Declarations are NOT emitted here: rollup-plugin-dts ran one TS program per entry and its worker
  // blew past its ~2 GB heap on the 10-entry graph (zod-driven type instantiation). A single
  // `tsc -p tsconfig.build.json` pass emits the whole tree's `.d.ts` in ~40 s / <1 GB. See package.json.
  dts: false,
  clean: true,
  sourcemap: true,
  // Keep @better-schemic/core external — one shared module instance (its registries/WeakMaps must match
  // the jiti-loaded user schema's, which imports `s` from here -> @better-schemic/core).
  external: ["@better-schemic/core", /^@better-schemic\/core\//],
});
