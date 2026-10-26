// TYPE-INSTANTIATION BUDGETS for core's zod-coupled authoring type utilities.
// Type-checked by `bun check`; the budget is enforced by `scripts/type-bench.ts` (one tsgo
// Program per bench file, ±20% regression threshold). See docs/TYPE-PERF-TESTING.md.
//
// The budget guards REGRESSION — a change that makes a generic materially more expensive blows the
// Threshold and fails. Absolute counts include the imported type surface (~zod's floor), so watch
// The DELTA, not the magnitude. Re-baseline intentionally (`bun run scripts/type-bench.ts --update`).
import { bench } from "../../../../../scripts/type-bench"

import type { InnerOf, SchemaOf } from "../../../src/core/authoring"
import type * as z from "zod"

bench("InnerOf unwraps one wrapper level", () => ({}))

bench("SchemaOf passes a raw zod schema through", () => ({}))
