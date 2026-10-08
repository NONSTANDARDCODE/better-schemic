import { defineBuild } from "../../scripts/build";

export default defineBuild({
  entry: [
    "src/index.ts",
    "src/config.ts",
    "src/driver/sdk.ts",
    "src/authoring.ts",
    "src/testing.ts",
  ],
  dts: "tsconfig.build.json",
});
