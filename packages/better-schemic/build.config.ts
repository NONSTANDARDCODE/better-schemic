import { defineBuild } from "../../scripts/build";

export default defineBuild({
  entry: [
    // --- the authoring surface (side-effect-free) ---
    "src/index.ts",
    // --- the engine ---
    "src/driver.ts",
    "src/connection.ts",
    "src/query.ts",
    "src/logger.ts",
    "src/orm/index.ts",
    "src/plugins/rules.ts",
    "src/plugins/zod.ts",
    "src/plugins/timestamps.ts",
    "src/plugins/soft-delete.ts",
    "src/plugins/hard-delete.ts",
    "src/plugins/create-only.ts",
    "src/plugins/tenant.ts",
    // --- the engine internals (the neutral core) ---
    "src/config.ts",
    "src/core/index.ts",
    "src/core/driver/sdk.ts",
    "src/authoring.ts",
    "src/testing.ts",
    // --- the CLI ---
    "src/cli/index.ts",
  ],
  dts: "tsconfig.build.json",
  // Only the CLI entry is a bin — the shebang must NOT land on the library entries.
  shebang: true,
  shebangEntries: ["src/cli/index.ts"],
});
