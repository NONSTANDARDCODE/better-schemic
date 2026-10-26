// TYPE-INSTANTIATION BUDGETS for the write surface (budgets enforced by `scripts/type-bench.ts`).
// Budget enforced by `scripts/type-bench.ts` (one tsgo program per file, ±20%).
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// Change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`bun run scripts/type-bench.ts --update`) when a change is a known, justified cost.
import { bench } from "../../../../../scripts/type-bench"
import { defineTable, s } from "../../../src/surreal"

import type { Surql } from "../../../src/surreal/frag"
import type {
  BatchWriteResult,
  CreateData,
  CreatedResult,
  UpdateData,
  UpdatedResult,
} from "../../../src/surreal/orm/types/write"
import type { App } from "../../../src/surreal/pure"

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
})
type U = typeof User

bench("CreateData<TD> — the create payload", () => ({}))

bench("UpdateData<TD> — the deep-partial update payload", () => ({}))

bench("CreateData<TD> with an expression field", () => ({}))

bench("CreatedResult<TD> — return dispatch", async () => ({}))

bench("UpdatedResult<TD> — ThrowingResult dispatch", async () => ({}))

bench("CreatedResult<TD> — a projected selection", async () => ({}))

bench("UpdateData<TD> with a numeric adjustment", () => ({}))

bench("BatchWriteResult<TD> — the batch envelope", async () => ({}))

bench("App<TD> — the decoded row (baseline)", () => ({}))
