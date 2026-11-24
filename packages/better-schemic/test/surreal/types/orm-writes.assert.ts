// M2.8 — TYPE assertions for the write surface: per-op args (`create`/`insert`/`update`/`patch`/
// `upsert`/`delete`/`updateEach`/`relate`), the result envelopes dispatched by `return`, the
// expression-carrying `data`, and the relation-RELATE surface.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { relation, s, surql, table } from "../../../src/surreal"
import type { Surql } from "../../../src/surreal/frag"
import type { Client } from "../../../src/surreal/orm/client"
import type { ModelDelegate } from "../../../src/surreal/orm/delegate"
import type { BatchResult, ThrowingResult } from "../../../src/surreal/orm/results"
import { schema } from "../../../src/surreal/orm/schema"
import type {
  BatchWriteResult,
  CreatedResult,
  DeletedResult,
  DeltaKey,
  FieldDelta,
  UpdateData,
  UpdatedResult,
  UpdateEachItem,
  UpsertDeltaResult,
  WriteData,
  WrittenResult,
} from "../../../src/surreal/orm/types/write"
import type { App } from "../../../src/surreal/pure"

const User = table("user", {
  active: s.boolean(),
  address: s.object({ city: s.string(), country: s.string() }),
  age: s.int(),
  email: s.string(),
  name: s.string(),
  tags: s.array(s.string()),
}).index("uniq_email", ["email"], { unique: true })
const Post = table("post", { title: s.string() })
const Likes = relation("likes", { score: s.int() }).from(User).to(Post)
const _schemaDef = schema({ likes: Likes, posts: Post, users: User })
type U = typeof User
type Row = App<U>
type C = Client<typeof _schemaDef>
type Users = C["users"]
type Likess = C["likes"]
type L = typeof Likes

declare const client: C

/**
 * TYPE- probes: the closure is never invoked (tsgo checks the delegate signatures; running
 * them would need a real connection). The `@ts-expect-error` directives live here too.
 */
function typeProbes(): void {
  const created: Promise<BatchResult<Row>> = client.users.createMany({
    data: [
      {
        active: true,
        address: { city: "X", country: "Y" },
        age: 1,
        email: "a@x",
        name: "A",
        tags: [],
      },
    ],
  })
  void created

  void client.users.create({
    data: {
      active: true,
      address: { city: "SP", country: "BR" },
      age: 30,
      email: "aeon@x",
      name: "Aeon",
      tags: [],
    },
  })
  void client.users.update({
    data: { age: 31 },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { age: surql`age + ${1}`.as<number>() },
    where: { id: "user:a" },
  })
  // @ts-expect-error — "old" is not assignable to the int field
  void client.users.update({ data: { age: "old" }, where: { id: "user:a" } })

  void client.users.upsert({ data: { age: 1 }, where: { id: "user:a" } })
  void client.users.upsert({
    data: { age: 1 },
    onMissing: "create",
    where: { id: "user:a" },
  })
  void client.users.upsert({
    create: {
      active: true,
      address: { city: "X", country: "Y" },
      age: 1,
      email: "a@x",
      name: "A",
      tags: [],
    },
    onMissing: "create",
    update: { age: 2 },
    where: { id: "user:a" },
  })
  void client.users.upsert({
    data: { age: 1 },
    // @ts-expect-error — onMissing is "create" | "throw"
    onMissing: "nope",
    where: { id: "user:a" },
  })
  const _upserted = client.users.upsert({
    data: { age: 1 },
    where: { id: "user:a" },
  })
  assertType<Promise<Row>, typeof _upserted>()

  // A target-less `upsert` is a plain CREATE; `data.id` alone infers the strict id target.
  const _targetless = client.users.upsert({
    data: {
      active: true,
      address: { city: "X", country: "Y" },
      age: 2,
      email: "b@x",
      name: "B",
      tags: [],
    },
  })
  assertType<Promise<Row>, typeof _targetless>()
  void client.users.upsert({ data: { age: 2, id: "user:b" } })
  void client.users.upsert({
    data: { age: 2, id: "user:b" },
    onMissing: "create",
  })

  void client.users.upsertDelta({ data: { age: 1 }, where: { id: "user:a" } })
  void client.users.upsertDelta({ data: { age: 2, id: "user:a" } })
  void client.users.upsertDelta({
    data: { age: 1 },
    onMissing: "throw",
    timeout: "5s",
    where: { id: "user:a" },
  })
  void client.users.upsertDelta({
    create: {
      active: true,
      address: { city: "X", country: "Y" },
      age: 1,
      email: "a@x",
      name: "A",
      tags: [],
    },
    mode: "merge",
    update: { age: 2 },
    where: { id: "user:a" },
  })
  void client.users.upsertDelta({
    data: { age: surql`age + 1`.as<number>(), email: "a@x" },
    mode: "set",
    where: { email: "a@x" },
  })
  void client.users.upsertDelta({
    data: { age: 1 },
    // @ts-expect-error — mode "patch" is not part of upsertDelta
    mode: "patch",
    where: { id: "user:a" },
  })
  void client.users.upsertDelta({
    data: { age: 1 },
    // @ts-expect-error — onMissing is "create" | "throw"
    onMissing: "nope",
    where: { id: "user:a" },
  })
  void client.users.upsertDelta({
    // @ts-expect-error — "old" is not assignable to the int field
    data: { age: "old" },
    where: { id: "user:a" },
  })

  // The result envelope narrows on `created` (tsgo checks each branch at compile time).
  const deltaResult = client.users.upsertDelta({
    data: { age: 1 },
    where: { id: "user:a" },
  })
  assertType<Promise<UpsertDeltaResult<U>>, typeof deltaResult>()
  void deltaResult.then((row) => {
    if (row.created) {
      assertType<null, typeof row.before>()
      assertType<null, typeof row.delta>()
      assertType<readonly [], typeof row.changed>()
    } else {
      assertType<Row, typeof row.before>()
      assertType<FieldDelta<Row> | null, typeof row.delta>()
      assertType<readonly DeltaKey<Row>[], typeof row.changed>()
    }
    return
  })
  void client.users.updateMany({ data: { active: false } })
  void client.users.deleteMany({ where: { age: { lt: 1 } } })
  // @ts-expect-error — delete does not accept "after"
  void client.users.delete({ return: "after", where: { id: "user:a" } })

  void client.users.updateEach({
    data: [
      { age: 1, id: "user:a" },
      { age: 2, id: "user:b" },
    ],
  })
  void client.users.updateEach({
    by: "email",
    data: [{ age: 3, email: "a@x" }],
    onEmpty: "throw",
  })
  void client.users.updateEach({
    by: "email",
    // @ts-expect-error — `by: "email"` items must carry email
    data: [{ age: 3, id: "user:a" }],
  })

  void client.posts.create({
    data: { title: "T" },
    relate: [{ edge: "likes", from: "user:a", to: "$self" }],
    return: "none",
  })
  void client.posts.create({
    data: { title: "T" },
    relate: [{ edge: "likes", from: "user:a", to: "$self" }],
    return: "before",
  })
  // @ts-expect-error — the relate batch rejects RETURN DIFF
  void client.posts.create({
    data: { title: "T" },
    relate: [{ edge: "likes", from: "user:a", to: "$self" }],
    return: "diff",
  })

  void client.likes.relate({
    data: { score: 5 },
    from: "user:a",
    to: "post:p",
  })
  void client.likes.relateMany({
    data: [
      { from: "user:a", to: "post:p" },
      { data: { score: 1 }, from: "user:b", id: "first", to: "post:p" },
    ],
  })
  void client.likes.unrelate({ from: "user:a", to: "post:p" })
  void client.likes.unrelateMany({ where: { score: { lt: 3 } } })
  // @ts-expect-error — an endpoint can not be null
  void client.likes.relate({ from: null, to: "post:p" })

  // --- projections on the returned rows (`select`/`omit`) ----------------------------------------
  const _selected = client.users.update({
    data: { age: 2 },
    select: { id: true, name: true },
    where: { id: "user:a" },
  })
  assertType<ThrowingResult<{ id: Row["id"]; name: string }>, typeof _selected>()

  const _aliased = client.users.update({
    data: { age: 2 },
    select: { city: "address.city" },
    where: { id: "user:a" },
  })
  assertType<ThrowingResult<{ city: string }>, typeof _aliased>()

  const _beforeSelected = client.users.update({
    data: { age: 2 },
    return: "before",
    select: { name: true },
    where: { id: "user:a" },
  })
  assertType<ThrowingResult<{ name: string }>, typeof _beforeSelected>()

  const _deleted = client.users.delete({
    omit: ["email"],
    where: { id: "user:a" },
  })
  assertType<ThrowingResult<Omit<Row, "email">>, typeof _deleted>()

  const _createdProjected = client.users.create({
    data: {
      active: true,
      address: { city: "X", country: "Y" },
      age: 1,
      email: "a@x",
      name: "A",
      tags: [],
    },
    select: { name: true },
  })
  assertType<Promise<{ name: string }>, typeof _createdProjected>()

  const _batchSelected = client.users.updateMany({
    data: { age: 2 },
    select: { age: true },
    where: { active: true },
  })
  assertType<Promise<BatchResult<{ age: number }>>, typeof _batchSelected>()

  void client.users.updateEach({
    data: [{ age: 1, id: "user:a" }],
    select: { name: true },
  })

  // --- numeric adjustments (`increment`/`decrement`) ---------------------------------------------
  void client.users.update({
    data: { age: { increment: 1 }, name: "B" },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { age: { decrement: surql`2`.as<number>() } },
    where: { id: "user:a" },
  })
  void client.users.updateEach({
    data: [{ age: { increment: 1 }, id: "user:a" }],
  })
  void client.users.upsert({
    data: { age: { decrement: 1 } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — increment needs a numeric field
      name: { increment: 1 },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — the operand must be numeric
      age: { increment: "x" },
    },
    where: { id: "user:a" },
  })
  void client.users.create({
    data: {
      active: true,
      address: { city: "X", country: "Y" },
      // @ts-expect-error — create payloads don't take adjustments
      age: { increment: 1 },
      email: "a@x",
      name: "A",
      tags: [],
    },
  })

  // --- array adjustments (`append`/`remove`/`union`/`at`) ------------------------------------------
  void client.users.update({
    data: { tags: { append: "new" } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { tags: { append: ["a", "b"] } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { tags: { remove: "old" } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { tags: { union: ["a"] } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { tags: { at: { index: 0, value: "x" } } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — a string field is not an array
      name: { append: "x" },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — a numeric field takes the NUMERIC markers, not the array ones
      age: { append: 1 },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — a numeric field takes the numeric markers
      name: { remove: "x" },
    },
    where: { id: "user:a" },
  })

  // --- change MODIFIERS (`when`/`else`/`coalesce`) --------------------------------------------
  void client.users.update({
    data: {
      age: { increment: 1, when: surql`age < 150` },
      tags: { coalesce: [], union: ["vip"] },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      tags: {
        append: "vip",
        coalesce: ["vip"],
        else: "throw",
        when: surql`active`,
      },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: { age: { decrement: 1, else: 0, when: surql`age > 0` } },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — coalesce  seeds the UNION/APPEND array markers
      age: { coalesce: [], increment: 1 },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — `when` can't guard `at`
      tags: { at: { index: 0, value: "x" }, when: surql`active` },
    },
    where: { id: "user:a" },
  })
  void client.users.update({
    data: {
      // @ts-expect-error — `remove` doesn't take coalesce
      tags: { coalesce: [], remove: "x" },
    },
    where: { id: "user:a" },
  })
}
const _probe_440 = typeProbes

void describe("write results dispatch on the `return` literal", () => {
  void it("create resolves rows; none/before are null; diff is unknown[]", () => {
    assertType<Promise<Row>, CreatedResult<U, Record<string, never>>>()
    assertType<Promise<Row>, CreatedResult<U, { return: "after" }>>()
    assertType<Promise<null>, CreatedResult<U, { return: "none" }>>()
    assertType<Promise<null>, CreatedResult<U, { return: "before" }>>()
    assertType<Promise<unknown[]>, CreatedResult<U, { return: "diff" }>>()
  })

  void it("insert/upsert `before` exposes the previous row (or null when created)", () => {
    assertType<Promise<null | Row>, WrittenResult<U, { return: "before" }>>()
    assertType<Promise<Row>, WrittenResult<U, Record<string, never>>>()
    assertType<Promise<null>, WrittenResult<U, { return: "none" }>>()
    assertType<Promise<unknown[]>, WrittenResult<U, { return: "diff" }>>()
  })

  void it("update/patch are ThrowingResults (a miss resolves null)", () => {
    assertType<ThrowingResult<Row>, UpdatedResult<U, Record<string, never>>>()
    assertType<ThrowingResult<Row>, UpdatedResult<U, { return: "before" }>>()
    assertType<Promise<null>, UpdatedResult<U, { return: "none" }>>()
    assertType<Promise<unknown[]>, UpdatedResult<U, { return: "diff" }>>()
  })

  void it("delete only accepts before|none", () => {
    assertType<ThrowingResult<Row>, DeletedResult<U, Record<string, never>>>()
    assertType<Promise<null>, DeletedResult<U, { return: "none" }>>()
  })

  void it("batches resolve a BatchResult, a patch list with diff", () => {
    assertType<Promise<BatchResult<Row>>, BatchWriteResult<U, Record<string, never>>>()
    assertType<Promise<unknown[]>, BatchWriteResult<U, { return: "diff" }>>()
  })
})

void describe("write data accepts fragments and partial updates", () => {
  void it("WriteData allows a surql expression per field", () => {
    assertType<true, { age: Surql<[number]> } extends WriteData<{ age: number }> ? true : false>()
    assertType<true, { name: string } extends WriteData<{ name: string }> ? true : false>()
  })

  void it("UpdateData is deep-partial (id/readonly excluded by the codec shape)", () => {
    assertType<true, { age: number } extends UpdateData<U> ? true : false>()
    assertType<true, { age: 1 } extends UpdateData<U> ? true : false>()
  })
})

void describe("updateEach and relate are typed", () => {
  void it("updateEach items carry the by field plus update data", () => {
    assertType<
      false,
      { age: number; id: string } extends UpdateEachItem<U, "email"> ? true : false
    >()
    assertType<
      true,
      { age: number; email: string } extends UpdateEachItem<U, "email"> ? true : false
    >()
  })

  void it("only RELATION delegates expose relate/unrelate", () => {
    assertType<true, "relate" extends keyof Likess ? true : false>()
    assertType<true, "relateMany" extends keyof Likess ? true : false>()
    assertType<true, "unrelate" extends keyof Likess ? true : false>()
    assertType<false, "relate" extends keyof Users ? true : false>()
    assertType<true, Likess extends ModelDelegate<L> ? true : false>()
  })

  void it("the delegate exposes the write surface", () => {
    assertType<true, "create" extends keyof Users ? true : false>()
    assertType<true, "createMany" extends keyof Users ? true : false>()
    assertType<true, "insert" extends keyof Users ? true : false>()
    assertType<true, "insertMany" extends keyof Users ? true : false>()
    assertType<true, "update" extends keyof Users ? true : false>()
    assertType<true, "patch" extends keyof Users ? true : false>()
    assertType<true, "upsert" extends keyof Users ? true : false>()
    assertType<true, "upsertDelta" extends keyof Users ? true : false>()
    assertType<true, "delete" extends keyof Users ? true : false>()
    assertType<true, "updateEach" extends keyof Users ? true : false>()
  })
})
