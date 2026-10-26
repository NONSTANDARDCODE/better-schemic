// TYPE-INSTANTIATION BUDGETS for the read surface (budgets enforced by `scripts/type-bench.ts`).
// Budget enforced by `scripts/type-bench.ts` (one tsgo program per file, ±20%).
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// Change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`bun run scripts/type-bench.ts --update`) when a change is a known, justified cost.
import { bench } from "../../../../../scripts/type-bench"
import { defineTable, s } from "../../../src/surreal"

import type { Surql } from "../../../src/surreal/frag"
import type { AggregateShape, ResultOf } from "../../../src/surreal/orm/types/select"
import type { Where } from "../../../src/surreal/orm/types/where"
import type { App } from "../../../src/surreal/pure"

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
})
type U = typeof User

bench("Where<TD> — nested logical filter", () => ({}))

bench("ResultOf<TD> — select with path/alias/fragment", () => ({}))

bench("ResultOf<TD> — omit/split adjustments", () => ({}))

bench("AggregateShape<TD> — count + avg + collect", () => ({}))

bench("App<TD> — the decoded row (baseline)", () => ({}))
