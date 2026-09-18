// TYPE-INSTANTIATION BUDGETS for the read surface (@ark/attest `bench().types()`).
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`ATTEST_updateSnapshots=1`) when a change is a known, justified cost.
import { bench } from "@ark/attest";
import type { Surql } from "../../src/frag";
import { defineTable, s } from "../../src/index";
import type { AggregateShape, ResultOf } from "../../src/orm/types/select";
import type { Where } from "../../src/orm/types/where";
import type { App } from "../../src/pure";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
});
type U = typeof User;

bench("Where<TD> — nested logical filter", () => {
  return {} as Where<U>;
}).types([77186, "instantiations"]);

bench("ResultOf<TD> — select with path/alias/fragment", () => {
  return {} as ResultOf<
    U,
    {
      select: {
        id: true;
        "address.city": true;
        city: "address.city";
        bump: Surql<[number]>;
      };
    }
  >;
}).types([77561, "instantiations"]);

bench("ResultOf<TD> — omit/split adjustments", () => {
  return {} as ResultOf<U, { omit: ["age"]; split: "tags" }>;
}).types([77238, "instantiations"]);

bench("AggregateShape<TD> — count + avg + collect", () => {
  return {} as AggregateShape<
    U,
    { _count: true; avgAge: { avg: "age" }; names: { collect: "name" } }
  >;
}).types([76263, "instantiations"]);

bench("App<TD> — the decoded row (baseline)", () => {
  return {} as App<U>;
}).types([11765, "instantiations"]);
