// TYPE-INSTANTIATION BUDGET for the M5 client surface (budgets enforced by `scripts/type-bench.ts`): the Client
// intersection grew with the raw overloads, `FnSurface` and the `$withContext` overloads. The budget
// guards REGRESSION (+20% threshold); re-baseline intentionally (`bun run scripts/type-bench.ts --update`).
import { bench } from "../../../../scripts/type-bench";
import { defineFunction, defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";

const User = defineTable("user", { name: s.string(), age: s.int() });
const Add = defineFunction("add", { a: s.number(), b: s.number() }).returns(
  s.number(),
);
const schema = { users: User, add: Add } as const;
type S = typeof schema;

bench("Client<S> — the M5 surface (raw/context/fn)", () => {
  return {} as Client<S>;
});
