// TYPE-INSTANTIATION BUDGETS for the write surface (budgets enforced by `scripts/type-bench.ts`).
// Budget enforced by `scripts/type-bench.ts` (one tsgo program per file, ±20%).
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`bun run scripts/type-bench.ts --update`) when a change is a known, justified cost.
import { bench } from "../../../../scripts/type-bench";
import type { Surql } from "../../src/frag";
import { defineTable, s } from "../../src/index";
import type {
  BatchWriteResult,
  CreateData,
  CreatedResult,
  UpdateData,
  UpdatedResult,
} from "../../src/orm/types/write";
import type { App } from "../../src/pure";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
});
type U = typeof User;

bench("CreateData<TD> — the create payload", () => {
  return {} as CreateData<U>;
});

bench("UpdateData<TD> — the deep-partial update payload", () => {
  return {} as UpdateData<U>;
});

bench("CreateData<TD> with an expression field", () => {
  return {} as CreateData<U> & { age: Surql<[number]> };
});

bench("CreatedResult<TD> — return dispatch", () => {
  return {} as CreatedResult<U, { return: "none" }>;
});

bench("UpdatedResult<TD> — ThrowingResult dispatch", () => {
  return {} as UpdatedResult<U, { return: "before" }>;
});

bench("CreatedResult<TD> — a projected selection", () => {
  return {} as CreatedResult<U, { select: { name: true; age: true } }>;
});

bench("UpdateData<TD> with a numeric adjustment", () => {
  return {} as UpdateData<U> & { age: { increment: number } };
});

bench("BatchWriteResult<TD> — the batch envelope", () => {
  return {} as BatchWriteResult<U, Record<string, never>>;
});

bench("App<TD> — the decoded row (baseline)", () => {
  return {} as App<U>;
});
