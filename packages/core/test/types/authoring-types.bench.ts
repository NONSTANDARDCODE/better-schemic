// TYPE-INSTANTIATION BUDGETS for core's zod-coupled authoring type utilities.
// Type-checked by `bun check`; the budget is enforced by `scripts/type-bench.ts` (one tsgo
// program per bench file, ±20% regression threshold). See docs/TYPE-PERF-TESTING.md.
//
// The budget guards REGRESSION — a change that makes a generic materially more expensive blows the
// threshold and fails. Absolute counts include the imported type surface (~zod's floor), so watch
// the DELTA, not the magnitude. Re-baseline intentionally (`bun run scripts/type-bench.ts --update`).
import { bench } from "../../../../scripts/type-bench";
import type * as z from "zod";
import type { InnerOf, SchemaOf } from "../../src/authoring";

bench("InnerOf unwraps one wrapper level", () => {
  return {} as InnerOf<z.ZodOptional<z.ZodString>>;
});

bench("SchemaOf passes a raw zod schema through", () => {
  return {} as SchemaOf<z.ZodString>;
});
