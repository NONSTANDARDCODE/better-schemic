// M1.6 — `cursor` (keyset pages): the ORDER BY idiom needs every ordered field in the projection,
// so the compiler appends reserved `_keyset_<n>` aliases for the fields the user's select/omit does
// not return, reads the cursors from them and strips them from `data`. Offline. `paginate` lives in
// `orm-pagination.test.ts`.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { compileCursor } from "../../src/orm/compiler/pagination";
import { createBinds } from "../../src/orm/compiler/shared";
import type { BetterSchemicError } from "../../src/orm/errors";
import type { TableMeta } from "../../src/orm/meta";
import { buildSchemaIndex } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()),
});
const meta = buildSchemaIndex({ users: User }).tables.get("users") as TableMeta;

const Place = defineTable("place", {
  name: s.string(),
  address: s.object({ city: s.string(), zip: s.string() }),
});
const placeMeta = buildSchemaIndex({ places: Place }).tables.get(
  "places",
) as TableMeta;

const Home = defineTable("home", {
  name: s.string(),
  address: s.object({ city: s.string() }).nullish(),
});

const fullUser = (id: string, over: Record<string, unknown> = {}) => ({
  id: new RecordId("user", id),
  name: `u${id}`,
  age: 20,
  active: true,
  tags: [],
  ...over,
});

function compileCursorArgs(args: Record<string, unknown>) {
  const binds = createBinds();
  const plan = compileCursor(meta, args, binds);
  return { ...plan, vars: binds.vars };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}

describe("cursor — compilation", () => {
  test("default order is id ASC; the probe is LIMIT n+1", () => {
    const plan = compileCursorArgs({ limit: 10 });
    expect(plan.sql).toBe("SELECT * FROM user ORDER BY id ASC LIMIT $p0");
    expect(plan.vars).toEqual({ p0: 11 });
    expect(plan.backward).toBe(false);
    expect(plan.keyset).toEqual([{ field: "id" }]);
  });

  test("after on a tuple builds the OR/AND keyset comparison", () => {
    const id = new RecordId("user", "9");
    const plan = compileCursorArgs({
      limit: 10,
      orderBy: [{ age: "desc" }, { id: "asc" }],
      after: { age: 30, id },
    });
    expect(plan.sql).toBe(
      "SELECT * FROM user WHERE (age < $c0 OR (age = $c0 AND id > $c1)) ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(plan.vars).toEqual({ c0: 30, c1: id, p0: 11 });
  });

  test("before reverses the order and the comparison", () => {
    const plan = compileCursorArgs({
      limit: 10,
      before: new RecordId("user", "9"),
    });
    expect(plan.sql).toBe(
      "SELECT * FROM user WHERE (id < $c0) ORDER BY id DESC LIMIT $p0",
    );
    expect(plan.backward).toBe(true);
  });

  test("after and before conflict", () => {
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 10,
          after: "user:1",
          before: "user:9",
        }),
      ),
    ).toBe("CursorDirectionConflict");
  });

  test("the last orderBy field must be unique", () => {
    expect(
      codeOf(() => compileCursorArgs({ limit: 10, orderBy: [{ age: "asc" }] })),
    ).toBe("CursorTiebreakerRequired");
    // age (not unique) followed by id (unique) is a valid keyset.
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 10,
          orderBy: [{ age: "asc" }, { id: "asc" }],
        }),
      ),
    ).toBeUndefined();
  });

  test("groupBy/split are rejected", () => {
    expect(codeOf(() => compileCursorArgs({ limit: 10, groupAll: true }))).toBe(
      "ClauseNotSupported",
    );
    expect(
      codeOf(() => compileCursorArgs({ limit: 10, groupBy: ["active"] })),
    ).toBe("ClauseNotSupported");
    expect(codeOf(() => compileCursorArgs({ limit: 10, split: "tags" }))).toBe(
      "ClauseNotSupported",
    );
  });

  test("a user where ANDs with the keyset predicate", () => {
    const plan = compileCursorArgs({
      limit: 10,
      where: { active: true },
      after: new RecordId("user", "5"),
    });
    expect(plan.sql).toBe(
      "SELECT * FROM user WHERE (active = $p0 AND (id > $c0)) ORDER BY id ASC LIMIT $p1",
    );
    expect(plan.vars).toEqual({
      p0: true,
      c0: new RecordId("user", "5"),
      p1: 11,
    });
  });

  test("an empty orderBy is rejected", () => {
    expect(codeOf(() => compileCursorArgs({ limit: 10, orderBy: [] }))).toBe(
      "CursorTiebreakerRequired",
    );
  });

  test("a tuple cursor missing a field is a teaching error", () => {
    const err = (() => {
      try {
        compileCursorArgs({
          limit: 10,
          orderBy: [{ age: "asc" }, { id: "asc" }],
          after: { age: 30 },
        });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain('"id"');
  });

  test("ordered fields missing from select ride reserved aliases", () => {
    const plan = compileCursorArgs({
      limit: 10,
      select: { name: true },
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(plan.sql).toBe(
      "SELECT name, age AS _keyset_0, id AS _keyset_1 FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "age", alias: "_keyset_0" },
      { field: "id", alias: "_keyset_1" },
    ]);
  });

  test("the default id keyset takes an alias when select omits id", () => {
    const plan = compileCursorArgs({ limit: 5, select: { name: true } });
    expect(plan.sql).toBe(
      "SELECT name, id AS _keyset_0 FROM user ORDER BY id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([{ field: "id", alias: "_keyset_0" }]);
  });

  test("a select that already returns the keyset fields is used as-is", () => {
    const plan = compileCursorArgs({
      limit: 5,
      select: { age: true, id: true },
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(plan.sql).toBe(
      "SELECT age, id FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([{ field: "age" }, { field: "id" }]);
    const listed = compileCursorArgs({
      limit: 5,
      select: ["name", "age", "id"],
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(listed.sql).toBe(
      "SELECT name, age, id FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(listed.keyset).toEqual([{ field: "age" }, { field: "id" }]);
  });

  test("a select prefix already returns a nested keyset path", () => {
    const order = [{ "address.city": "asc" }, { id: "asc" }];
    const array = compileCursor(
      placeMeta,
      { limit: 1, select: ["address"], orderBy: order },
      createBinds(),
    );
    expect(array.sql).toBe(
      "SELECT address, id AS _keyset_1 FROM place ORDER BY address.city ASC, id ASC LIMIT $p0",
    );
    expect(array.keyset).toEqual([
      { field: "address.city" },
      { field: "id", alias: "_keyset_1" },
    ]);
    const nested = compileCursor(
      placeMeta,
      { limit: 1, select: { address: { city: true } }, orderBy: order },
      createBinds(),
    );
    expect(nested.sql).toBe(
      "SELECT address.city, id AS _keyset_1 FROM place ORDER BY address.city ASC, id ASC LIMIT $p0",
    );
    expect(nested.keyset).toEqual([
      { field: "address.city" },
      { field: "id", alias: "_keyset_1" },
    ]);
    // A dotted `true` key and a same-path alias carry the path too.
    for (const select of [
      { "address.city": true },
      { "address.city": "address.city" },
    ]) {
      const flat = compileCursor(
        placeMeta,
        { limit: 1, select, orderBy: order },
        createBinds(),
      );
      expect(flat.keyset[0]).toEqual({ field: "address.city" });
    }
  });

  test("a nested keyset path missing from select rides an alias", () => {
    const plan = compileCursor(
      placeMeta,
      {
        limit: 1,
        select: { name: true },
        orderBy: [{ "address.city": "asc" }, { id: "asc" }],
      },
      createBinds(),
    );
    expect(plan.sql).toBe(
      "SELECT name, address.city AS _keyset_0, id AS _keyset_1 FROM place ORDER BY address.city ASC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "address.city", alias: "_keyset_0" },
      { field: "id", alias: "_keyset_1" },
    ]);
  });

  test("a nested select that misses the ordered path falls back to an alias", () => {
    const plan = compileCursor(
      placeMeta,
      {
        limit: 1,
        select: { address: { zip: true } },
        orderBy: [{ "address.city": "asc" }, { id: "asc" }],
      },
      createBinds(),
    );
    expect(plan.sql).toBe(
      "SELECT address.zip, address.city AS _keyset_0, id AS _keyset_1 FROM place ORDER BY address.city ASC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "address.city", alias: "_keyset_0" },
      { field: "id", alias: "_keyset_1" },
    ]);
    // An expression at a prefix key carries no path either.
    const expression = compileCursor(
      placeMeta,
      {
        limit: 1,
        select: { address: surql`address` },
        orderBy: [{ "address.city": "asc" }, { id: "asc" }],
      },
      createBinds(),
    );
    expect(expression.keyset[0]).toEqual({
      field: "address.city",
      alias: "_keyset_0",
    });
  });

  test("a same-length alias path that differs from the ordered path is rejected", () => {
    // `{ age: "id" }`-style redefinition, and a depth-mismatched alias of the ordered key.
    expect(
      codeOf(() =>
        compileCursor(
          placeMeta,
          {
            limit: 1,
            select: { "address.city": "address" },
            orderBy: [{ "address.city": "asc" }, { id: "asc" }],
          },
          createBinds(),
        ),
      ),
    ).toBe("ValidationError");
  });

  test("a schemaless entry has no declared shape to collide with", () => {
    const schemalessMeta = buildSchemaIndex({
      audit: "audit_log",
    }).schemaless.get("audit");
    if (!schemalessMeta) throw new Error("no schemaless meta");
    const plan = compileCursor(
      schemalessMeta,
      { limit: 1, omit: ["id"] },
      createBinds(),
    );
    expect(plan.sql).toBe(
      "SELECT *, id AS _keyset_0 OMIT id FROM audit_log ORDER BY id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([{ field: "id", alias: "_keyset_0" }]);
  });

  test("omit is never rewritten: a hidden keyset field rides an alias", () => {
    const plan = compileCursorArgs({
      limit: 2,
      omit: ["age"],
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(plan.sql).toBe(
      "SELECT *, age AS _keyset_0 OMIT age FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "age", alias: "_keyset_0" },
      { field: "id" },
    ]);
    const kept = compileCursorArgs({
      limit: 2,
      omit: ["tags"],
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(kept.sql).toBe(
      "SELECT * OMIT tags FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(kept.keyset).toEqual([{ field: "age" }, { field: "id" }]);
  });

  test("select alias/expression entries do not shadow a differently-named order field", () => {
    // `{ age: "id" }` renames id to age; ordering by age would bind the alias — rejected.
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 1,
          select: { age: "id" },
          orderBy: [{ age: "asc" }, { id: "asc" }],
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 1,
          select: { age: surql`age + 1` },
          orderBy: [{ age: "asc" }, { id: "asc" }],
        }),
      ),
    ).toBe("ValidationError");
    // A same-path alias is not a redefinition.
    const same = compileCursorArgs({
      limit: 1,
      select: { age: "age" },
      orderBy: [{ age: "asc" }, { id: "asc" }],
    });
    expect(same.keyset).toEqual([
      { field: "age" },
      { field: "id", alias: "_keyset_1" },
    ]);
  });

  test("ordering by a parent whose select is narrower rides the parent alias", () => {
    const plan = compileCursor(
      placeMeta,
      {
        limit: 1,
        select: { address: { city: true } },
        orderBy: [{ address: "asc" }, { id: "asc" }],
      },
      createBinds(),
    );
    expect(plan.sql).toBe(
      "SELECT address.city, address AS _keyset_0, id AS _keyset_1 FROM place ORDER BY address ASC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "address", alias: "_keyset_0" },
      { field: "id", alias: "_keyset_1" },
    ]);
  });

  test("value/only/start are rejected with cursor", () => {
    expect(codeOf(() => compileCursorArgs({ limit: 1, value: true }))).toBe(
      "ClauseNotSupported",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, only: true }))).toBe(
      "ClauseNotSupported",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, start: 5 }))).toBe(
      "ClauseNotSupported",
    );
  });

  test("an empty or malformed select still fails instead of being papered over", () => {
    expect(codeOf(() => compileCursorArgs({ limit: 1, select: {} }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, select: [] }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, select: [1] }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, select: [""] }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() => compileCursorArgs({ limit: 1, select: { "*": false } })),
    ).toBe("ValidationError");
    expect(codeOf(() => compileCursorArgs({ limit: 1, select: 5 }))).toBe(
      "ValidationError",
    );
  });

  test("a false entry doesn't block the keyset alias", () => {
    const plan = compileCursorArgs({
      limit: 1,
      select: { id: false, name: true },
    });
    expect(plan.sql).toBe(
      "SELECT name, id AS _keyset_0 FROM user ORDER BY id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([{ field: "id", alias: "_keyset_0" }]);
    const undefinedEntry = compileCursorArgs({
      limit: 1,
      select: { id: undefined, name: true },
    });
    expect(undefinedEntry.sql).toBe(
      "SELECT name, id AS _keyset_0 FROM user ORDER BY id ASC LIMIT $p0",
    );
  });

  test("select null and `*` are star projections (keyset fields ride in place)", () => {
    const nullSelect = compileCursorArgs({ limit: 1, select: null });
    expect(nullSelect.sql).toBe("SELECT * FROM user ORDER BY id ASC LIMIT $p0");
    expect(nullSelect.keyset).toEqual([{ field: "id" }]);
    const star = compileCursorArgs({
      limit: 1,
      select: { "*": true, name: true },
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(star.sql).toBe(
      "SELECT *, name FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(star.keyset).toEqual([{ field: "age" }, { field: "id" }]);
  });

  test("star + omit + explicit select keeps OMIT and aliases the field", () => {
    const plan = compileCursorArgs({
      limit: 1,
      select: { "*": true, age: true },
      omit: ["age"],
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(plan.sql).toBe(
      "SELECT *, age, age AS _keyset_0 OMIT age FROM user ORDER BY age DESC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "age", alias: "_keyset_0" },
      { field: "id" },
    ]);
  });

  test("a malformed omit is left to compileRead", () => {
    expect(codeOf(() => compileCursorArgs({ limit: 1, omit: [5] }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compileCursorArgs({ limit: 1, omit: [""] }))).toBe(
      "ValidationError",
    );
  });

  test("a field list that projects only a descendant of the ordered path aliases the parent", () => {
    const plan = compileCursor(
      placeMeta,
      {
        limit: 1,
        select: ["address.city", "name"],
        orderBy: [{ address: "asc" }, { id: "asc" }],
      },
      createBinds(),
    );
    expect(plan.sql).toBe(
      "SELECT address.city, name, address AS _keyset_0, id AS _keyset_1 FROM place ORDER BY address ASC, id ASC LIMIT $p0",
    );
    expect(plan.keyset).toEqual([
      { field: "address", alias: "_keyset_0" },
      { field: "id", alias: "_keyset_1" },
    ]);
  });

  test("the reserved alias namespace is validated against the projection", () => {
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 1,
          select: { _keyset_0: true, name: true },
        }),
      ),
    ).toBe("ValidationError");
    const Reserved = defineTable("reserved", {
      _keyset_0: s.string(),
      name: s.string(),
    });
    const reservedMeta = buildSchemaIndex({ reserved: Reserved }).tables.get(
      "reserved",
    ) as TableMeta;
    // `*` returns the declared row, so a real field with the reserved name collides too.
    expect(
      codeOf(() =>
        compileCursor(reservedMeta, { limit: 1, omit: ["id"] }, createBinds()),
      ),
    ).toBe("ValidationError");
  });
});

describe("cursor — delegate envelope", () => {
  test("a forward page builds nextCursor from the last row", async () => {
    const rows = [fullUser("1"), fullUser("2"), fullUser("3")];
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([...rows, fullUser("4")])),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({ limit: 3 });
    expect(page.data).toHaveLength(3);
    expect(page.pagination).toEqual({
      type: "cursor",
      hasNext: true,
      hasPrevious: false,
      nextCursor: new RecordId("user", "3"),
      previousCursor: null,
    });
  });

  test("a before page is reversed back and exposes both cursors", async () => {
    const rows = [fullUser("9"), fullUser("8"), fullUser("7"), fullUser("6")];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({
      limit: 3,
      before: new RecordId("user", "10"),
    });
    expect(page.data.map((row) => row.id)).toEqual([
      new RecordId("user", "7"),
      new RecordId("user", "8"),
      new RecordId("user", "9"),
    ]);
    expect(page.pagination).toEqual({
      type: "cursor",
      hasNext: true,
      hasPrevious: true,
      nextCursor: new RecordId("user", "9"),
      previousCursor: new RecordId("user", "7"),
    });
  });

  test("keyset aliases are read for the cursors and stripped from data", async () => {
    const rows = [
      {
        name: "a",
        age: 30,
        _keyset_0: 30,
        _keyset_1: new RecordId("user", "1"),
      },
      {
        name: "b",
        age: 29,
        _keyset_0: 29,
        _keyset_1: new RecordId("user", "2"),
      },
      {
        name: "c",
        age: 28,
        _keyset_0: 28,
        _keyset_1: new RecordId("user", "3"),
      },
    ];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({
      limit: 2,
      select: { name: true },
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(calls[0]?.sql).toContain(
      "SELECT name, age AS _keyset_0, id AS _keyset_1 FROM user",
    );
    expect(page.data).toEqual([{ name: "a" }, { name: "b" }]);
    expect(page.pagination.nextCursor).toEqual({
      age: 29,
      id: new RecordId("user", "2"),
    });
  });

  test("the default id keyset alias yields a scalar cursor", async () => {
    const rows = [
      { name: "a", _keyset_0: new RecordId("user", "1") },
      { name: "b", _keyset_0: new RecordId("user", "2") },
      { name: "c", _keyset_0: new RecordId("user", "3") },
    ];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({
      limit: 2,
      select: { name: true },
    });
    expect(calls[0]?.sql).toContain("SELECT name, id AS _keyset_0 FROM user");
    expect(page.data).toEqual([{ name: "a" }, { name: "b" }]);
    expect(page.pagination.nextCursor).toEqual(new RecordId("user", "2"));
  });

  test("omit keeps its semantics: the hidden field is aliased and stripped", async () => {
    const rows = [
      {
        id: new RecordId("user", "1"),
        name: "u1",
        active: true,
        tags: [],
        _keyset_0: 20,
      },
      {
        id: new RecordId("user", "2"),
        name: "u2",
        active: true,
        tags: [],
        _keyset_0: 20,
      },
      {
        id: new RecordId("user", "3"),
        name: "u3",
        active: true,
        tags: [],
        _keyset_0: 20,
      },
    ];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({
      limit: 2,
      omit: ["age"],
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(calls[0]?.sql).toContain("age AS _keyset_0 OMIT age");
    expect(page.data[1]).toEqual({
      id: new RecordId("user", "2"),
      name: "u2",
      active: true,
      tags: [],
    });
    expect(page.pagination.nextCursor).toEqual({
      age: 20,
      id: new RecordId("user", "2"),
    });
  });

  test("a nested keyset path is read from its alias and stripped", async () => {
    const rows = [
      {
        name: "a",
        _keyset_0: "SP",
        _keyset_1: new RecordId("place", "1"),
      },
      {
        name: "b",
        _keyset_0: "RJ",
        _keyset_1: new RecordId("place", "2"),
      },
      {
        name: "c",
        _keyset_0: "MG",
        _keyset_1: new RecordId("place", "3"),
      },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { places: Place } });
    const page = await client.places.cursor({
      limit: 2,
      select: { name: true },
      orderBy: [{ "address.city": "asc" }, { id: "asc" }],
    });
    expect(page.data).toEqual([{ name: "a" }, { name: "b" }]);
    expect(page.pagination.nextCursor).toEqual({
      "address.city": "RJ",
      id: new RecordId("place", "2"),
    });
  });

  test("a natural nested keyset path is read from the decoded row", async () => {
    const rows = [
      { address: { city: "SP" }, _keyset_1: new RecordId("place", "1") },
      { address: { city: "RJ" }, _keyset_1: new RecordId("place", "2") },
      { address: { city: "MG" }, _keyset_1: new RecordId("place", "3") },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { places: Place } });
    const page = await client.places.cursor({
      limit: 2,
      select: { address: { city: true } },
      orderBy: [{ "address.city": "asc" }, { id: "asc" }],
    });
    expect(page.data).toEqual([
      { address: { city: "SP" } },
      { address: { city: "RJ" } },
    ]);
    expect(page.pagination.nextCursor).toEqual({
      "address.city": "RJ",
      id: new RecordId("place", "2"),
    });
  });

  test("a same-path dotted alias decodes flat and is still read", async () => {
    const rows = [
      { "address.city": "SP", _keyset_1: new RecordId("place", "1") },
      { "address.city": "RJ", _keyset_1: new RecordId("place", "2") },
      { "address.city": "MG", _keyset_1: new RecordId("place", "3") },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { places: Place } });
    const page = await client.places.cursor({
      limit: 2,
      select: { "address.city": "address.city" },
      orderBy: [{ "address.city": "asc" }, { id: "asc" }],
    });
    expect(page.data).toEqual([
      { "address.city": "SP" },
      { "address.city": "RJ" },
    ]);
    expect(page.pagination.nextCursor).toEqual({
      "address.city": "RJ",
      id: new RecordId("place", "2"),
    });
  });

  test("a row the server returns without a keyset value is a teaching error", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ age: 20 }, { age: 21 }, { age: 22 }])),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const err = (await client.users
      .cursor({
        limit: 2,
        select: { age: true },
        orderBy: [{ age: "asc" }, { id: "asc" }],
      })
      .catch((e: unknown) => e)) as BetterSchemicError;
    expect(err.code).toBe("ValidationError");
    expect(err.message).toContain('"id"');
  });

  test("a nested keyset path through a missing ancestor is a teaching error", async () => {
    const rows = [
      { id: new RecordId("home", "1"), name: "a" },
      { id: new RecordId("home", "2"), name: "b" },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { homes: Home } });
    const err = (await client.homes
      .cursor({
        limit: 1,
        orderBy: [{ "address.city": "asc" }, { id: "asc" }],
      })
      .catch((e: unknown) => e)) as BetterSchemicError;
    expect(err.code).toBe("ValidationError");
    expect(err.message).toContain("address.city");
  });

  test("a NULL or ARRAY ancestor of the keyset path is a teaching error", async () => {
    const nullRows = [
      { id: new RecordId("home", "1"), name: "a", address: null },
      { id: new RecordId("home", "2"), name: "b", address: null },
    ];
    const nullConn = fakeConn((sql) => lines(sql).map(() => ok(nullRows)));
    const nullClient = betterSchemic(nullConn.conn, {
      schema: { homes: Home },
    });
    const nullErr = (await nullClient.homes
      .cursor({
        limit: 1,
        orderBy: [{ "address.city": "asc" }, { id: "asc" }],
      })
      .catch((e: unknown) => e)) as BetterSchemicError;
    expect(nullErr.code).toBe("ValidationError");

    // A `*` row whose ordered path runs into an ARRAY (the decoded shape can't be keyed).
    const arrayRows = [fullUser("1"), fullUser("2")];
    const arrayConn = fakeConn((sql) => lines(sql).map(() => ok(arrayRows)));
    const arrayClient = betterSchemic(arrayConn.conn, {
      schema: { users: User },
    });
    const arrayErr = (await arrayClient.users
      .cursor({
        limit: 1,
        orderBy: [{ "tags.length": "asc" }, { id: "asc" }],
      })
      .catch((e: unknown) => e)) as BetterSchemicError;
    expect(arrayErr.code).toBe("ValidationError");
    expect(arrayErr.message).toContain("tags.length");
  });

  test("a dotted omit + a null ancestor strips defensively when no cursor is built", async () => {
    const rows = [{ id: new RecordId("home", "1"), name: "a", address: null }];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { homes: Home } });
    const page = await client.homes.cursor({
      limit: 2,
      // A dotted omit is outside the typed surface (`omit` is top-level keys) but must not crash.
      omit: ["address.city"] as unknown as readonly "address"[],
      orderBy: [{ "address.city": "asc" }, { id: "asc" }],
    });
    expect(page.pagination.hasNext).toBe(false);
    expect(page.data as unknown).toEqual([
      { id: new RecordId("home", "1"), name: "a", address: null },
    ]);
  });

  test("a natural select decodes the rows and builds the tuple cursor", async () => {
    const rows = [
      { age: 30, id: new RecordId("user", "1") },
      { age: 29, id: new RecordId("user", "2") },
      { age: 28, id: new RecordId("user", "3") },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.cursor({
      limit: 2,
      select: { age: true, id: true },
      orderBy: [{ age: "desc" }, { id: "asc" }],
    });
    expect(page.data).toEqual([
      { age: 30, id: new RecordId("user", "1") },
      { age: 29, id: new RecordId("user", "2") },
    ]);
    expect(page.pagination.nextCursor).toEqual({
      age: 29,
      id: new RecordId("user", "2"),
    });
  });

  test("a schemaless star row rides in place and strips defensively", async () => {
    const rows = ["a", "b", "c"];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { audit: "audit_log" } });
    const page = await client.audit.cursor({ limit: 2 });
    expect(calls[0]?.sql).toBe(
      "SELECT * FROM audit_log ORDER BY id ASC LIMIT $p0;",
    );
    expect(page.data as unknown).toEqual(["a", "b"]);
    expect(page.pagination.nextCursor).toBeUndefined();
  });

  test("a schemaless row under a keyset alias is read and stripped defensively", async () => {
    const rows = ["a", "b", "c"];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { audit: "audit_log" } });
    const page = await client.audit.cursor({ limit: 2, omit: ["id"] });
    expect(calls[0]?.sql).toBe(
      "SELECT *, id AS _keyset_0 OMIT id FROM audit_log ORDER BY id ASC LIMIT $p0;",
    );
    expect(page.data as unknown).toEqual(["a", "b"]);
    expect(page.pagination.nextCursor).toBeUndefined();
  });
});

describe("cursor — guard paths", () => {
  test("orderBy must be plain fields with asc/desc; undefined is skipped", () => {
    expect(
      codeOf(() => compileCursorArgs({ limit: 1, orderBy: [surql`rand()`] })),
    ).toBe("CursorTiebreakerRequired");
    expect(
      codeOf(() => compileCursorArgs({ limit: 1, orderBy: [{ name: "up" }] })),
    ).toBe("CursorTiebreakerRequired");
    expect(
      compileCursorArgs({
        limit: 1,
        orderBy: [{ name: undefined, id: "asc" }],
      }).sql,
    ).toContain("ORDER BY id ASC");
  });

  test("a single-id cursor may be a bare record id", () => {
    expect(
      compileCursorArgs({ limit: 1, after: new RecordId("user", "1") }).sql,
    ).toContain("id >");
  });

  test("a multi-field cursor must be an object", () => {
    expect(
      codeOf(() =>
        compileCursorArgs({
          limit: 1,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          after: 5,
        }),
      ),
    ).toBe("ValidationError");
  });

  test("a single-field UNIQUE order is a valid tiebreaker", () => {
    const U = defineTable("u2", { email: s.string() }).index(
      "u2_email",
      ["email"],
      { unique: true },
    );
    const m = buildSchemaIndex({ us: U }).tables.get("us") as TableMeta;
    const plan = compileCursor(
      m,
      { limit: 1, orderBy: [{ email: "asc" }] },
      createBinds(),
    );
    expect(plan.sql).toContain("email");
  });

  test("orderBy may be a single object; a backward desc page flips direction", () => {
    expect(
      compileCursorArgs({ limit: 1, orderBy: { id: "asc" } }).sql,
    ).toContain("ORDER BY id ASC");
    const plan = compileCursorArgs({
      limit: 1,
      orderBy: [{ age: "desc" }, { id: "asc" }],
      before: { age: 30, id: new RecordId("user", "5") },
    });
    expect(plan.sql).toContain("ORDER BY age ASC");
  });

  test("a three-field cursor parenthesizes the nested tuple", () => {
    const plan = compileCursorArgs({
      limit: 1,
      orderBy: [{ age: "asc" }, { name: "asc" }, { id: "asc" }],
      after: { age: 30, name: "A", id: new RecordId("user", "5") },
    });
    expect(plan.sql).toContain("OR (");
  });

  test("a single unique (non-id) field takes an object cursor; id takes an object too", () => {
    const U = defineTable("u3", { email: s.string() }).index(
      "u3_email",
      ["email"],
      { unique: true },
    );
    const m = buildSchemaIndex({ us: U }).tables.get("us") as TableMeta;
    expect(
      compileCursor(
        m,
        { limit: 1, orderBy: [{ email: "asc" }], after: { email: "a@x" } },
        createBinds(),
      ).sql,
    ).toContain("email >");
    expect(
      compileCursorArgs({
        limit: 1,
        after: { id: new RecordId("user", "5") },
      }).sql,
    ).toContain("id >");
  });
});

describe("cursor — raw keyset values (datetime precision)", () => {
  const Event = defineTable("event", {
    name: s.string(),
    at: s.datetime(),
  });

  /** A `DateTime` sharing one millisecond (`.123`) with distinct nanoseconds. */
  const at = (ns: number): DateTime =>
    new DateTime(`2026-08-01T10:00:00.12300000${ns}Z`);

  /** A full raw row whose `at` carries nanoseconds (same ms across the fixture). */
  const eventRow = (id: string, ns: number) => ({
    id: new RecordId("event", id),
    name: `ns-${id}`,
    at: at(ns),
  });

  test("an aliased datetime keyset value keeps its nanoseconds", async () => {
    // The server answers the ALIASED projection: `at`/`id` ride `_keyset_0`/`_keyset_1`.
    const rows = [7, 6, 5].map((ns) => ({
      name: `ns-${ns}`,
      _keyset_0: at(ns),
      _keyset_1: new RecordId("event", String(ns)),
    }));
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { events: Event } });
    const page = await client.events.cursor({
      limit: 2,
      select: { name: true },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(calls[0]?.sql).toContain("at AS _keyset_0, id AS _keyset_1");
    expect(page.data).toEqual([{ name: "ns-7" }, { name: "ns-6" }]);
    expect(Object.keys(page.data[0] as object)).not.toContain("_keyset_0");
    // The cursor carries the STORED DateTime (ns), not the ms-truncated decoded Date.
    const cursor = page.pagination.nextCursor as { at: DateTime; id: RecordId };
    expect(cursor.at).toBeInstanceOf(DateTime);
    expect(cursor.at.toISOString()).toBe("2026-08-01T10:00:00.123000006Z");
    expect(JSON.parse(JSON.stringify(cursor.at))).toBe(
      "2026-08-01T10:00:00.123000006Z",
    );
    // Feeding it back binds the exact DateTime — the ns survive `after`.
    await client.events.cursor({
      limit: 2,
      select: { name: true },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      after: cursor,
    });
    const bound = calls[1]?.vars?.c0;
    expect(bound).toBeInstanceOf(DateTime);
    expect((bound as DateTime).toISOString()).toBe(
      "2026-08-01T10:00:00.123000006Z",
    );
  });

  test("an in-place datetime decodes to Date but its cursor stays raw", async () => {
    const rows = [eventRow("7", 7), eventRow("6", 6), eventRow("5", 5)];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { events: Event } });
    const page = await client.events.cursor({
      limit: 2,
      select: { at: true, name: true, id: true },
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(calls[0]?.sql).toBe(
      "SELECT at, name, id FROM event ORDER BY at DESC, id DESC LIMIT $p0;",
    );
    const row = page.data[0] as { at: Date };
    expect(row.at).toBeInstanceOf(Date);
    expect(row.at.toISOString()).toBe("2026-08-01T10:00:00.123Z");
    const cursor = page.pagination.nextCursor as { at: DateTime; id: RecordId };
    expect(cursor.at).toBeInstanceOf(DateTime);
    expect(cursor.at.toISOString()).toBe("2026-08-01T10:00:00.123000006Z");
  });

  test("a star row decodes `at` to Date and keeps the raw cursor", async () => {
    const rows = [eventRow("7", 7), eventRow("6", 6), eventRow("5", 5)];
    const { conn, calls } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { events: Event } });
    const page = await client.events.cursor({
      limit: 2,
      orderBy: [{ at: "desc" }, { id: "desc" }],
    });
    expect(calls[0]?.sql).toBe(
      "SELECT * FROM event ORDER BY at DESC, id DESC LIMIT $p0;",
    );
    const row = page.data[0] as { at: Date };
    expect(row.at.toISOString()).toBe("2026-08-01T10:00:00.123Z");
    const cursor = page.pagination.nextCursor as { at: DateTime; id: RecordId };
    expect(cursor.at).toBeInstanceOf(DateTime);
    expect(cursor.at.toISOString()).toBe("2026-08-01T10:00:00.123000006Z");
  });
});

describe("cursor — app-form coercion (bare strings / Date / record lists)", () => {
  const Ref = defineTable("ref", { name: s.string() });
  const Trip = defineTable("trip", {
    at: s.datetime(),
    driver: s.recordId(Ref),
    stops: s.array(s.recordId(Ref)),
    seats: s.int(),
  });
  const tripMeta = buildSchemaIndex({ trips: Trip, refs: Ref }).tables.get(
    "trips",
  ) as TableMeta;

  const compile = (args: Record<string, unknown>) => {
    const binds = createBinds();
    const plan = compileCursor(tripMeta, args, binds);
    return { ...plan, vars: binds.vars };
  };

  test("a datetime cursor accepts Date, DateTime and ISO strings; garbage throws", () => {
    const tuple = (value: unknown) => ({
      limit: 5,
      orderBy: [{ at: "asc" }, { id: "asc" }],
      after: { at: value, id: "t1" },
    });
    expect(
      compile(tuple(new Date("2024-01-01T00:00:00Z"))).vars.c0,
    ).toBeInstanceOf(DateTime);
    expect(
      compile(tuple(new DateTime("2024-01-01T00:00:00Z"))).vars.c0,
    ).toBeInstanceOf(DateTime);
    expect(String(compile(tuple("2024-01-01T00:00:00Z")).vars.c0)).toBe(
      "2024-01-01T00:00:00.000Z",
    );
    expect(codeOf(() => compile(tuple("not-a-date")))).toBe("ValidationError");
    // A non-date, non-string value on a date column passes through (the server validates).
    expect(compile(tuple(5)).vars.c0).toBe(5);
  });

  test("record cursors accept bare ids, RecordId and record lists", () => {
    const byBare = compile({
      limit: 5,
      orderBy: [{ driver: "asc" }, { id: "asc" }],
      after: { driver: "r1", id: "t1" },
    });
    expect(String(byBare.vars.c0)).toBe("ref:r1");
    const byRid = compile({
      limit: 5,
      orderBy: [{ driver: "asc" }, { id: "asc" }],
      after: { driver: new RecordId("ref", "r1"), id: "t1" },
    });
    expect(String(byRid.vars.c0)).toBe("ref:r1");
    // An array-of-record column (family "array" + record meta) takes the bare element.
    const byList = compile({
      limit: 5,
      orderBy: [{ stops: "asc" }, { id: "asc" }],
      after: { stops: "r2", id: "t1" },
    });
    expect(String(byList.vars.c0)).toBe("ref:r2");
  });

  test("an undefined value, a schemaless meta and an unknown column pass through", () => {
    const undef = compile({
      limit: 5,
      orderBy: [{ at: "asc" }, { id: "asc" }],
      after: { at: undefined, id: "t1" },
    });
    expect(undef.vars.c0).toBeUndefined();

    const sm = buildSchemaIndex({ audit: "audit_log" }).schemaless.get("audit");
    if (!sm) throw new Error("missing schemaless meta");
    const binds = createBinds();
    compileCursor(sm, { limit: 5, after: "a1" }, binds);
    expect(binds.vars.c0).toBe("a1");

    // An order field that isn't a known column skips the coercion (defensive path).
    const unknown = compile({
      limit: 5,
      orderBy: [{ nope: "asc" }, { id: "asc" }],
      after: { nope: 1, id: "t1" },
    });
    expect(unknown.vars.c0).toBe(1);
  });

  test("a schemaless cursor passes raw RecordId values through the decode path", async () => {
    const rows = [
      { id: new RecordId("audit_log", "a2"), kind: "x" },
      { id: new RecordId("audit_log", "a1"), kind: "y" },
    ];
    const { conn } = fakeConn((sql) => lines(sql).map(() => ok(rows)));
    const client = betterSchemic(conn, { schema: { audit: "audit_log" } });
    const page = await client.audit.cursor({ limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.pagination.nextCursor).toBeInstanceOf(RecordId);
  });
});
