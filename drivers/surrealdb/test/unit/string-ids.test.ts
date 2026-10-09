// String ids — the ORM's app surface speaks BARE id strings; `RecordId` exists only on the wire.
// Pure authoring (codec/decode/encode/DDL identity/deep mapping) plus the ORM lowering (where,
// writes, cursor, schema metadata). Live round-trips live in `test/live/string-ids.test.ts`.
import { describe, expect, test } from "bun:test";
import { RecordId, type RecordIdValue, Uuid } from "surrealdb";
import { z } from "zod";
import { emitTable } from "../../src/ddl";
import {
  type App,
  defineRelation,
  defineTable,
  type RecordIdField,
  type RecordIdMode,
  s,
  type Wire,
} from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { buildSchemaIndex, defineSchema } from "../../src/orm/schema";
import { tenant } from "../../src/plugins/tenant";
import { stringIdsOf } from "../../src/pure";
import { inferField } from "../../src/wire";
import { caught, fakeConn, ok } from "../orm-fixtures";

// --- fixtures ------------------------------------------------------------------------------------

const Org = defineTable("sorg", { name: s.string() });

const Plain = defineTable("s_customer_plain", {
  name: s.string(),
  org: s.recordId(Org),
  owner: s.recordId(Org).optional(),
  meta: s.object({ ref: s.recordId(Org) }),
  products: s.array(s.object({ product: s.recordId(Org) })),
  tags: s.array(s.recordId(Org)),
});

const Customer = Plain.stringIds();

const UniqueOrg = defineTable("s_unique_org", {
  ref: s.recordId(Org),
})
  .index("s_uq_org", ["ref"], { unique: true })
  .stringIds();

const Event = defineTable("s_event", {
  at: s.datetime(),
  ref: s.recordId(Org),
}).stringIds();

const Likes = defineRelation("slikes", { score: s.int() })
  .from(Customer)
  .to(Org);

const schema = defineSchema({
  orgs: Org,
  customers: Customer,
  uniqueOrgs: UniqueOrg,
  events: Event,
  likes: Likes,
});

function makeClient(result: unknown = []): {
  client: Client<typeof schema>;
  calls: { sql: string; vars?: Record<string, unknown> }[];
} {
  const { conn, calls } = fakeConn((sql) =>
    sql.split("\n").map(() => ok(result)),
  );
  return { client: betterSchemic(conn, { schema }), calls };
}

const lastCall = (calls: { sql: string; vars?: Record<string, unknown> }[]) => {
  const call = calls[calls.length - 1];
  return { sql: call?.sql ?? "", vars: call?.vars ?? {} };
};

/** `fields` is typed as the normalized `SField` map — read the runtime mode through the class. */
const modeOf = (field: unknown): RecordIdMode =>
  (field as RecordIdField<string, RecordIdValue, RecordIdMode>).mode;

// --- pure: codec, DDL identity, deep mapping -----------------------------------------------------

describe("string ids — pure authoring", () => {
  test("emits byte-identical DDL (zero migration)", () => {
    expect(emitTable(Customer)).toBe(emitTable(Plain));
    expect(emitTable(Customer)).toContain(
      "DEFINE FIELD org ON TABLE s_customer_plain TYPE record<sorg>;",
    );
    expect(emitTable(Customer)).toContain(
      "DEFINE FIELD products ON TABLE s_customer_plain TYPE array<object>;",
    );
    expect(emitTable(Customer)).toContain(
      "DEFINE FIELD products.*.product ON TABLE s_customer_plain TYPE record<sorg>;",
    );
  });

  test("the walker still classifies the codec as a record link with targets", () => {
    const info = inferField(Customer.fields.org.schema);
    expect(info.family).toBe("record");
    expect(info.record?.targets).toEqual(["sorg"]);
  });

  test("decode normalizes RecordId + escaped/prefixed strings to a bare string", () => {
    const row = {
      id: new RecordId("s_customer_plain", "01ABC"),
      name: "A",
      org: new RecordId("sorg", "o1"),
      meta: { ref: new RecordId("sorg", "o2") },
      products: [{ product: new RecordId("sorg", "o3") }],
      tags: [new RecordId("sorg", "o4")],
    };
    const decoded = Customer.decode(row) as App<typeof Customer>;
    expect(decoded.id).toBe("01ABC");
    expect(decoded.org).toBe("o1");
    expect(decoded.meta.ref).toBe("o2");
    expect(decoded.products[0]?.product).toBe("o3");
    expect(decoded.tags).toEqual(["o4"]);
    expect(decoded.owner).toBeUndefined();

    // wire strings: bare / table:id / table:⟨id⟩ all normalize to the bare id.
    expect(Customer.decode({ ...row, org: "sorg:o9" }).org).toBe("o9");
    expect(Customer.decode({ ...row, org: "sorg:⟨o9⟩" }).org).toBe("o9");
    expect(Customer.decode({ ...row, org: "o9" }).org).toBe("o9");
  });

  test("encode turns app strings into RecordId, nested included", () => {
    const wire = Customer.encode({
      name: "B",
      org: "o9",
      meta: { ref: "sorg:o10" },
      products: [{ product: "sorg:⟨o11⟩" }],
      tags: ["o12"],
    }) as Wire<typeof Customer>;
    expect(wire.org).toBeInstanceOf(RecordId);
    expect(String(wire.org)).toBe("sorg:o9");
    expect(String(wire.meta.ref)).toBe("sorg:o10");
    expect(String(wire.products[0]?.product)).toBe("sorg:o11");
    expect(String(wire.tags[0])).toBe("sorg:o12");
    expect(
      Customer.encode({
        id: "01ZZZ",
        name: "C",
        org: "o1",
        meta: { ref: "o2" },
        products: [],
        tags: [],
      }).id,
    ).toBeInstanceOf(RecordId);
  });

  test("wire accepts a RecordId and validates the target table", async () => {
    const okWire = Customer.encode({
      name: "B",
      org: new RecordId("sorg", "o1"),
      meta: { ref: "o2" },
      products: [],
      tags: [],
    } as never);
    expect(String(okWire.org)).toBe("sorg:o1");
    const bad = await caught(() =>
      Customer.encode({ name: "B", org: "other:o1" } as never),
    );
    expect((bad as Error).message).toContain('targets "sorg"');
    const decoded = await caught(() =>
      Customer.decode({ id: "c:1", org: "other:o1" }),
    );
    expect(decoded).not.toBeNull();
  });

  test("valueType validation is kept (and numeric ids coerce)", async () => {
    const IntRef = defineTable("s_int_ref", {
      ref: s.recordId("sorg").type(z.number()),
    }).stringIds();
    const decoded = IntRef.decode({
      id: new RecordId("s_int_ref", 1),
      ref: new RecordId("sorg", 7),
    }) as App<typeof IntRef>;
    expect(decoded.ref).toBe("7");
    const encoded = IntRef.encode({ ref: "7" }) as Wire<typeof IntRef>;
    expect(encoded.ref).toBeInstanceOf(RecordId);
    expect((encoded.ref as RecordId).id).toBe(7);
    expect(
      await caught(() => IntRef.encode({ ref: "not-a-number" } as never)),
    ).not.toBeNull();
    expect(
      await caught(() => IntRef.decode({ id: "i:1", ref: "sorg:nope" })),
    ).not.toBeNull();
  });

  test("valueType: string, bigint and uuid ids round-trip", () => {
    const StrRef = defineTable("s_str_ref", {
      ref: s.recordId("sorg").type(z.string()),
    }).stringIds();
    const strRow = StrRef.decode({
      id: new RecordId("s_str_ref", "x"),
      ref: new RecordId("sorg", "o1"),
    }) as App<typeof StrRef>;
    expect(strRow.ref).toBe("o1");
    const strWire = StrRef.encode({ ref: "o1" }) as Wire<typeof StrRef>;
    expect(String(strWire.ref)).toBe("sorg:o1");

    const BigRef = defineTable("s_big_ref", {
      ref: s.recordId("sorg").type(z.bigint()),
    }).stringIds();
    const bigRow = BigRef.decode({
      id: new RecordId("s_big_ref", "x"),
      ref: new RecordId("sorg", 42n),
    }) as App<typeof BigRef>;
    expect(bigRow.ref).toBe("42");
    const bigWire = BigRef.encode({ ref: "42" }) as Wire<typeof BigRef>;
    expect((bigWire.ref as RecordId).id).toBe(42n);
    // The WIRE refinement accepts the same coercions the encode does (bigint included).
    const bigViaWire = BigRef.decode({
      id: new RecordId("s_big_ref", "x"),
      ref: "sorg:42",
    }) as App<typeof BigRef>;
    expect(bigViaWire.ref).toBe("42");
  });

  test("a record inside a union flips too", () => {
    const U = defineTable("s_union", {
      v: s.union([s.recordId("sorg"), s.string()]),
    }).stringIds();
    const row = U.decode({
      id: new RecordId("s_union", "1"),
      v: new RecordId("sorg", "x"),
    }) as App<typeof U>;
    expect(row.v).toBe("x");
    const wire = U.encode({ v: "x" } as never) as Wire<typeof U>;
    expect(String(wire.v as RecordId)).toBe("sorg:x");
  });

  test("a set of record links flips too (ZodSet's `valueType` def key)", () => {
    const S = defineTable("s_set", {
      refs: s.set(s.recordId("sorg")),
    }).stringIds();
    const row = S.decode({
      id: new RecordId("s_set", "1"),
      refs: new Set([new RecordId("sorg", "a")]),
    }) as App<typeof S>;
    expect([...row.refs]).toEqual(["a"]);
    const wire = S.encode({
      refs: new Set(["a"]),
    } as never) as Wire<typeof S>;
    expect(String([...wire.refs][0] as RecordId)).toBe("sorg:a");
  });

  test("value-carrying wrappers must come AFTER .stringIds()", async () => {
    // `.default()` pre-flip holds a RecordId app fallback that can't be remapped — teaching error.
    const preDefault = defineTable("s_def_pre", {
      ref: s.recordId("sorg").default(new RecordId("sorg", "d")),
    });
    expect(await caught(() => preDefault.stringIds())).not.toBeNull();

    // Authored after `.stringIds()`, the fallback is a bare string and decode returns it.
    const T = defineTable("s_def_post", {
      ref: s.recordId("sorg").stringIds().default("d"),
      other: s.recordId("sorg").stringIds().catch("c"),
    });
    const row = T.decode({ id: new RecordId("s_def_post", "1") }) as App<
      typeof T
    >;
    expect(row.ref).toBe("d");
    expect(row.other).toBe("c");
  });

  test("bareIdValue: uuid ids unwrap; composite ids throw", () => {
    const UuidRef = defineTable("s_uuid_ref", {
      ref: s.recordId("sorg").type(z.instanceof(Uuid)),
    }).stringIds();
    const uuid = new Uuid("0190f5b2-7c1e-7c3a-8f4b-2b6a1c9d8e7f");
    const row = UuidRef.decode({
      id: new RecordId("s_uuid_ref", "x"),
      ref: new RecordId("sorg", uuid),
    }) as App<typeof UuidRef>;
    expect(row.ref).toBe("0190f5b2-7c1e-7c3a-8f4b-2b6a1c9d8e7f");

    // A composite (array) id can't be a bare string — decode throws the teaching error.
    const Composite = defineTable("s_comp_ref", {
      ref: s.recordId("sorg").type(z.array(z.string())),
    }).stringIds();
    expect(() =>
      Composite.decode({
        id: new RecordId("s_comp_ref", "x"),
        ref: new RecordId("sorg", ["a", "b"]),
      }),
    ).toThrow(/composite/);
  });

  test("non-record containers stay untouched (array/set/union no-op arms)", () => {
    const T = defineTable("s_noop", {
      tags: s.array(s.string()),
      refs: s.set(s.string()),
      choice: s.union([s.string(), s.int()]),
      ref: s.recordId("sorg"),
    }).stringIds();
    const row = T.decode({
      id: new RecordId("s_noop", "1"),
      tags: ["a"],
      refs: new Set(["r"]),
      choice: "x",
      ref: "o1",
    }) as App<typeof T>;
    expect(row.ref).toBe("o1");
    expect(emitTable(T)).toContain(
      "DEFINE FIELD ref ON TABLE s_noop TYPE record<sorg>;",
    );
  });

  test("stringIdsOf unwraps an unregistered container around a codec", () => {
    const T = defineTable("s_wrap", { ref: s.recordId("sorg") }).stringIds();
    expect(stringIdsOf(T.fields.ref.schema)).toBe(true);
    expect(stringIdsOf(z.optional(T.fields.ref.schema))).toBe(true);
    expect(stringIdsOf(z.array(T.fields.ref.schema))).toBe(true);
    const plain = defineTable("s_plain", { ref: s.recordId("sorg") });
    expect(stringIdsOf(plain.fields.ref.schema)).toBe(false);
  });

  test("optional/nullable/array/object composition keeps the mode", () => {
    const T = defineTable("s_comp", {
      a: s.recordId("sorg").optional(),
      b: s.recordId("sorg").nullable(),
      c: s.array(s.recordId("sorg")),
      d: s.object({ e: s.recordId("sorg").optional() }),
    }).stringIds();
    const decoded = T.decode({
      id: new RecordId("s_comp", "1"),
      a: new RecordId("sorg", "a"),
      b: null,
      c: [new RecordId("sorg", "c")],
      d: { e: new RecordId("sorg", "e") },
    }) as App<typeof T>;
    expect(decoded.a).toBe("a");
    expect(decoded.b).toBeNull();
    expect(decoded.c).toEqual(["c"]);
    expect(decoded.d.e).toBe("e");
  });

  test("multi-target / open / wrapped record fields throw a teaching error", async () => {
    expect(
      await caught(() => s.recordId(["a", "b"]).stringIds()),
    ).not.toBeNull();
    expect(await caught(() => s.recordId().stringIds())).not.toBeNull();
    expect(
      await caught(() =>
        defineTable("s_bad", { ref: s.recordId("sorg") }).stringIds(),
      ),
    ).toBeNull();
    expect(
      await caught(() =>
        defineTable("s_bad2", {
          ref: s.recordId(["a", "b"]),
        }).stringIds(),
      ),
    ).not.toBeNull();
    const refined = defineTable("s_bad3", {
      ref: s.recordId("sorg").refine(() => true),
    });
    expect(await caught(() => refined.stringIds())).not.toBeNull();
  });

  test("TableDef.record() inherits the table's id mode", () => {
    expect(Org.record().mode).toBe("record");
    expect(Customer.record().mode).toBe("string");
    // and an explicit .stringIds() on a derived link is idempotent
    expect(Customer.record().stringIds().mode).toBe("string");
  });

  test("an explicit id field in string mode survives defineTable", () => {
    const T = defineTable("s_explicit", {
      id: s.recordId("s_explicit").stringIds(),
      name: s.string(),
    });
    expect(modeOf(T.fields.id)).toBe("string");
    expect(
      T.decode({ id: new RecordId("s_explicit", "x"), name: "A" }).id,
    ).toBe("x");
  });

  test("relations inherit single-string endpoints and .stringIds() flips in/out + id", async () => {
    // Likes: from = string-id Customer, to = record-mode Org.
    expect(modeOf(Likes.fields.in)).toBe("string");
    expect(modeOf(Likes.fields.out)).toBe("record");
    const edge = Likes.decode({
      id: new RecordId("slikes", "l1"),
      in: new RecordId("s_customer_plain", "c1"),
      out: new RecordId("sorg", "o1"),
      score: 1,
    }) as App<typeof Likes>;
    expect(edge.in).toBe("c1");
    expect(edge.out).toBeInstanceOf(RecordId);

    const Both = defineRelation("slikes_both", { score: s.int() })
      .from(Customer)
      .to(Customer)
      .stringIds();
    const both = Both.decode({
      id: new RecordId("slikes_both", "l1"),
      in: new RecordId("s_customer_plain", "a"),
      out: new RecordId("s_customer_plain", "b"),
      score: 1,
    }) as App<typeof Both>;
    expect(both.id).toBe("l1");
    expect(both.in).toBe("a");
    expect(both.out).toBe("b");

    const Multi = defineRelation("slikes_multi", { score: s.int() })
      .from([Org, Customer])
      .to(Org);
    expect(await caught(() => Multi.stringIds())).not.toBeNull();

    // A single FROM with a multi-TO is refused on the TO endpoint.
    const MultiTo = defineRelation("slikes_mto", { score: s.int() })
      .from(Org)
      .to([Org, Customer]);
    expect(await caught(() => MultiTo.stringIds())).not.toBeNull();
  });

  test("tenant() principal mode flows into the tenant column", () => {
    const TenantTable = defineTable("s_tenant", {
      name: s.string(),
    }).use(tenant(Customer));
    const decoded = TenantTable.decode({
      id: new RecordId("s_tenant", "t1"),
      name: "A",
      tenant_id: new RecordId("s_customer_plain", "c1"),
    }) as App<typeof TenantTable>;
    expect(decoded.tenant_id).toBe("c1");
  });

  test("schema metadata marks the string-id links", () => {
    const index = buildSchemaIndex(schema);
    const meta = index.tables.get("customers");
    expect(meta?.columns.get("org")?.record?.stringIds).toBe(true);
    expect(meta?.columns.get("meta")?.record?.stringIds).toBeUndefined();
    const edge = index.tables.get("likes");
    expect(edge?.columns.get("in")?.record?.stringIds).toBe(true);
    expect(edge?.columns.get("out")?.record?.stringIds).toBeUndefined();
  });
});

// --- ORM lowering --------------------------------------------------------------------------------

describe("string ids — where / writes / cursor", () => {
  test("where shorthand, equals, in and contains bind RecordId", async () => {
    const { client, calls } = makeClient();
    await client.customers.findMany({ where: { org: "o1" } });
    expect(lastCall(calls).sql).toBe(
      "SELECT * FROM s_customer_plain WHERE org = $p0;",
    );
    expect(lastCall(calls).vars.p0).toBeInstanceOf(RecordId);
    expect(String(lastCall(calls).vars.p0)).toBe("sorg:o1");

    await client.customers.findMany({ where: { org: { equals: "o2" } } });
    expect(String(lastCall(calls).vars.p0)).toBe("sorg:o2");

    await client.customers.findMany({ where: { org: { in: ["o3"] } } });
    expect(lastCall(calls).sql).toBe(
      "SELECT * FROM s_customer_plain WHERE org IN $p0;",
    );
    expect(String((lastCall(calls).vars.p0 as RecordId[])[0])).toBe("sorg:o3");

    await client.customers.findMany({ where: { tags: { contains: "o4" } } });
    expect(lastCall(calls).sql).toBe(
      "SELECT * FROM s_customer_plain WHERE tags CONTAINS $p0;",
    );
    expect(String(lastCall(calls).vars.p0)).toBe("sorg:o4");
  });

  test("where accepts RecordId and rejects a wrong table", async () => {
    const { client, calls } = makeClient();
    await client.customers.findMany({
      where: { org: new RecordId("sorg", "o1") },
    });
    expect(lastCall(calls).vars.p0).toBeInstanceOf(RecordId);
    const err = await caught(() =>
      client.customers.findMany({ where: { org: "other:o1" } }),
    );
    expect((err as Error).message).toContain("targets");
  });

  test("create encodes nested app strings", async () => {
    const { client, calls } = makeClient();
    await client.customers.create({
      data: {
        name: "A",
        org: "o1",
        meta: { ref: "o2" },
        products: [{ product: "o3" }],
        tags: ["o4"],
      },
    });
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"s_customer_plain", rand::ulid()) CONTENT $p0;',
    );
    const p0 = lastCall(calls).vars.p0 as {
      org: RecordId;
      meta: { ref: RecordId };
      products: { product: RecordId }[];
      tags: RecordId[];
    };
    expect(String(p0.org)).toBe("sorg:o1");
    expect(String(p0.meta.ref)).toBe("sorg:o2");
    expect(String(p0.products[0]?.product)).toBe("sorg:o3");
    expect(String(p0.tags[0])).toBe("sorg:o4");
  });

  test("update by bare id targets the record", async () => {
    const { client, calls } = makeClient([
      {
        id: new RecordId("s_customer_plain", "c1"),
        name: "A",
        org: new RecordId("sorg", "o1"),
        meta: { ref: new RecordId("sorg", "o2") },
        products: [],
        tags: [],
      },
    ]);
    const row = await client.customers.update({
      where: { id: "c1" },
      data: { org: "o9" },
    });
    expect(lastCall(calls).sql).toBe("UPDATE s_customer_plain:c1 MERGE $p0;");
    expect(String((lastCall(calls).vars.p0 as { org: RecordId }).org)).toBe(
      "sorg:o9",
    );
    expect(row?.org).toBe("o1");
  });

  test("upsert by a UNIQUE record column coerces the bare value", async () => {
    const { client, calls } = makeClient();
    const pending = client.uniqueOrgs.upsert({
      where: { ref: "o1" },
      data: { ref: "o2" },
    });
    const call = lastCall(calls);
    expect(call.sql).toBe("UPDATE s_unique_org MERGE $p0 WHERE ref = $p1;");
    expect(String(call.vars.p1)).toBe("sorg:o1");
    await pending.catch(() => {});
  });

  test("updateEach by a record link accepts a bare id", async () => {
    const { client, calls } = makeClient();
    await client.customers.updateEach({
      by: "org",
      data: [{ org: "o1", name: "A" }],
    });
    const call = lastCall(calls);
    expect(call.sql).toBe("UPDATE s_customer_plain MERGE $p1 WHERE org = $p0;");
    expect(String(call.vars.p0)).toBe("sorg:o1");
    expect((call.vars.p1 as { name: string }).name).toBe("A");
  });

  test("cursor coerces a bare id after/before and returns a bare nextCursor", async () => {
    const { client, calls } = makeClient([
      {
        id: new RecordId("s_customer_plain", "c1"),
        name: "A",
        org: new RecordId("sorg", "o1"),
        meta: { ref: new RecordId("sorg", "o2") },
        products: [],
        tags: [],
      },
      {
        id: new RecordId("s_customer_plain", "c2"),
        name: "B",
        org: new RecordId("sorg", "o1"),
        meta: { ref: new RecordId("sorg", "o2") },
        products: [],
        tags: [],
      },
    ]);
    const page = await client.customers.cursor({
      after: "c0",
      orderBy: [{ id: "asc" }],
      limit: 1,
    });
    expect(lastCall(calls).sql).toBe(
      "SELECT * FROM s_customer_plain WHERE (id > $c0) ORDER BY id ASC LIMIT $p0;",
    );
    expect(String(lastCall(calls).vars.c0)).toBe("s_customer_plain:c0");
    expect(page.pagination.nextCursor).toBe("c1");
    expect(page.data).toHaveLength(1);
  });

  test("cursor coerces a tuple (datetime + bare id) and keeps DateTime precision", async () => {
    const { client, calls } = makeClient([]);
    await client.events.cursor({
      after: { at: "2024-01-01T00:00:00Z", id: "e1" },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      limit: 5,
    });
    expect(lastCall(calls).sql).toBe(
      "SELECT * FROM s_event WHERE (at > $c0 OR (at = $c0 AND id > $c1)) ORDER BY at ASC, id ASC LIMIT $p0;",
    );
    expect(String(lastCall(calls).vars.c0)).toBe("2024-01-01T00:00:00.000Z");
    expect(String(lastCall(calls).vars.c1)).toBe("s_event:e1");

    const bad = await caught(() =>
      client.events.cursor({
        after: { at: "not-a-date", id: "e1" },
        orderBy: [{ at: "asc" }, { id: "asc" }],
        limit: 5,
      }),
    );
    expect((bad as Error).message).toContain("ISO-8601");
  });

  test("findUnique by a bare id targets the record", async () => {
    const row = {
      id: new RecordId("s_customer_plain", "c1"),
      name: "A",
      org: new RecordId("sorg", "o1"),
      meta: { ref: new RecordId("sorg", "o2") },
      products: [],
      tags: [],
    };
    const { client, calls } = makeClient(row);
    const found = await client.customers.findUnique({ where: { id: "c1" } });
    expect(lastCall(calls).sql).toBe("SELECT * FROM ONLY s_customer_plain:c1;");
    expect(found?.id).toBe("c1");
  });

  test("relation endpoints accept a bare id when the direction has ONE declared table", async () => {
    const { client, calls } = makeClient([
      {
        id: new RecordId("slikes", "l1"),
        in: new RecordId("s_customer_plain", "c1"),
        out: new RecordId("sorg", "o1"),
        score: 1,
      },
    ]);
    await client.likes.relate({ from: "c1", to: "o1" });
    expect(lastCall(calls).sql).toBe(
      "RELATE s_customer_plain:c1->slikes->sorg:o1;",
    );
  });
});
