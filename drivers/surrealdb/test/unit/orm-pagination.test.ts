// M1.6 — `paginate` (offset pages): the data + count statements compile in ONE round-trip and the
// envelope math is golden-asserted. Offline. `cursor` lives in `orm-cursor.test.ts`.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { compilePaginate } from "../../src/orm/compiler/pagination";
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

  test("page is floor(start/limit)+1 (unaligned starts stay page 1)", async () => {
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
