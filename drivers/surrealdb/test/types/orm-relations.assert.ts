// M3 — TYPE assertions for relations & graph: `include` result shapes (links/edges/edge+target/
// `_count`) and the relational `where` vocabulary, all derived from the authored schema.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { RecordId } from "surrealdb";
import { defineRelation, defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import type { IncludeArg } from "../../src/orm/types/include";
import type { ResultOf, Simplify } from "../../src/orm/types/select";
import type { Where } from "../../src/orm/types/where";
import type { App } from "../../src/pure";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

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
const Likes = defineRelation("user_likes", { score: s.int() })
  .from(User)
  .to(Post);
const schema = defineSchema({ users: User, posts: Post, likes: Likes });
type S = typeof schema;
type U = typeof User;
type P = typeof Post;
type Row = App<U>;

describe("include — link result shapes", () => {
  it("true fetches the whole target (null for a missing single link, [] array link)", () => {
    attest<
      Simplify<Omit<Row, "mentor"> & { mentor: App<U> | null }>,
      ResultOf<U, { include: { mentor: true } }, S>
    >();
    attest<
      Simplify<Omit<Row, "friends"> & { friends: App<U>[] }>,
      ResultOf<U, { include: { friends: true } }, S>
    >();
  });

  it("select projects the target; nested include recurses", () => {
    attest<
      Simplify<
        Omit<Row, "mentor"> & {
          mentor: { id: Row["id"]; name: string } | null;
        }
      >,
      ResultOf<
        U,
        { include: { mentor: { select: { id: true; name: true } } } },
        S
      >
    >();
    attest<
      true,
      ResultOf<
        U,
        { include: { mentor: { include: { mentor: true } } } },
        S
      > extends { mentor: { mentor: App<U> | null } | null }
        ? true
        : false
    >();
  });

  it("unknown keys and `id` are rejected (excess property)", () => {
    // @ts-expect-error — "nope" is not a link/edge/_count
    const bad: IncludeArg<U, S> = { nope: true };
    // @ts-expect-error — `id` is the record identity, not a relation
    const badId: IncludeArg<U, S> = { id: true };
    void bad;
    void badId;
  });
});

describe("include — edge result shapes", () => {
  it("true/select return target rows; edge returns edge rows", () => {
    attest<
      Simplify<Omit<Row, "likes"> & { likes: App<P>[] }>,
      ResultOf<U, { include: { likes: true } }, S>
    >();
    attest<
      Simplify<Omit<Row, "likes"> & { likes: { title: string }[] }>,
      ResultOf<U, { include: { likes: { select: { title: true } } } }, S>
    >();
    attest<
      Simplify<Omit<Row, "likes"> & { likes: { score: number }[] }>,
      ResultOf<
        U,
        { include: { likes: { edge: { select: { score: true } } } } },
        S
      >
    >();
  });

  it("edge+target remounts `{ edge, target }`", () => {
    attest<
      true,
      ResultOf<
        U,
        {
          include: {
            likes: {
              edge: { select: { score: true } };
              target: { select: { id: true; title: true } };
            };
          };
        },
        S
      > extends {
        likes: {
          edge: { score: number };
          target: { id: RecordId; title: string };
        }[];
      }
        ? true
        : false
    >();
  });

  it("the incoming side types the same way (schema key OR physical name)", () => {
    attest<
      true,
      ResultOf<P, { include: { likes: true } }, S> extends { likes: App<U>[] }
        ? true
        : false
    >();
    attest<
      true,
      ResultOf<P, { include: { user_likes: true } }, S> extends {
        user_likes: App<U>[];
      }
        ? true
        : false
    >();
  });

  it("_count types one number per selected relation", () => {
    attest<
      true,
      ResultOf<
        U,
        { include: { _count: { select: { likes: true; friends: true } } } },
        S
      > extends { _count: { likes: number; friends: number } }
        ? true
        : false
    >();
  });
});

describe("relational where", () => {
  it("is/isNot accept a target filter; some/every/none accept edge+target", () => {
    attest<
      true,
      { mentor: { is: { name: "Alice" } } } extends Where<U, S> ? true : false
    >();
    attest<
      true,
      { mentor: { isNot: { name: "Alice" } } } extends Where<U, S>
        ? true
        : false
    >();
    attest<
      true,
      { likes: { some: { published: true } } } extends Where<U, S>
        ? true
        : false
    >();
    attest<
      true,
      {
        likes: { some: { score: { gt: 4 }; published: true }; direction: "in" };
      } extends Where<U, S>
        ? true
        : false
    >();
    attest<
      true,
      { friends: { some: { age: { gt: 18 } } } } extends Where<U, S>
        ? true
        : false
    >();
    attest<
      true,
      { friends: { every: { age: 18 } } } extends Where<U, S> ? true : false
    >();
  });

  it("wrong-family and wrong-target operators are rejected", () => {
    // @ts-expect-error — `some` on a single link (use is/isNot)
    const bad1: Where<U, S> = { mentor: { some: { name: "x" } } };
    // @ts-expect-error — `is` is not an edge operator
    const bad2: Where<U, S> = { likes: { is: { published: true } } };
    // @ts-expect-error — target filter must match the target table's fields
    const bad3: Where<U, S> = { likes: { some: { nope: true } } };
    void bad1;
    void bad2;
    void bad3;
  });

  it("the client delegate carries the schema-typed include/where", () => {
    type C = Client<S>;
    type Args = Parameters<C["users"]["findMany"]>[0];
    attest<
      true,
      {
        include: { mentor: { select: { name: true } }; likes: true };
        where: { likes: { some: { published: true } } };
      } extends Args
        ? true
        : false
    >();
  });

  it("write batches carry the same relational where (they lower it too)", () => {
    type C = Client<S>;
    type UpdateArgs = Parameters<C["users"]["updateMany"]>[0];
    type DeleteArgs = Parameters<C["users"]["deleteMany"]>[0];
    type RelateArgs = Parameters<C["likes"]["unrelateMany"]>[0];
    attest<
      true,
      { where: { likes: { some: { score: { gt: 4 } } } } } extends UpdateArgs
        ? true
        : false
    >();
    attest<
      true,
      { where: { mentor: { is: { name: "Alice" } } } } extends DeleteArgs
        ? true
        : false
    >();
    attest<
      true,
      { where: { score: { gt: 4 } } } extends RelateArgs ? true : false
    >();
  });
});
