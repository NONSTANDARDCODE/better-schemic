// String ids — TYPE assertions: the APP side is a bare `BareId<T>` string (relation helpers still
// Resolve the target table), the WIRE side accepts `string | RecordId`, and writes/where/cursor
// Accept both. Type-checked by `bun check` as part of `typecheck` — no runtime.
import { describe, it } from "node:test"

import { RecordId } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import { defineRelation, defineTable, s } from "../../../src/surreal"
import { defineSchema } from "../../../src/surreal/orm/schema"

import type { App, BareId, RecordIdField, Wire } from "../../../src/surreal"
import type { LinkKeys, RecordIdName } from "../../../src/surreal/orm/types/relations"
import type { CursorArgs } from "../../../src/surreal/orm/types/select"
import type { WhereInput } from "../../../src/surreal/orm/types/where"
import type { CreateData, UpdateData } from "../../../src/surreal/orm/types/write"
import type { RecordIdValue } from "surrealdb"

const Org = defineTable("org", { name: s.string() }).stringIds(),
  Customer = defineTable("customer", {
    name: s.string(),
    org: s.recordId(Org),
    meta: s.object({ ref: s.recordId(Org) }),
  }).stringIds(),
  Likes = defineRelation("likes", { score: s.int() }).from(Customer).to(Org).stringIds(),
  schema = defineSchema({ orgs: Org, customers: Customer, likes: Likes })

describe("string ids — types", () => {
  it("App is a bare branded string; Wire accepts string | RecordId", () => {
    assertType<BareId<"org">, App<typeof Org>["id"]>()
    assertType<string | RecordId<"org">, Wire<typeof Org>["id"]>()
    assertType<BareId<"org">, App<typeof Customer>["org"]>()
    assertType<BareId<"org">, App<typeof Customer>["meta"]["ref"]>()
  })

  it("RecordIdName resolves the target table from the brand", () => {
    assertType<"org", RecordIdName<App<typeof Customer>["org"]>>()
    assertType<never, RecordIdName<App<typeof Customer>["name"]>>()
  })

  it("link keys survive (relational filters typecheck)", () => {
    assertType<"org", LinkKeys<typeof Customer>>()
    const w: WhereInput<typeof Customer, typeof schema> = {
      org: { is: { name: "x" } },
    }
    w
  })

  it("where accepts bare strings, RecordId and operators", () => {
    const shorthand: WhereInput<typeof Customer, typeof schema> = { org: "o1" },
      equals: WhereInput<typeof Customer, typeof schema> = {
        org: { equals: "o1" },
      },
      list: WhereInput<typeof Customer, typeof schema> = {
        org: { in: ["o1"] },
      },
      recordId: WhereInput<typeof Customer, typeof schema> = {
        org: new RecordId("org", "o1"),
      },
      byId: WhereInput<typeof Customer, typeof schema> = { id: "c1" }
    shorthand
    equals
    list
    recordId
    byId
  })

  it("writes accept bare strings AND RecordId, nested included", () => {
    const create: CreateData<typeof Customer> = {
        name: "A",
        org: "o1",
        meta: { ref: "o2" },
      },
      update: UpdateData<typeof Customer> = {
        org: new RecordId("org", "o1"),
        meta: { ref: new RecordId("org", "o2") },
      }
    create
    update
  })

  it("cursor accepts a bare id / tuple and relation endpoints are bare", () => {
    const cursor: CursorArgs<typeof Customer, typeof schema> = {
      after: "c1",
      orderBy: [{ id: "asc" }],
      limit: 2,
    }
    cursor
    assertType<BareId<"customer">, App<typeof Likes>["in"]>()
    assertType<BareId<"org">, App<typeof Likes>["out"]>()
  })

  it("record() keeps the mode and .stringIds() stays a RecordIdField", () => {
    assertType<RecordIdField<"org", RecordIdValue, "string">, ReturnType<typeof Org.record>>()
    const explicit = s.recordId("org").stringIds()
    assertType<RecordIdField<"org", RecordIdValue, "string">, typeof explicit>()
  })
})
