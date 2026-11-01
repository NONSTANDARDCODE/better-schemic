// String ids — TYPE assertions: the APP side is a bare `BareId<T>` string (relation helpers still
// resolve the target table), the WIRE side accepts `string | RecordId`, and writes/where/cursor
// accept both. Type-checked by `bun check` as part of `typecheck` — no runtime.
import { describe, it } from "node:test";
import { RecordId, type RecordIdValue } from "surrealdb";
import { assertType } from "../../../../../scripts/type-assert";
import {
  type App,
  type BareId,
  type RecordIdField,
  relation,
  s,
  table,
  type Wire,
} from "../../../src/surreal";
import { schema } from "../../../src/surreal/orm/schema";
import type {
  LinkKeys,
  RecordIdName,
} from "../../../src/surreal/orm/types/relations";
import type { CursorArgs } from "../../../src/surreal/orm/types/select";
import type { WhereInput } from "../../../src/surreal/orm/types/where";
import type {
  CreateData,
  UpdateData,
} from "../../../src/surreal/orm/types/write";

const Org = table("org", { name: s.string() }).stringIds();
const Customer = table("customer", {
  name: s.string(),
  org: s.recordId(Org),
  meta: s.object({ ref: s.recordId(Org) }),
}).stringIds();
const Likes = relation("likes", { score: s.int() })
  .from(Customer)
  .to(Org)
  .stringIds();
const schemaDef = schema({ orgs: Org, customers: Customer, likes: Likes });

describe("string ids — types", () => {
  it("App is a bare branded string; Wire accepts string | RecordId", () => {
    assertType<BareId<"org">, App<typeof Org>["id"]>();
    assertType<
      string | RecordId<"org", RecordIdValue>,
      Wire<typeof Org>["id"]
    >();
    assertType<BareId<"org">, App<typeof Customer>["org"]>();
    assertType<BareId<"org">, App<typeof Customer>["meta"]["ref"]>();
  });

  it("RecordIdName resolves the target table from the brand", () => {
    assertType<"org", RecordIdName<App<typeof Customer>["org"]>>();
    assertType<never, RecordIdName<App<typeof Customer>["name"]>>();
  });

  it("link keys survive (relational filters typecheck)", () => {
    assertType<"org", LinkKeys<typeof Customer>>();
    const w: WhereInput<typeof Customer, typeof schemaDef> = {
      org: { is: { name: "x" } },
    };
    void w;
  });

  it("where accepts bare strings, RecordId and operators", () => {
    const shorthand: WhereInput<typeof Customer, typeof schemaDef> = {
      org: "o1",
    };
    const equals: WhereInput<typeof Customer, typeof schemaDef> = {
      org: { equals: "o1" },
    };
    const list: WhereInput<typeof Customer, typeof schemaDef> = {
      org: { in: ["o1"] },
    };
    const recordId: WhereInput<typeof Customer, typeof schemaDef> = {
      org: new RecordId("org", "o1"),
    };
    const byId: WhereInput<typeof Customer, typeof schemaDef> = { id: "c1" };
    void shorthand;
    void equals;
    void list;
    void recordId;
    void byId;
  });

  it("writes accept bare strings AND RecordId, nested included", () => {
    const create: CreateData<typeof Customer> = {
      name: "A",
      org: "o1",
      meta: { ref: "o2" },
    };
    const update: UpdateData<typeof Customer> = {
      org: new RecordId("org", "o1"),
      meta: { ref: new RecordId("org", "o2") },
    };
    void create;
    void update;
  });

  it("cursor accepts a bare id / tuple and relation endpoints are bare", () => {
    const cursor: CursorArgs<typeof Customer, typeof schemaDef> = {
      after: "c1",
      orderBy: [{ id: "asc" }],
      limit: 2,
    };
    void cursor;
    assertType<BareId<"customer">, App<typeof Likes>["in"]>();
    assertType<BareId<"org">, App<typeof Likes>["out"]>();
  });

  it("record() keeps the mode and .stringIds() stays a RecordIdField", () => {
    assertType<
      RecordIdField<"org", RecordIdValue, "string">,
      ReturnType<typeof Org.record>
    >();
    const explicit = s.recordId("org").stringIds();
    assertType<
      RecordIdField<"org", RecordIdValue, "string">,
      typeof explicit
    >();
  });
});
