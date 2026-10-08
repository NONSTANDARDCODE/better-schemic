// TYPE-INSTANTIATION BUDGETS for the relations/graph surface (budgets enforced by `scripts/type-bench.ts`).
// Budget enforced by `scripts/type-bench.ts` (one tsgo program per file, ±20%).
//
// The number is the instantiations the expression's TYPE triggers; the budget guards REGRESSION — a
// change that makes a generic materially more expensive blows the +20% threshold and fails.
// Re-baseline intentionally (`bun run scripts/type-bench.ts --update`) when a change is a known, justified cost.
import { bench } from "../../../../scripts/type-bench";
import { defineRelation, defineTable, s } from "../../src/index";
import type { IncludeArg } from "../../src/orm/types/include";
import type { ResultOf } from "../../src/orm/types/select";
import type { Where } from "../../src/orm/types/where";

const UserBase = defineTable("user", { name: s.string(), age: s.int() });
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
  friends: s
    .recordId(() => UserBase)
    .array()
    .optional(),
});
const Post = defineTable("post", {
  title: s.string(),
  published: s.boolean(),
  author: s.recordId(User),
});
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);
const schema = {
  users: User,
  posts: Post,
  likes: Likes,
} as const;
type S = typeof schema;
type U = typeof User;

bench("IncludeArg<TD, S> — links + edges + _count", () => {
  return {} as IncludeArg<U, S>;
});

bench("Where<TD, S> — relational operators", () => {
  return {} as Where<U, S>;
});

bench("ResultOf<TD, A, S> — include with select/_count", () => {
  return {} as ResultOf<
    U,
    {
      include: {
        mentor: { select: { id: true; name: true } };
        likes: { select: { title: true } };
        _count: { select: { likes: true } };
      };
    },
    S
  >;
});
