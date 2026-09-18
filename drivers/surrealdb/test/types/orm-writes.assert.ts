// M2.8 — TYPE assertions for the write surface: per-op args (`create`/`insert`/`update`/`patch`/
// `upsert`/`delete`/`updateEach`/`relate`), the result envelopes dispatched by `return`, the
// expression-carrying `data`, and the relation-only RELATE surface. Run under node/tsx:
// `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest, setup, teardown } from "@ark/attest";
import type { Surql } from "../../src/frag";
import { defineRelation, defineTable, s, surql } from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { ModelDelegate } from "../../src/orm/delegate";
import type { BatchResult, ThrowingResult } from "../../src/orm/results";
import { defineSchema } from "../../src/orm/schema";
import type {
  BatchWriteResult,
  CreatedResult,
  DeletedResult,
  UpdateData,
  UpdatedResult,
  UpdateEachItem,
  WriteData,
  WrittenResult,
} from "../../src/orm/types/write";
import type { App } from "../../src/pure";

let cleanup: (() => void) | undefined;
before(() => {
  cleanup = setup() as unknown as () => void;
});
after(() => {
  cleanup?.();
  teardown();
});

const User = defineTable("user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
}).index("uniq_email", ["email"], { unique: true });
const Post = defineTable("post", { title: s.string() });
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);
const schema = defineSchema({ users: User, posts: Post, likes: Likes });
type U = typeof User;
type Row = App<U>;
type C = Client<typeof schema>;
type Users = C["users"];
type Likess = C["likes"];
type L = typeof Likes;

declare const client: C;

/**
 * TYPE-ONLY probes: the closure is never invoked (attest/tsc check the delegate signatures; running
 * them would need a real connection). The `@ts-expect-error` directives live here too.
 */
function typeProbes(): void {
  const created: Promise<BatchResult<Row>> = client.users.createMany({
    data: [
      {
        name: "A",
        email: "a@x",
        age: 1,
        active: true,
        tags: [],
        address: { city: "X", country: "Y" },
      },
    ],
  });
  void created;

  void client.users.create({
    data: {
      name: "Aeon",
      email: "aeon@x",
      age: 30,
      active: true,
      tags: [],
      address: { city: "SP", country: "BR" },
    },
  });
  void client.users.update({
    where: { id: "user:a" },
    data: { age: 31 },
  });
  void client.users.update({
    where: { id: "user:a" },
    data: { age: surql`age + ${1}`.as<number>() },
  });
  // @ts-expect-error — "old" is not assignable to the int field
  void client.users.update({ where: { id: "user:a" }, data: { age: "old" } });

  void client.users.upsert({ where: { id: "user:a" }, data: { age: 1 } });
  void client.users.upsert({
    where: { id: "user:a" },
    create: {
      name: "A",
      email: "a@x",
      age: 1,
      active: true,
      tags: [],
      address: { city: "X", country: "Y" },
    },
    update: { age: 2 },
  });
  void client.users.updateMany({ data: { active: false } });
  void client.users.deleteMany({ where: { age: { lt: 1 } } });
  // @ts-expect-error — delete does not accept "after"
  void client.users.delete({ where: { id: "user:a" }, return: "after" });

  void client.users.updateEach({
    data: [
      { id: "user:a", age: 1 },
      { id: "user:b", age: 2 },
    ],
  });
  void client.users.updateEach({
    by: "email",
    data: [{ email: "a@x", age: 3 }],
    onEmpty: "throw",
  });
  void client.users.updateEach({
    by: "email",
    // @ts-expect-error — `by: "email"` items must carry email
    data: [{ id: "user:a", age: 3 }],
  });

  void client.posts.create({
    data: { title: "T" },
    relate: [{ from: "user:a", edge: "likes", to: "$self" }],
    return: "none",
  });
  void client.posts.create({
    data: { title: "T" },
    relate: [{ from: "user:a", edge: "likes", to: "$self" }],
    return: "before",
  });
  // @ts-expect-error — the relate batch rejects RETURN DIFF
  void client.posts.create({
    data: { title: "T" },
    relate: [{ from: "user:a", edge: "likes", to: "$self" }],
    return: "diff",
  });

  void client.likes.relate({
    from: "user:a",
    to: "post:p",
    data: { score: 5 },
  });
  void client.likes.relateMany({
    data: [
      { from: "user:a", to: "post:p" },
      { from: "user:b", to: "post:p", id: "first", data: { score: 1 } },
    ],
  });
  void client.likes.unrelate({ from: "user:a", to: "post:p" });
  void client.likes.unrelateMany({ where: { score: { lt: 3 } } });
  // @ts-expect-error — an endpoint can not be null
  void client.likes.relate({ from: null, to: "post:p" });
}
void typeProbes;

describe("write results dispatch on the `return` literal", () => {
  it("create resolves rows; none/before are null; diff is unknown[]", () => {
    attest<Promise<Row>, CreatedResult<U, Record<string, never>>>();
    attest<Promise<Row>, CreatedResult<U, { return: "after" }>>();
    attest<Promise<null>, CreatedResult<U, { return: "none" }>>();
    attest<Promise<null>, CreatedResult<U, { return: "before" }>>();
    attest<Promise<unknown[]>, CreatedResult<U, { return: "diff" }>>();
  });

  it("insert/upsert `before` exposes the previous row (or null when created)", () => {
    attest<Promise<Row | null>, WrittenResult<U, { return: "before" }>>();
    attest<Promise<Row>, WrittenResult<U, Record<string, never>>>();
    attest<Promise<null>, WrittenResult<U, { return: "none" }>>();
    attest<Promise<unknown[]>, WrittenResult<U, { return: "diff" }>>();
  });

  it("update/patch are ThrowingResults (a miss resolves null)", () => {
    attest<ThrowingResult<Row>, UpdatedResult<U, Record<string, never>>>();
    attest<ThrowingResult<Row>, UpdatedResult<U, { return: "before" }>>();
    attest<Promise<null>, UpdatedResult<U, { return: "none" }>>();
    attest<Promise<unknown[]>, UpdatedResult<U, { return: "diff" }>>();
  });

  it("delete only accepts before|none", () => {
    attest<ThrowingResult<Row>, DeletedResult<U, Record<string, never>>>();
    attest<Promise<null>, DeletedResult<U, { return: "none" }>>();
  });

  it("batches resolve a BatchResult, a patch list with diff", () => {
    attest<
      Promise<BatchResult<Row>>,
      BatchWriteResult<U, Record<string, never>>
    >();
    attest<Promise<unknown[]>, BatchWriteResult<U, { return: "diff" }>>();
  });
});

describe("write data accepts fragments and partial updates", () => {
  it("WriteData allows a surql expression per field", () => {
    attest<
      true,
      { age: Surql<[number]> } extends WriteData<{ age: number }> ? true : false
    >();
    attest<
      true,
      { name: string } extends WriteData<{ name: string }> ? true : false
    >();
  });

  it("UpdateData is deep-partial (id/readonly excluded by the codec shape)", () => {
    attest<true, { age: number } extends UpdateData<U> ? true : false>();
    attest<true, { age: 1 } extends UpdateData<U> ? true : false>();
  });
});

describe("updateEach and relate are typed", () => {
  it("updateEach items carry the by field plus update data", () => {
    attest<
      false,
      { id: string; age: number } extends UpdateEachItem<U, "email">
        ? true
        : false
    >();
    attest<
      true,
      { email: string; age: number } extends UpdateEachItem<U, "email">
        ? true
        : false
    >();
  });

  it("only RELATION delegates expose relate/unrelate", () => {
    attest<true, "relate" extends keyof Likess ? true : false>();
    attest<true, "relateMany" extends keyof Likess ? true : false>();
    attest<true, "unrelate" extends keyof Likess ? true : false>();
    attest<false, "relate" extends keyof Users ? true : false>();
    attest<true, Likess extends ModelDelegate<L> ? true : false>();
  });

  it("the delegate exposes the write surface", () => {
    attest<true, "create" extends keyof Users ? true : false>();
    attest<true, "createMany" extends keyof Users ? true : false>();
    attest<true, "insert" extends keyof Users ? true : false>();
    attest<true, "insertMany" extends keyof Users ? true : false>();
    attest<true, "update" extends keyof Users ? true : false>();
    attest<true, "patch" extends keyof Users ? true : false>();
    attest<true, "upsert" extends keyof Users ? true : false>();
    attest<true, "delete" extends keyof Users ? true : false>();
    attest<true, "updateEach" extends keyof Users ? true : false>();
  });
});
