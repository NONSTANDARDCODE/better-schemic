import { defineBuild } from "../../scripts/build";

export default defineBuild({
  entry: ["src/cli/index.ts"],
  sourcemap: false,
  shebang: true,
});
