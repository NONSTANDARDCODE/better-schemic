import { defineBuild } from "../../scripts/build";

export default defineBuild({
  entry: [
    "src/index.ts",
    "src/driver.ts",
    "src/connection.ts",
    "src/query.ts",
    "src/logger.ts",
    "src/orm/index.ts",
    "src/plugins/rules.ts",
    "src/plugins/zod.ts",
    "src/plugins/timestamps.ts",
    "src/plugins/soft-delete.ts",
    "src/plugins/create-only.ts",
    "src/plugins/tenant.ts",
  ],
  dts: "tsconfig.build.json",
});
