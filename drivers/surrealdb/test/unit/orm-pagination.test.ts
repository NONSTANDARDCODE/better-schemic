// M1.6 — pagination: `paginate` (offset + count in one round-trip) and `cursor` (keyset probe).
// Golden SQL, envelope math and the teaching guards. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileCursor,
  compilePaginate,
} from "../../src/orm/compiler/pagination";
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
const index = buildSchemaIndex({ users: User });
const meta = index.tables.get("users") as TableMeta;

const fullUser = (id: string, over: Record<string, unknown> = {}) => ({
  id: new RecordId("user", id),
  name: `u${id}`,
  age: 20,
  active: true,
  tags: [],
  ...over,
});

function compilePaginateArgs(args: Record<string, unknown>) {
  const binds = createBinds();
  const plan = compilePaginate(meta, args, binds);
  return { ...plan, vars: binds.vars };
}

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

describe("paginate — compilation", () => {
  test("data + count in two statements, binds shared", () => {
    const plan = compilePaginateArgs({
      where: { active: true },
      limit: 10,
      start: 20,
    });
    expect(plan.dataSql).toBe(
      "SELECT * FROM user WHERE active = $p0 LIMIT $p1 START $p2",
    );
    expect(plan.countSql).toBe(
      "SELECT count() FROM user WHERE active = $p3 GROUP ALL",
    );
    expect(plan.vars).toEqual({ p0: true, p1: 10, p2: 20, p3: true });
    expect(plan.probe).toBe(false);
  });

  test("count:false probes LIMIT n+1 and skips the count statement", () => {
    const plan = compilePaginateArgs({ limit: 10, count: false });
    expect(plan.dataSql).toBe("SELECT * FROM user LIMIT $p0");
    expect(plan.countSql).toBeUndefined();
    expect(plan.probe).toBe(true);
    expect(plan.vars).toEqual({ p0: 11 });
  });

  test("groupBy counts GROUPS via a subquery", () => {
    const plan = compilePaginateArgs({
      select: { active: true },
      groupBy: ["active"],
      limit: 5,
    });
    expect(plan.dataSql).toBe(
      "SELECT active FROM user GROUP BY active LIMIT $p0",
    );
    expect(plan.countSql).toBe(
      "SELECT count() FROM (SELECT active FROM user GROUP BY active) GROUP ALL",
    );
  });

  test("split counts the unfolded rows via a subquery", () => {
    const plan = compilePaginateArgs({
      select: { tags: true },
      split: "tags",
      limit: 5,
    });
    expect(plan.countSql).toBe(
      "SELECT count() FROM (SELECT tags FROM user SPLIT tags) GROUP ALL",
    );
  });

  test("bad limits fail fast", () => {
    expect(codeOf(() => compilePaginateArgs({ limit: 0 }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compilePaginateArgs({ limit: 1.5 }))).toBe(
      "ValidationError",
    );
    expect(codeOf(() => compilePaginateArgs({ limit: 1, start: -1 }))).toBe(
      "ValidationError",
    );
  });

  test("range targets the record range in BOTH statements", () => {
    const plan = compilePaginateArgs({
      range: { start: "user:1", end: "user:9", inclusive: true },
      limit: 3,
    });
    expect(plan.dataSql).toBe("SELECT * FROM user:1..=9 LIMIT $p0");
    expect(plan.countSql).toBe("SELECT count() FROM user:1..=9 GROUP ALL");
  });

  test("groupBy + where keeps the filter in the count subquery", () => {
    const plan = compilePaginateArgs({
      select: { active: true },
      where: { age: { gte: 18 } },
      groupBy: ["active"],
      limit: 5,
    });
    expect(plan.dataSql).toBe(
      "SELECT active FROM user WHERE age >= $p0 GROUP BY active LIMIT $p1",
    );
    expect(plan.countSql).toBe(
      "SELECT count() FROM (SELECT active FROM user WHERE age >= $p2 GROUP BY active) GROUP ALL",
    );
  });
});

describe("paginate — delegate envelope", () => {
  const rows = [fullUser("1"), fullUser("2"), fullUser("3")];

  test("count:true computes total/pageCount/hasNext/hasPrevious", async () => {
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 25 }]) : ok(rows),
      ),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.paginate({
      where: { active: true },
      limit: 10,
      start: 20,
    });
    expect(calls).toHaveLength(1); // ONE round-trip for both statements
    expect(page.data).toHaveLength(3);
    expect(page.pagination).toEqual({
      type: "offset",
      page: 3,
      perPage: 10,
      total: 25,
      pageCount: 3,
      hasNext: true,
      hasPrevious: true,
    });
  });

  test("count:false probes n+1 and omits total/pageCount", async () => {
    const { conn, calls } = fakeConn((sql) =>
      lines(sql).map(() => ok([...rows, fullUser("4")])),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.paginate({ limit: 3, count: false });
    expect(calls[0]?.vars).toEqual({ p0: 4 }); // LIMIT n+1
    expect(page.data).toHaveLength(3);
    expect(page.pagination).toEqual({
      type: "offset",
      page: 1,
      perPage: 3,
      hasNext: true,
      hasPrevious: false,
    });
    expect("total" in page.pagination).toBe(false);
  });

  test("a short page has no next", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 2 }]) : ok(rows.slice(0, 2)),
      ),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.paginate({ limit: 10, start: 0 });
    expect(page.pagination.hasNext).toBe(false);
    expect(page.pagination.hasPrevious).toBe(false);
  });

  test("page is floor(start/limit)+1 (unaligned starts stay on page 1)", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 25 }]) : ok([fullUser("1")]),
      ),
    );
    const client = betterSchemic(conn, { schema: { users: User } });
    const page = await client.users.paginate({ limit: 10, start: 5 });
    expect(page.pagination.page).toBe(1);
    expect(page.pagination.hasPrevious).toBe(true);
  });
});

describe("cursor — compilation", () => {
  test("default order is id ASC; the probe is LIMIT n+1", () => {
    const plan = compileCursorArgs({ limit: 10 });
    expect(plan.sql).toBe("SELECT * FROM user ORDER BY id ASC LIMIT $p0");
    expect(plan.vars).toEqual({ p0: 11 });
    expect(plan.backward).toBe(false);
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

  test("a cursor field missing from select is a teaching error", async () => {
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

  test("cursor with select decodes the rows and builds the tuple cursor", async () => {
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
