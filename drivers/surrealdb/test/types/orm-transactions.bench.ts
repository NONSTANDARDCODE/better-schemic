// TYPE-INSTANTIATION BUDGET for the transaction client surface (@ark/attest `bench().types()`).
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`ATTEST_updateSnapshots=1`) when a change is a known, justified cost.
import { bench } from "@ark/attest";
import { defineRelation, defineTable, s } from "../../src/index";
import type { TransactionClient } from "../../src/orm/types/transaction";

const UserBase = defineTable("user", { name: s.string(), age: s.int() });
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
});
const Post = defineTable("post", {
  title: s.string(),
  author: s.recordId(User),
});
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);
const schema = {
  users: User,
  posts: Post,
  likes: Likes,
} as const;
type S = typeof schema;

bench("TransactionClient<S> — the tx-bound client surface", () => {
  return {} as TransactionClient<S>;
}).types([19799, "instantiations"]);
