const _MAGIC_18 = 18
const _MAGIC_4 = 4
import { describe, it } from "node:test"

import type { RecordId } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import { relation, s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { IncludeArg } from "../../../src/surreal/orm/types/include"
import type { ResultOf, Simplify } from "../../../src/surreal/orm/types/select"
import type { Where } from "../../../src/surreal/orm/types/where"
import type { App } from "../../../src/surreal/pure"

// M3 — TYPE assertions for relations & graph: `include` result shapes (links/edges/edge+target/
// `_count`) and the relational `where` vocabulary, all derived from the authored schema.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

const UserBase = table("user", { age: s.int(), name: s.string() })
const User = UserBase.extend({
  friends: s
    .recordId(() => UserBase)
    .array()
    .optional(),
  mentor: s.recordId(() => UserBase).optional(),
})
const Post = table("post", {
  author: s.recordId(User),
  published: s.boolean(),
  title: s.string(),
})
const Likes = relation("user_likes", { score: s.int() }).from(User).to(Post)
const _schemaDef = schema({ likes: Likes, posts: Post, users: User })
type S = typeof _schemaDef
type U = typeof User
type P = typeof Post
type Row = App<U>

void describe("include — link result shapes", () => {
  void it("true fetches the whole target (null for a missing single link, [] array link)", () => {
    assertType<
      Simplify<Omit<Row, "mentor"> & { mentor: App<U> | null }>,
      ResultOf<U, { include: { mentor: true } }, S>
    >()
    assertType<
      Simplify<Omit<Row, "friends"> & { friends: App<U>[] }>,
      ResultOf<U, { include: { friends: true } }, S>
    >()
  })

  void it("select projects the target; nested include recurses", () => {
    assertType<
      Simplify<
        Omit<Row, "mentor"> & {
          mentor: null | { id: Row["id"]; name: string }
        }
      >,
      ResultOf<U, { include: { mentor: { select: { id: true; name: true } } } }, S>
    >()
    assertType<
      true,
      ResultOf<U, { include: { mentor: { include: { mentor: true } } } }, S> extends {
        mentor: null | { mentor: App<U> | null }
      }
        ? true
        : false
    >()
  })

  void it("unknown keys and `id` are rejected (excess property)", () => {
    // @ts-expect-error — "nope" is not a link/edge/_count
    const bad: IncludeArg<U, S> = { nope: true }
    // @ts-expect-error — `id` is the record identity, not a relation
    const badId: IncludeArg<U, S> = { id: true }
    const _probe_76 = bad
    const _probe_77 = badId
  })
})

void describe("include — edge result shapes", () => {
  void it("true/select return target rows; edge returns edge rows", () => {
    assertType<
      Simplify<Omit<Row, "likes"> & { likes: App<P>[] }>,
      ResultOf<U, { include: { likes: true } }, S>
    >()
    assertType<
      Simplify<Omit<Row, "likes"> & { likes: { title: string }[] }>,
      ResultOf<U, { include: { likes: { select: { title: true } } } }, S>
    >()
    assertType<
      Simplify<Omit<Row, "likes"> & { likes: { score: number }[] }>,
      ResultOf<U, { include: { likes: { edge: { select: { score: true } } } } }, S>
    >()
  })

  void it("edge+target remounts `{ edge, target }`", () => {
    assertType<
      true,
      ResultOf<
        U,
        {
          include: {
            likes: {
              edge: { select: { score: true } }
              target: { select: { id: true; title: true } }
            }
          }
        },
        S
      > extends {
        likes: {
          edge: { score: number }
          target: { id: RecordId; title: string }
        }[]
      }
        ? true
        : false
    >()
  })

  void it("the incoming side types the same way (schema key OR physical name)", () => {
    assertType<
      true,
      ResultOf<P, { include: { likes: true } }, S> extends { likes: App<U>[] } ? true : false
    >()
    assertType<
      true,
      ResultOf<P, { include: { user_likes: true } }, S> extends {
        user_likes: App<U>[]
      }
        ? true
        : false
    >()
  })

  void it("_count types one number per selected relation", () => {
    assertType<
      true,
      ResultOf<U, { include: { _count: { select: { friends: true; likes: true } } } }, S> extends {
        _count: { friends: number; likes: number }
      }
        ? true
        : false
    >()
  })
})

void describe("relational where", () => {
  void it("is/isNot accept a target filter; some/every/none accept edge+target", () => {
    assertType<true, { mentor: { is: { name: "Alice" } } } extends Where<U, S> ? true : false>()
    assertType<true, { mentor: { isNot: { name: "Alice" } } } extends Where<U, S> ? true : false>()
    assertType<true, { likes: { some: { published: true } } } extends Where<U, S> ? true : false>()
    assertType<
      true,
      {
        likes: { direction: "in"; some: { published: true; score: { gt: typeof _MAGIC_4 } } }
      } extends Where<U, S>
        ? true
        : false
    >()
    assertType<
      true,
      { friends: { some: { age: { gt: typeof _MAGIC_18 } } } } extends Where<U, S> ? true : false
    >()
    assertType<
      true,
      { friends: { every: { age: typeof _MAGIC_18 } } } extends Where<U, S> ? true : false
    >()
  })

  void it("wrong-family and wrong-target operators are rejected", () => {
    // @ts-expect-error — `some` on a single link (use is/isNot)
    const bad1: Where<U, S> = { mentor: { some: { name: "x" } } }
    // @ts-expect-error — `is` is not an edge operator
    const bad2: Where<U, S> = { likes: { is: { published: true } } }
    // @ts-expect-error — target filter must match the target table's fields
    const bad3: Where<U, S> = { likes: { some: { nope: true } } }
    const _probe_176 = bad1
    const _probe_177 = bad2
    const _probe_178 = bad3
  })

  void it("the client delegate carries the schema-typed include/where", () => {
    type C = Client<S>
    type Args = Parameters<C["users"]["findMany"]>[0]
    assertType<
      true,
      {
        include: { likes: true; mentor: { select: { name: true } } }
        where: { likes: { some: { published: true } } }
      } extends Args
        ? true
        : false
    >()
  })

  void it("write batches carry the same relational where (they lower it too)", () => {
    type C = Client<S>
    type UpdateArgs = Parameters<C["users"]["updateMany"]>[0]
    type DeleteArgs = Parameters<C["users"]["deleteMany"]>[0]
    type RelateArgs = Parameters<C["likes"]["unrelateMany"]>[0]
    assertType<
      true,
      { where: { likes: { some: { score: { gt: typeof _MAGIC_4 } } } } } extends UpdateArgs
        ? true
        : false
    >()
    assertType<
      true,
      { where: { mentor: { is: { name: "Alice" } } } } extends DeleteArgs ? true : false
    >()
    assertType<
      true,
      { where: { score: { gt: typeof _MAGIC_4 } } } extends RelateArgs ? true : false
    >()
  })
})
