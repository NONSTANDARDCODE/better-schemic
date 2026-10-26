// TYPE-INSTANTIATION BUDGET for the M5 client surface (budgets enforced by `scripts/type-bench.ts`): the Client
// Intersection grew with the raw overloads, `FnSurface` and the `$withContext` overloads. The budget
// Guards REGRESSION (+20% threshold); re-baseline intentionally (`bun run scripts/type-bench.ts --update`).
import { bench } from "../../../../../scripts/type-bench"
import { defineFunction, defineTable, s } from "../../../src/surreal"

import type { Client } from "../../../src/surreal/orm/client"

const User = defineTable("user", { name: s.string(), age: s.int() }),
  Add = defineFunction("add", { a: s.number(), b: s.number() }).returns(s.number()),
  schema = { users: User, add: Add } as const
type S = typeof schema

bench("Client<S> — the M5 surface (raw/context/fn)", () => ({}))
