// String ids — TYPE assertions: the APP side is a bare `BareId<T>` string (relation helpers still
// resolve the target table), the WIRE side accepts `string | RecordId`, and writes/where/cursor
// accept both. Type-checked by `bun check` as part of `typecheck` — no runtime.

import { describe, it } from "node:test"

import { RecordId, type RecordIdValue } from "surrealdb"

import { assertType } from "../../../../../scripts/type-assert"
import {
  type App,
  type BareId,
  type RecordIdField,
  relation,
  s,
  table,
  type Wire,
} from "../../../src/surreal"
import { schema } from "../../../src/surreal/orm/schema"
import type { LinkKeys, RecordIdName } from "../../../src/surreal/orm/types/relations"
import type { CursorArgs } from "../../../src/surreal/orm/types/select"
import type { WhereInput } from "../../../src/surreal/orm/types/where"
import type { CreateData, UpdateData } from "../../../src/surreal/orm/types/write"

const Org = table("org", { name: s.string() }).stringIds()
const Customer = table("customer", {
  meta: s.object({ ref: s.recordId(Org) }),
  name: s.string(),
  org: s.recordId(Org),
}).stringIds()
const Likes = relation("likes", { score: s.int() }).from(Customer).to(Org).stringIds()
const _schemaDef = schema({ customers: Customer, likes: Likes, orgs: Org })

void describe("string ids — types", () => {
  void it("App is a bare branded string; Wire accepts string | RecordId", () => {
    assertType<BareId<"org">, App<typeof Org>["id"]>()
    assertType<RecordId<"org"> | string, Wire<typeof Org>["id"]>()
    assertType<BareId<"org">, App<typeof Customer>["org"]>()
    assertType<BareId<"org">, App<typeof Customer>["meta"]["ref"]>()
  })

  void it("RecordIdName resolves the target table from the brand", () => {
    assertType<"org", RecordIdName<App<typeof Customer>["org"]>>()
    assertType<never, RecordIdName<App<typeof Customer>["name"]>>()
  })

  void it("link keys survive (relational filters typecheck)", () => {
    assertType<"org", LinkKeys<typeof Customer>>()
    const w: WhereInput<typeof Customer, typeof _schemaDef> = {
      org: { is: { name: "x" } },
    }
    const _probe_52 = w
  })

  void it("where accepts bare strings, RecordId and operators", () => {
    const shorthand: WhereInput<typeof Customer, typeof _schemaDef> = {
      org: "o1",
    }
    const equals: WhereInput<typeof Customer, typeof _schemaDef> = {
      org: { equals: "o1" },
    }
    const list: WhereInput<typeof Customer, typeof _schemaDef> = {
      org: { in: ["o1"] },
    }
    const recordId: WhereInput<typeof Customer, typeof _schemaDef> = {
      org: new RecordId("org", "o1"),
    }
    const byId: WhereInput<typeof Customer, typeof _schemaDef> = { id: "c1" }
    const _probe_69 = shorthand
    const _probe_70 = equals
    const _probe_71 = list
    const _probe_72 = recordId
    const _probe_73 = byId
  })

  void it("writes accept bare strings AND RecordId, nested included", () => {
    const create: CreateData<typeof Customer> = {
      meta: { ref: "o2" },
      name: "A",
      org: "o1",
    }
    const update: UpdateData<typeof Customer> = {
      meta: { ref: new RecordId("org", "o2") },
      org: new RecordId("org", "o1"),
    }
    const _probe_86 = create
    const _probe_87 = update
  })

  void it("cursor accepts a bare id / tuple and relation endpoints are bare", () => {
    const cursor: CursorArgs<typeof Customer, typeof _schemaDef> = {
      after: "c1",
      limit: 2,
      orderBy: [{ id: "asc" }],
    }
    const _probe_96 = cursor
    assertType<BareId<"customer">, App<typeof Likes>["in"]>()
    assertType<BareId<"org">, App<typeof Likes>["out"]>()
  })

  void it("record() keeps the mode and .stringIds() stays a RecordIdField", () => {
    assertType<RecordIdField<"org", RecordIdValue, "string">, ReturnType<typeof Org.record>>()
    const _explicit = s.recordId("org").stringIds()
    assertType<RecordIdField<"org", RecordIdValue, "string">, typeof _explicit>()
  })
})
