import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    driver: "src/driver.ts",
    connection: "src/connection.ts",
    query: "src/query.ts",
    orm: "src/orm/index.ts",
  },
  outDir: "lib",
  format: ["esm"],
  target: "esnext",
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep @better-schemic/core external — one shared module instance (its registries/WeakMaps must match
  // the jiti-loaded user schema's, which imports `s` from here -> @better-schemic/core).
  external: ["@better-schemic/core", /^@better-schemic\/core\//],
});
