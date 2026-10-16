// The DECISION TABLES behind the compiler guards — the split-idiom reservation, the composite-UNIQUE
// target resolution, the aggregate operand policy, and the UNWIND+GROUP lowering.
//
// These live apart from `orm-reads.test.ts` (the golden SQL per delegate call) because they assert a
// different thing: not the statement a happy path produces, but WHICH SIDE of a guard a shape falls
// on. One table per guard, each a small exhaustive case list, built on `orm-aggregate-fixtures.ts` so
// a reader sees the decision rather than the connection mock.
import { describe, expect, test } from "bun:test";
import { surql } from "../../src/index";
import {
  assertGroupKeysProjected,
  compileAggregateSelect,
  directColumns,
} from "../../src/orm/compiler/aggregate-entries";
import { compileRead } from "../../src/orm/compiler/select";
import { createBinds } from "../../src/orm/compiler/shared";
import {
  requireUniqueField,
  uniqueTarget,
} from "../../src/orm/compiler/unique";
import type { BetterSchemicError } from "../../src/orm/errors";
import type { TableMeta } from "../../src/orm/meta";
import { betterSchemic } from "../../src/orm/client";
import { buildSchemaIndex, defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { fakeConn, ok } from "../orm-fixtures";
import { Deep, compiled, refusal } from "./orm-aggregate-fixtures";

describe("split idiom — the reserved alias decision table", () => {
  const Item = defineTable("idiom_item", {
    label: s.string(),
    tags: s.array(s.string()),
  });
  const typed = buildSchemaIndex({ items: Item });
  const table = typed.tables.get("items") as TableMeta;
  const schemaless = buildSchemaIndex({ things: "thing" }).schemaless.get(
    "things",
  ) as unknown as TableMeta;

  const aliasOf = (args: Record<string, unknown>, meta: TableMeta = table) => {
    const binds = createBinds();
    const read = compileRead(meta, args as never, binds);
    return { sql: read.sql, hidden: read.projection.hidden ?? [] };
  };

  test("a select that does NOT project the split field gets the reserved column", () => {
    const { hidden, sql } = aliasOf({ select: { label: true }, split: "tags" });
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT label, tags AS _split_tags FROM idiom_item SPLIT tags");
  });

  test("a select that already projects it, or a bare `*`, need no injection", () => {
    expect(aliasOf({ select: { tags: true }, split: "tags" }).hidden).toEqual([]);
    expect(aliasOf({ split: "tags" }).hidden).toEqual([]);
  });

  test("a `*` that OMITS the split field still needs the idiom", () => {
    const { hidden, sql } = aliasOf({ omit: ["tags"], split: "tags" });
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT *, tags AS _split_tags OMIT tags FROM idiom_item SPLIT tags");
  });

  test("a schemaless entry still gets the column (it has no shape to collide with)", () => {
    const { hidden, sql } = aliasOf(
      { select: { label: true }, split: "tags" },
      schemaless,
    );
    expect(hidden).toEqual(["_split_tags"]);
    expect(sql).toBe("SELECT label, tags AS _split_tags FROM thing SPLIT tags");
  });

  test("a non-string split is rejected before the alias decision", () => {
    expect(() => aliasOf({ split: ["tags"], groupBy: ["label"] })).toThrow();
  });

  test("a cursor column already holding the reserved name blocks the injection", () => {
    const binds = createBinds();
    const read = compileRead(
      table,
      { select: { label: true }, split: "tags" } as never,
      binds,
      "findMany",
      // A caller-supplied alias set (the keyset columns) that already claims the name.
      { aliases: [{ alias: "_split_tags", path: "label" }] },
    );
    // The alias is taken by the caller's own column, so no SECOND copy is appended — and the
    // caller's column is not marked hidden either (the stripper only owns what IT appended).
    expect(read.projection.hidden).toBeUndefined();
    expect(read.sql).toBe("SELECT label, label AS _split_tags FROM idiom_item SPLIT tags");
  });
});

describe("composite UNIQUE — the where-shape decision table", () => {
  const multi = () =>
    defineTable("multi", {
      org: s.string(),
      handle: s.string(),
      email: s.string(),
    })
      .index("multi_email", ["email"], { unique: true })
      .index("multi_org_handle", ["org", "handle"], { unique: true });

  const resolve = (where: unknown) => {
    const meta = buildSchemaIndex({ t: multi() }).tables.get("t") as TableMeta;
    return uniqueTarget(meta, where, "test");
  };

  test("an exact cover resolves; a partial or a foreign pair is refused", () => {
    expect(resolve({ org: "a", handle: "b" })).toEqual({
      kind: "index",
      index: "org_handle",
      entries: [
        ["org", "a"],
        ["handle", "b"],
      ],
    });
    // a partial where (the field IS unique only together with its partner)
    expect(() => resolve({ org: "a" })).toThrow(/not unique/);
    // a pair that is NOT the index
    expect(() => resolve({ email: "a@x", handle: "h" })).toThrow(
      /not a unique target/,
    );
    // an empty where
    expect(() => resolve({})).toThrow(/must target/);
    // an operator is not a pure equality
    expect(() => resolve({ org: "a", handle: { contains: "b" } })).toThrow();
    // a non-object where
    expect(() => resolve("nope")).toThrow(/must target/);
    expect(() => resolve(["org", "handle"])).toThrow(/must target/);
    expect(() => resolve(null)).toThrow(/must target/);
  });

  test("the composite hint appears only when EVERY provided field is in a group", () => {
    const two = defineTable("hint_two", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
    })
      .index("hint_ab", ["a", "b"], { unique: true })
      .index("hint_ac", ["a", "c"], { unique: true });
    const meta = buildSchemaIndex({ t: two }).tables.get("t") as TableMeta;
    // both fields are in a group -> the message says so
    let text = "";
    try {
      uniqueTarget(meta, { a: "1", b: "2" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // … it resolves, so the two-group case above must use a field pair that is NOT a group
    const three = defineTable("hint_three", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
    }).index("hint_ac", ["a", "c"], { unique: true });
    const meta3 = buildSchemaIndex({ t: three }).tables.get("t") as TableMeta;
    try {
      uniqueTarget(meta3, { a: "1", b: "2" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // `a` is in a group, `b` is not -> the generic message (no composite hint)
    expect(text).not.toContain("COMPOSITE unique index");
    expect(text).toContain("not a unique target");
  });

  test("requireUniqueField (the upsertMany conflict target) still takes a SINGLE field", () => {
    const def = defineTable("conflict", { email: s.string(), org: s.string() })
      .index("conflict_email", ["email"], { unique: true })
      .index("conflict_org_email", ["org", "email"], { unique: true });
    const meta = buildSchemaIndex({ t: def }).tables.get("t") as TableMeta;
    expect(() => requireUniqueField(meta, "email", "upsertMany")).not.toThrow();
    // A composite group is not a conflict target: the ON DUPLICATE key needs ONE column.
    expect(() => requireUniqueField(meta, "org", "upsertMany")).toThrow(
      /not unique/,
    );
    expect(() => requireUniqueField(meta, "nope", "upsertMany")).toThrow(
      /not unique/,
    );
  });

  test("a MIXED where names the composite only when every field belongs to one", () => {
    // `a` is in [a,b], `c` is in [c,d], `e` is in no group: two of three are grouped, so the
    // hint does NOT claim "they belong to a COMPOSITE index" — only SOME of them do.
    const mixed = defineTable("mixed_group", {
      a: s.string(),
      b: s.string(),
      c: s.string(),
      d: s.string(),
      e: s.string(),
    })
      .index("mixed_ab", ["a", "b"], { unique: true })
      .index("mixed_cd", ["c", "d"], { unique: true });
    const meta = buildSchemaIndex({ t: mixed }).tables.get("t") as TableMeta;
    let text = "";
    try {
      uniqueTarget(meta, { a: "1", c: "2", e: "3" } as never, "test");
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("not a unique target");
    expect(text).not.toContain("COMPOSITE unique index");

    // ALL fields in groups, but no single group covers them -> the hint fires.
    let all = "";
    try {
      uniqueTarget(meta, { a: "1", c: "2" } as never, "test");
    } catch (e) {
      all = (e as BetterSchemicError).message ?? "";
    }
    expect(all).toContain("COMPOSITE unique index");
  });

  test("a schemaless entry has no composite groups (nothing to resolve)", () => {
    const schemaless = buildSchemaIndex({ things: "thing" });
    const meta = schemaless.schemaless.get("things") as unknown as TableMeta;
    expect(() => uniqueTarget(meta, { a: 1, b: 2 }, "test")).toThrow(
      /must target/,
    );
    expect(uniqueTarget(meta, { id: "thing:1" }, "test")).toEqual({
      kind: "id",
      id: "1",
    });
  });
});

describe("aggregate operand guard — the permissive/decided table", () => {
  const Loose = defineTable("loose", { name: s.string(), amount: s.int() })
    .schemaless();
  const View = defineTable("viewed", { amount: s.int() }).schemaless().typeAny();
  // A self-referencing table: `owner` is a bare link back to `Deep`. Typed through a two-step
  // declaration so the initializer does not read its own type.
  const deepShape = {
    at: s.datetime(),
    anything: s.any(),
    owner: s.recordId("deep"),
    meta: s.object({ deep: s.boolean() }),
    seats: s.array(s.string()),
    total: s.decimal(),
  };
  const deepSchema = { deeps: Deep };

  const message = async (schema: unknown, args: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: schema as never }) as unknown as {
      deeps: { aggregate: (a: unknown) => Promise<unknown> };
    };
    try {
      await client.deeps.aggregate(args);
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("a schemaless or non-SCHEMAFULL table is permissive (no column to judge)", async () => {
    expect(
      await message({ deeps: Loose }, { select: { t: { sum: "whatever" } } }),
    ).toBe("");
    expect(
      await message({ deeps: View }, { select: { t: { sum: "whatever" } } }),
    ).toBe("");
  });

  test("a flexible object and an `any` field are permissive below the surface", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "meta.deep" } } }),
    ).toBe("");
    expect(
      await message(deepSchema, { select: { t: { sum: "anything" } } }),
    ).toBe("");
  });

  test("every teaching message is asserted VERBATIM (a mutation must not slip through)", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { select: { t: { sum: "at" } } },
        'aggregate: select."t".sum can\'t run over "at" — math::sum only aggregates NUMBERS and "at" is a date field — the server would answer 0 for it, with no error. For a date total use a surql fragment (`array::sort…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { max: "at" } } },
        'aggregate: select."t".max can\'t run over "at" — math::max only aggregates NUMBERS and "at" is a date field — the server would answer null for it, with no error. For a date extremum use a surql fragment (`array::max…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { median: "at" } } },
        'aggregate: select."t".median can\'t run over "at" — math::median only aggregates NUMBERS and "at" is a date field — the server would answer an empty object for it, with no error. For a date total use a surql fragment (`array::sort…` over `array::group(at)`), or { collect: "at" } and reduce in JS.',
      ],
      [
        { select: { t: { sum: "nope" } } },
        'aggregate: select."t".sum can\'t run over "nope" — "nope" is not a field of "deep". Known fields: at, anything, owner, meta, seats, total, id — or pass a surql fragment.',
      ],
    ];
    for (const [args, exact] of cases)
      expect(await message(deepSchema, args)).toBe(exact);
  });

  test("the link/array walk messages are asserted verbatim too", async () => {
    expect(await message(deepSchema, { select: { t: { sum: "owner.x" } } })).toBe(
      'aggregate: select."t".sum can\'t run over "owner.x" — "owner" is a record link — math::* aggregates ONE field per grouped row, so it can\'t reach through it. Use `aggregate({ split: "owner", select: { t: { sum: "…owner" } } })` for the per-element total, or a surql fragment with array::flatten.',
    );
    expect(await message(deepSchema, { select: { t: { sum: "seats.x" } } })).toBe(
      'aggregate: select."t".sum can\'t run over "seats.x" — "seats" is an array field — math::* aggregates ONE field per grouped row. Use `aggregate({ split: "seats", … })` to aggregate per element, or a surql fragment with array::flatten.',
    );
  });

  test("an ARRAY intermediate segment is refused with the split hint (not a link)", async () => {
    const text = await message(deepSchema, {
      select: { t: { sum: "seats.x" } },
    });
    expect(text).toContain("math::* aggregates ONE field per grouped row");
  });

  test("a SCALAR as an intermediate segment stops the walk (the leaf is unknown)", async () => {
    // `at.x` — `at` is a datetime, so nothing below it is knowable from the schema.
    expect(await message(deepSchema, { select: { t: { sum: "at.x" } } })).toBe("");
  });

  test("a 3-segment path through a link resolves each step (the walk is not one hop)", async () => {
    // `owner.profile.name` — the first segment is a bare link, so the walk stops there with the
    // link teaching error (and the ERROR names the FIRST hop, not the whole path).
    const text = await message(deepSchema, {
      select: { t: { sum: "owner.profile.name" } },
    });
    expect(text).toContain('"owner" is a record link');
    expect(text).toContain("owner.profile.name");
  });

  test("the SET (not array) family is refused on the walk, like the array one", async () => {
    // `seats` is an array; a SET field takes the same branch (the `||` right operand).
    const WithSet = defineTable("with_set", {
      name: s.string(),
      tags: s.set(s.string()),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { w: WithSet } });
    let text = "";
    try {
      await client.w.aggregate({ select: { t: { sum: "tags.x" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("a set field");
  });

  test("a flexible object as the LEAF family is permissive (the `||` right arm)", async () => {
    const ObjLeaf = defineTable("obj_leaf", {
      name: s.string(),
      meta: s.object({ a: s.string() }),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { o: ObjLeaf } });
    let text = "";
    try {
      await client.o.aggregate({ select: { t: { sum: "meta" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // The leaf IS the object itself: math::* over it is not a numeric leaf, but the object
    // family is deliberately permissive (its subfields are the app's business).
    expect(text).toBe("");
  });

  test("a NESTED object path is permissive below the object (its leaf is unknown)", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "meta.deep.x" } } }),
    ).toBe("");
    expect(
      await message(deepSchema, { select: { t: { sum: "owner.x.y" } } }),
    ).toContain("record link");
  });

  test("a bare record link (not a list) is NOT a walkable step", async () => {
    expect(
      await message(deepSchema, { select: { t: { sum: "owner.x" } } }),
    ).toContain("record link");
  });

  test("min/max on a datetime is refused, pointing at array::min(array::group(…))", async () => {
    const text = await message(deepSchema, {
      select: { t: { max: "at" } },
    });
    expect(text).toContain("would answer null");
    expect(text).toContain("array::");
  });

  test("checkableThroughSplit: every base-column shape is decided", async () => {
    const probe = (split: string, select: Record<string, unknown>) => {
      const { conn } = fakeConn();
      const client = betterSchemic(conn, { schema: deepSchema });
      return (async () => {
        try {
          await client.deeps.aggregate({ split: split as never, select: select as never });
          return "";
        } catch (e) {
          return (e as BetterSchemicError).message ?? "";
        }
      })();
    };
    // an UNKNOWN base column under a split is left to the server (documented escape)
    expect(await probe("seats", { t: { sum: "nope.x" } })).toBe("");
    // a single-segment operand is always checkable (the parent owns the field): `at` is a datetime
    expect(await probe("seats", { t: { sum: "at" } })).toContain(
      "only aggregates NUMBERS",
    );
    // a plain (non-link) array base: the parent still owns it
    expect(await probe("seats", { t: { sum: "seats.x" } })).not.toBe("");
  });

  test("a BARE record field as the split base stays checkable (it is the parent row)", async () => {
    const Bare = defineTable("bare_link", {
      name: s.string(),
      one: s.recordId("bare_link"),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { bare: Bare } });
    let text = "";
    try {
      await client.bare.aggregate({
        split: "one",
        select: { t: { sum: "one.x" } },
      } as never);
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // A bare link is a parent field, so the walk still refuses to reach through it.
    expect(text).toContain("record link");
  });

  test("a split operand on a plain (non-link) field is still checked on the parent", async () => {
    const withSplit = async (select: Record<string, unknown>) => {
      const { conn } = fakeConn();
      const client = betterSchemic(conn, { schema: deepSchema });
      try {
        await client.deeps.aggregate({ split: "seats", select: select as never });
        return "";
      } catch (e) {
        return (e as BetterSchemicError).message ?? "";
      }
    };
    // `seats` is a plain (non-link) array, so the PARENT schema still judges it.
    expect(await withSplit({ t: { sum: "seats" } })).toContain("array field");
    // A RECORD-LIST element is the documented escape: the element's table is not this meta, so
    // only the server can judge it (this is the `getTopProducts` shape).
    const Line = defineTable("lline", { label: s.string() });
    const Shop = defineTable("shop", { lines: s.array(s.recordId(() => Line)) });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { shops: Shop } });
    let text = "";
    try {
      await client.shops.aggregate({
        split: "lines",
        select: { t: { sum: "lines[*].label" } },
      } as never);
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toBe("");
  });
});

describe("aggregate over split — the entry-shape decision table", () => {
  const Item = defineTable("split_item", {
    name: s.string(),
    qty: s.int(),
    tags: s.array(s.string()),
  });
  const Holder = defineTable("split_holder", {
    name: s.string(),
    items: s.array(s.recordId(() => Item)),
    tags: s.array(s.string()),
  });
  const schema = { holders: Holder };

  const sql = async (args: Record<string, unknown>) => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({ split: "items", ...args } as never);
    return calls[0]?.sql as string;
  };

  test("a `true` group key keeps its name; a non-group path gets a reserved column", async () => {
    const text = await sql({ select: { name: "name", _count: true } });
    expect(text).toContain("name AS name");
    expect(text).toContain("GROUP ALL");
  });

  test("a schemaless holder never reaches the operand guard (no table to judge)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { holders: "holder" } });
    await client.holders.aggregate({
      split: "items",
      select: { t: { sum: "anything.at.all" } },
    } as never);
    expect(calls[0]?.sql).toContain("anything.at.all AS _split_anything_at_all");
  });

  test("a schemaless holder still lowers (the where compiles without table meta)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema: { holders: "holder" } });
    await client.holders.aggregate({
      split: "items",
      select: { _count: true },
      where: { name: "a" },
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT count() AS _count FROM (SELECT items AS _split_items FROM holder WHERE name = $p0 SPLIT items) GROUP ALL;",
    );
  });

  test("a `true` entry CAN be the group key (it rides its own name, and decodes as a leaf)", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([{ name: "A", _count: 2 }]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = (await client.holders.aggregate({
      split: "items",
      select: { name: true, _count: true },
      groupBy: ["name"],
    } as never)) as unknown as { name: string; _count: number }[];
    expect(calls[0]?.sql).toBe(
      "SELECT name, count() AS _count FROM (SELECT items AS _split_items, name AS name FROM split_holder SPLIT items) GROUP BY name;",
    );
    expect(rows).toEqual([{ name: "A", _count: 2 }]);
  });

  test("a fragment entry rides the inner subquery and reads the split row", async () => {
    expect(await sql({ select: { x: surql`count() + 1` } })).toContain(
      "_split_expr_x",
    );
  });

  test("a `true` entry WITHOUT a groupBy rides a reserved column and is not a decode leaf", async () => {
    const { conn, calls } = fakeConn(() => [ok([{ name: "A" }])]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.holders.aggregate({
      split: "items",
      select: { name: true },
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT _split_name AS name FROM (SELECT items AS _split_items, name AS _split_name FROM split_holder SPLIT items) GROUP ALL;",
    );
    // A NON-group entry is not decoded as a typed leaf (there is no group to remount it into) —
    // the raw server value rides through, exactly like a non-group path in a plain aggregate.
    expect(JSON.stringify(rows)).toBe(JSON.stringify([{ name: "A" }]));
  });

  test("undefined/false entries contribute nothing", async () => {
    const text = await sql({
      select: { name: "name", a: undefined, b: false as never },
    });
    // Without a `groupBy` the projected field is not a group key, so it rides a reserved column.
    expect(text).toBe(
      "SELECT _split_name AS name FROM (SELECT items AS _split_items, name AS _split_name FROM split_holder SPLIT items) GROUP ALL;",
    );
  });

  test("an entry can be a PARENT array field (not only the split element)", async () => {
    expect(await sql({ select: { tags: { collect: "tags" } } })).toContain(
      "array::group(_split_tags)",
    );
  });

  test("a single-key group alias equals its own name (no redundant AS)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({
      split: "items",
      select: { holder: "name", total: { sum: "items[*].qty" } },
      groupBy: ["holder"],
    } as never);
    expect(calls[0]?.sql).toBe(
      "SELECT holder, math::sum(_split_items_qty) AS total " +
        "FROM (SELECT items AS _split_items, name AS holder, items[*].qty AS _split_items_qty FROM split_holder SPLIT items) " +
        "GROUP BY holder;",
    );
  });
});

describe("aggregate over split — the guard/clause tails", () => {
  const Item = defineTable("tail_item", { qty: s.int() });
  const Holder = defineTable("tail_holder", {
    name: s.string(),
    items: s.array(s.recordId(() => Item)),
  });
  const schema = { holders: Holder };

  const compile = async (args: Record<string, unknown>) => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, { schema });
    await client.holders.aggregate({ split: "items", ...args } as never);
    return calls[0]?.sql as string;
  };
  const reject = async (args: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema });
    try {
      await client.holders.aggregate({ split: "items", ...args } as never);
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("start/timeout ride the OUTER query (they page the groups, not the split rows)", async () => {
    const text = await compile({
      select: { _count: true },
      start: 2,
      timeout: 5,
    });
    expect(text).toContain("START $p0");
    expect(text).toContain("TIMEOUT 5ms");
    expect(text.indexOf("START")).toBeGreaterThan(text.indexOf("GROUP ALL"));
  });

  test("a nested path THROUGH an object segment stays permissive at the leaf", async () => {
    const Nested = defineTable("nested_obj", {
      name: s.string(),
      inner: s.object({ list: s.array(s.string()) }),
    });
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: { n: Nested } });
    let text = "";
    try {
      await client.n.aggregate({ select: { t: { sum: "inner.list.x" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    // The object segment stops the walk: the leaf below it is genuinely unknown to the schema.
    expect(text).toBe("");
  });

  test("a non-object / empty select on the split lowering is refused before the walk", async () => {
    expect(await reject({ select: undefined as never })).toMatch(/non-empty/);
    expect(await reject({ select: [] as never })).toMatch(/non-empty/);
    expect(await reject({ select: "name" as never })).toMatch(/non-empty/);
    expect(await reject({ select: { x: { sum: 1 as never } } })).toMatch(
      /field path/,
    );
    // the operand's right arm: a STRING that is present but empty
    expect(await reject({ select: { x: { sum: "" } } })).toMatch(/field path/);
  });

  test("groupBy + groupAll together is refused on the split lowering too", async () => {
    expect(
      await reject({ select: { _count: true }, groupBy: ["name"], groupAll: true }),
    ).toMatch(/OR "groupAll"/);
  });

  test("groupBy + groupAll together, an empty select and a bad split are all refused", async () => {
    expect(
      await reject({ select: { _count: true }, groupBy: ["name"], groupAll: true }),
    ).toMatch(/OR "groupAll"/);
    expect(await reject({ select: {} })).toMatch(/non-empty/);
    expect(await reject({ select: { x: 1 } })).toMatch(/must be true, a path/);
    expect(await reject({ split: "" })).toMatch(/must be a field path/);
    expect(await reject({ select: { allFalse: false as never } })).toMatch(
      /select is empty/,
    );
  });

  test("a multi-op or non-path aggregator entry is a teaching error", async () => {
    expect(
      await reject({ select: { x: { sum: "items[*].qty", avg: "x" } } }),
    ).toMatch(/one aggregator/);
    expect(await reject({ select: { x: { sum: 1 } } })).toMatch(/field path/);
    expect(await reject({ select: { x: { nope: "items[*].qty" } } })).toMatch(
      /unknown aggregator/,
    );
  });

  test("distinct over an element column lowers to array::distinct", async () => {
    expect(
      await compile({ select: { d: { distinct: "items[*].qty" } } }),
    ).toContain("array::distinct(_split_items_qty) AS d");
  });
});

describe("aggregate guard — the remaining arms (a/any/link/uuid families)", () => {
  const Odd = defineTable("odd", {
    flag: s.boolean(),
    blob: s.bytes(),
    ident: s.uuid(),
    dur: s.duration(),
    geo: s.geometry(),
    links: s.array(s.recordId("odd")),
    one: s.recordId("odd"),
  });
  const schema = { odds: Odd };

  // `aggregate` is a lazy thenable: the compile (and its guards) only run on await.
  const message = async (select: Record<string, unknown>) => {
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema });
    try {
      await client.odds.aggregate({ select: select as never });
      return "";
    } catch (e) {
      return (e as BetterSchemicError).message ?? "";
    }
  };

  test("a non-numeric scalar family is refused for every math op", async () => {
    for (const field of ["flag", "blob", "ident", "dur", "geo"] as const) {
      expect(await message({ t: { sum: field } })).toContain(
        "only aggregates NUMBERS",
      );
      expect(await message({ t: { median: field } })).toContain(
        "an empty object",
      );
      expect(await message({ t: { min: field } })).toContain("null");
      expect(await message({ t: { avg: field } })).toContain("0");
    }
  });

  test("a LIST link and a BARE link are both refused, with the split hint", async () => {
    expect(await message({ t: { sum: "links[*].x" } })).toContain(
      "list of record link",
    );
    expect(await message({ t: { sum: "one.x" } })).toContain("record link");
  });

  test("collect/distinct on any family are value ops — never refused", async () => {
    for (const field of ["flag", "blob", "ident", "dur", "geo", "links", "one"] as const) {
      expect(await message({ t: { collect: field } })).toBe("");
      expect(await message({ t: { distinct: field } })).toBe("");
    }
  });

  test("a table with only `id` refuses an unknown field, naming what it does have", async () => {
    const bare = { odds: defineTable("bare_odd", {}) };
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: bare });
    let text = "";
    try {
      await client.odds.aggregate({ select: { t: { sum: "nope.y" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain('"nope" is not a field of "bare_odd"');
    expect(text).toContain("Known fields: id");
  });

  test("an unknown field is refused with the known-field list (a SCHEMAFULL table rejects it too)", async () => {
    const empty = { odds: defineTable("empty_odd", {}) };
    const { conn } = fakeConn();
    const client = betterSchemic(conn, { schema: empty });
    let text = "";
    try {
      await client.odds.aggregate({ select: { t: { sum: "whatever" } } as never });
    } catch (e) {
      text = (e as BetterSchemicError).message ?? "";
    }
    expect(text).toContain("Known fields: id");
  });
});


describe("aggregate select — the resolver default and the inner projection", () => {
  const Shop = defineTable("entries_shop", {
    name: s.string(),
    score: s.int(),
    lines: s.array(s.recordId("entries_shop")),
  });
  const shopSchema = { shops: Shop };
  const shopMeta = buildSchemaIndex(shopSchema).tables.get("shops") as TableMeta;

  test("the plain resolver makes the path the column, with nothing projected in front", () => {
    const { parts, inners } = compileAggregateSelect(
      shopMeta,
      { total: { sum: "score" }, tag: "name" },
      createBinds(),
      "aggregate",
      directColumns(shopMeta),
    );
    expect(parts).toEqual(["math::sum(score) AS total", "name AS tag"]);
    expect(inners).toEqual([]);
  });

  test("a resolver that collects inner projections hands them back", () => {
    const inners: string[] = [];
    const { parts } = compileAggregateSelect(
      shopMeta,
      { total: { sum: "q" } },
      createBinds(),
      "aggregate",
      {
        inners,
        of: (path) => `_split_${path}`,
        prefix: () => ["lines"],
      },
    );
    expect(inners).toEqual([]);
    expect(parts).toEqual(["math::sum(_split_q) AS total"]);
  });

  test("a split operand that names the ELEMENT is left to the server", async () => {
    // `lines` is a record LIST: the walk cannot reach through it, so the parent does not judge the
    // element's field — the element lives in another table this meta cannot describe.
    expect(
      await refusal(shopSchema, "shops", {
        split: "lines",
        select: { total: { sum: "lines[*].score" } },
      }),
    ).toBe("");
    // …but a path that stays on the parent IS still judged.
    expect(
      await refusal(shopSchema, "shops", {
        split: "lines",
        select: { total: { sum: "name" } },
      }),
    ).toContain("only aggregates NUMBERS");
  });
});

describe("aggregate select — the entry-shape refusals and the fragment fallback", () => {
  test("a select that is not a non-empty object is refused, by BOTH halves of the test", async () => {
    for (const select of [undefined, null, 7, "name", []]) {
      // `!isPlainObject(select)` false, `Object.keys(...).length === 0` true
      expect(await refusal({ deeps: Deep }, "deeps", { select })).toMatch(
        /select must be a non-empty object/,
      );
    }
    // an EMPTY object: the first operand false, the second true
    expect(await refusal({ deeps: Deep }, "deeps", { select: {} })).toMatch(
      /select must be a non-empty object/,
    );
    // both operands false → the guard does NOT fire, so a different error comes from the loop
    expect(await refusal({ deeps: Deep }, "deeps", { select: { total: true } })).toBe("");
  });

  test("a plain resolver with no fragment hook falls back to the entry's own alias", () => {
    // `directColumns` declares no `fragment`, so the `??` arm is the one that runs.
    const { parts } = compileAggregateSelect(
      buildSchemaIndex({ deeps: Deep }).tables.get("deeps") as TableMeta,
      { upper: surql`count() + 1` },
      createBinds(),
      "aggregate",
      directColumns(buildSchemaIndex({ deeps: Deep }).tables.get("deeps") as TableMeta),
    );
    expect(parts).toEqual(["(count() + 1) AS upper"]);
  });
});

describe("aggregate operand — a split over a record SET", () => {
  const Tag = defineTable("set_line", { label: s.string(), qty: s.int() });
  const Box = defineTable("set_holder", {
    name: s.string(),
    // A SET of links is an ARRAY-family field AND a record family — the operand walk must treat it
    // as "descends into the element", exactly like a list of links.
    members: s.set(s.recordId("set_line")),
  });
  const schema = { boxes: Box };

  test("an element path through a record SET is left to the server, like a list", async () => {
    expect(
      await refusal(schema, "boxes", {
        split: "members",
        select: { total: { sum: "members[*].qty" } },
      }),
    ).toBe("");
  });

  test("a non-link array base is still the parent's to judge", async () => {
    const WithList = defineTable("list_holder", {
      tags: s.array(s.string()),
      score: s.int(),
    });
    expect(
      await refusal({ holders: WithList }, "holders", {
        split: "tags",
        select: { total: { sum: "tags" } },
      }),
    ).toContain("only aggregates NUMBERS");
  });
});

describe("assertGroupKeysProjected — the three ways out", () => {
  const guard = (groupBy: string[], keys: string[], hasExpression: boolean) => {
    try {
      assertGroupKeysProjected(groupBy, new Set(keys), hasExpression, "aggregate");
      return "skipped";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("no group keys → nothing to project, whatever the select holds", () => {
    expect(guard([], [], false)).toBe("skipped");
    expect(guard([], [], true)).toBe("skipped");
  });

  test("an EXPRESSION entry makes the projection unanalyzable → the server's call", () => {
    expect(guard(["name"], ["name"], true)).toBe("skipped");
    // the key is not even in the projection — still the server's problem, not a compile error
    expect(guard(["name"], [], true)).toBe("skipped");
  });

  test("a statically analyzable projection must carry EVERY group key", () => {
    expect(guard(["name"], ["name"], false)).toBe("skipped");
    const refused = guard(["name", "seat"], ["name"], false);
    expect(refused).toContain('groupBy key "seat" is missing from select');
    // the message teaches the fix by name
    expect(refused).toContain('`seat: "seat"`');
  });
});

describe("aggregate select — the decode leaf each aggregator gets", () => {
  const Numeric = defineTable("leaf_num", { score: s.int(), label: s.string() });
  const meta = buildSchemaIndex({ nums: Numeric }).tables.get("nums") as TableMeta;
  const leaves = (select: Record<string, unknown>) =>
    compileAggregateSelect(
      meta,
      select,
      createBinds(),
      "aggregate",
      directColumns(meta),
    ).fields;

  test("min/max keep the COLUMN's codec — their result IS a value of that column", () => {
    for (const op of ["min", "max"]) {
      const [leaf] = leaves({ v: { [op]: "score" } });
      expect(leaf?.expr).not.toBe("");
      expect(leaf?.each).toBe(false);
    }
  });

  test("collect/distinct keep the codec with `each` — the result is an array of it", () => {
    for (const op of ["collect", "distinct"]) {
      const [leaf] = leaves({ v: { [op]: "score" } });
      expect(leaf?.expr).not.toBe("");
      expect(leaf?.each).toBe(true);
    }
  });

  test("every OTHER math op gets a BLANK leaf — the server computed a number", () => {
    // `math::mean(age)` answers a float; decoding it through `age`'s int codec rejects the server's
    // own answer. This is a live-verified regression pin, not a style choice.
    for (const op of ["sum", "avg", "median", "stddev", "variance"]) {
      const [leaf] = leaves({ v: { [op]: "score" } });
      expect(leaf?.expr).toBe("");
      expect(leaf?.each).toBe(false);
      expect(leaf?.out).toEqual(["v"]);
    }
  });
});
