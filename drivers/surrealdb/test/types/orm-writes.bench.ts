// TYPE-INSTANTIATION BUDGETS for the write surface (@ark/attest `bench().types()`).
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`ATTEST_updateSnapshots=1`) when a change is a known, justified cost.
import { bench } from "@ark/attest";
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
}).types([87221, "instantiations"]);

bench("UpdateData<TD> — the deep-partial update payload", () => {
  return {} as UpdateData<U>;
}).types([87173, "instantiations"]);

bench("CreateData<TD> with an expression field", () => {
  return {} as CreateData<U> & { age: Surql<[number]> };
}).types([87267, "instantiations"]);

bench("CreatedResult<TD> — return dispatch", () => {
  return {} as CreatedResult<U, { return: "none" }>;
}).types([76076, "instantiations"]);

bench("UpdatedResult<TD> — ThrowingResult dispatch", () => {
  return {} as UpdatedResult<U, { return: "before" }>;
}).types([77010, "instantiations"]);

bench("BatchWriteResult<TD> — the batch envelope", () => {
  return {} as BatchWriteResult<U, Record<string, never>>;
}).types([76065, "instantiations"]);

bench("App<TD> — the decoded row (baseline)", () => {
  return {} as App<U>;
}).types([11765, "instantiations"]);
