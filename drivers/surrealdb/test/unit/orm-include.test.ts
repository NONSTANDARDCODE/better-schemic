// M3 — the include compiler (golden args -> exact `{ sql, vars }`), the relational `where`
// lowering, and the hydration decoder (links/graph/`_count`) against a recording fake connection.
// Offline: no server.
import { describe, expect, test } from "bun:test";
import { DateTime, RecordId } from "surrealdb";
import { defineRelation, defineTable, s, surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { compileRead, type ReadArgs } from "../../src/orm/compiler/select";
import { createBinds } from "../../src/orm/compiler/shared";
import type { BetterSchemicError } from "../../src/orm/errors";
import { buildSchemaIndex } from "../../src/orm/schema";
import { fakeConn, lines, ok } from "../orm-fixtures";

const UserBase = defineTable("user", {
  name: s.string(),
  age: s.int(),
  at: s.datetime(),
  home: s.object({ city: s.string(), line: s.string() }).optional(),
});
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
  friends: s
    .recordId(() => UserBase)
    .array()
    .optional(),
});
const Post = defineTable("post", {
  title: s.string(),
  published: s.boolean(),
  author: s.recordId(User),
});
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);
const schema = { users: User, posts: Post, likes: Likes };
const index = buildSchemaIndex(schema);

/** Compile a read and capture its statement text + binds. */
function compile(args: ReadArgs, table = "users") {
  const meta = index.tables.get(table);
  if (!meta) throw new Error(`no table ${table}`);
  const binds = createBinds();
  const read = compileRead(meta, args, binds, "findMany", { index });
  return {
    sql: read.sql,
    vars: binds.vars,
    spec: read.projection,
    fetch: read.fetch,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}

describe("include — links", () => {
  test("true is FETCH (last clause), nested paths and multiple links", () => {
    expect(compile({ include: { mentor: true }, limit: 2 })).toEqual({
      sql: "SELECT * FROM user LIMIT $p0 FETCH mentor",
      vars: { p0: 2 },
      spec: expect.objectContaining({ includes: expect.any(Array) }),
      fetch: ["mentor"],
    });
    expect(
      compile({ include: { mentor: { include: { mentor: true } } } }).sql,
    ).toBe("SELECT * FROM user FETCH mentor.mentor");
    expect(compile({ include: { mentor: true, friends: true } }).sql).toBe(
      "SELECT * FROM user FETCH mentor, friends",
    );
  });

  test("a projected link flattens into `<link>_<path>` aliases (no FETCH)", () => {
    expect(
      compile({ include: { mentor: { select: { id: true, name: true } } } })
        .sql,
    ).toBe(
      "SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_name FROM user",
    );
    expect(
      compile({
        include: { mentor: { select: { id: true, who: "name" } } },
      }).sql,
    ).toBe(
      "SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_who FROM user",
    );
    expect(
      compile({ include: { mentor: { select: { "*": true } } } }).sql,
    ).toBe("SELECT * FROM user FETCH mentor");
  });

  test("an explicit select keeps its projection and the FETCH link is added", () => {
    expect(
      compile({
        select: { id: true },
        include: { mentor: true },
      }).sql,
    ).toBe("SELECT id, mentor FROM user FETCH mentor");
    expect(
      compile({
        select: { id: true, name: true },
        include: { mentor: true },
      }).sql,
    ).toBe("SELECT id, name, mentor FROM user FETCH mentor");
  });

  test("link guards", () => {
    expect(codeOf(() => compile({ include: { nope: true } }))).toBe(
      "UnknownField",
    );
    expect(
      codeOf(() =>
        compile({
          include: {
            mentor: { select: { id: true }, include: { mentor: true } },
          },
        }),
      ),
    ).toBe("ClauseNotSupported");
    expect(
      codeOf(() =>
        compile({
          include: { mentor: true },
          value: true,
          select: { name: true },
        }),
      ),
    ).toBe("ClauseNotSupported");
    expect(codeOf(() => compile({ include: { id: true } }))).toBe(
      "ValidationError",
    );
    // An empty nested include used to emit no FETCH and silently return the raw record id.
    expect(
      codeOf(() => compile({ include: { mentor: { include: {} } } })),
    ).toBe("ValidationError");
  });

  test("nested select objects/aliases flatten and remount at the right path", async () => {
    expect(
      compile({ include: { mentor: { select: { home: { city: true } } } } })
        .sql,
    ).toBe(
      "SELECT *, mentor.home.city AS mentor_home_city, mentor.id AS mentor_id FROM user",
    );
    expect(
      compile({ include: { mentor: { select: { home: { label: "line" } } } } })
        .sql,
    ).toBe(
      "SELECT *, mentor.home.line AS mentor_home_label, mentor.id AS mentor_id FROM user",
    );
    const { conn } = fakeConn(() => [
      ok([
        fullUser("b1", {
          mentor_id: new RecordId("user", "a1"),
          mentor_home_city: "BR",
        }),
      ]),
    ]);
    const rows = await betterSchemic(conn, { schema }).users.findMany({
      include: { mentor: { select: { home: { city: true } } } },
    });
    expect(rows[0]?.mentor).toEqual({ home: { city: "BR" } });
  });
});

describe("include — graph edges", () => {
  test("target records come from a correlated subquery", () => {
    expect(compile({ include: { likes: true } }).sql).toBe(
      "SELECT *, (SELECT * FROM ->likes->post) AS likes FROM user",
    );
    expect(
      compile({ include: { likes: { select: { id: true, title: true } } } })
        .sql,
    ).toBe(
      "SELECT *, (SELECT id, title FROM ->likes->post) AS likes FROM user",
    );
  });

  test("where splits into edge and target filters", () => {
    expect(
      compile({
        include: { likes: { where: { score: { gt: 4 }, published: true } } },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->(likes WHERE score > $p0)->post WHERE published = $p1) AS likes FROM user",
    );
    expect(
      compile({
        include: {
          likes: { where: { OR: [{ published: true }, { title: "x" }] } },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->likes->post WHERE (published = $p0 OR title = $p1)) AS likes FROM user",
    );
  });

  test("orderBy/limit/start ride the subquery (order idiom must be projected)", () => {
    expect(
      compile({
        include: {
          likes: {
            select: { id: true, title: true },
            orderBy: [{ title: "desc" }],
            limit: 2,
            start: 1,
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT id, title FROM ->likes->post ORDER BY title DESC LIMIT $p0 START $p1) AS likes FROM user",
    );
    expect(
      codeOf(() =>
        compile({
          include: {
            likes: { select: { id: true }, orderBy: [{ title: "asc" }] },
          },
        }),
      ),
    ).toBe("ValidationError");
  });

  test("edge records (`edge: true`) and the `{ edge, target }` remount", () => {
    expect(compile({ include: { likes: { edge: true } } }).sql).toBe(
      "SELECT *, (SELECT * FROM ->likes) AS likes FROM user",
    );
    expect(
      compile({
        include: {
          likes: {
            edge: { select: { score: true } },
            target: { select: { id: true, title: true } },
            where: { score: { gt: 4 }, published: false },
            orderBy: [{ score: "desc" }],
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT score, out.* FROM ->(likes WHERE score > $p0) WHERE out.published = $p1 ORDER BY score DESC) AS likes FROM user",
    );
  });

  test("incoming direction flips both arrows and materializes `in.*`", () => {
    expect(compile({ include: { likes: true } }, "posts").sql).toBe(
      "SELECT *, (SELECT * FROM <-likes<-user) AS likes FROM post",
    );
    expect(
      compile(
        { include: { likes: { select: { id: true, name: true } } } },
        "posts",
      ).sql,
    ).toBe("SELECT *, (SELECT id, name FROM <-likes<-user) AS likes FROM post");
    expect(
      compile(
        {
          include: {
            likes: {
              edge: { select: { score: true } },
              target: { select: { id: true, name: true } },
            },
          },
        },
        "posts",
      ).sql,
    ).toBe("SELECT *, (SELECT score, in.* FROM <-likes) AS likes FROM post");
  });

  test("direction both: edge records and target records are allowed; edge+target is rejected", () => {
    expect(
      compile({ include: { likes: { direction: "both", edge: true } } }).sql,
    ).toBe("SELECT *, (SELECT * FROM <->likes) AS likes FROM user");
    expect(
      compile({
        include: { likes: { direction: "both", select: { id: true } } },
      }).sql,
    ).toBe("SELECT *, (SELECT id FROM <->likes<->post) AS likes FROM user");
    const err = codeOf(() =>
      compile({
        include: { likes: { direction: "both", edge: true, target: true } },
      }),
    );
    expect(err).toBe("ClauseNotSupported");
  });

  test("an edge-only include rejects a target-owned filter (it used to drop it silently)", () => {
    expect(
      codeOf(() =>
        compile({
          include: { likes: { edge: true, where: { published: true } } },
        }),
      ),
    ).toBe("ValidationError");
    expect(
      compile({
        include: { likes: { edge: true, where: { score: { gt: 4 } } } },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->(likes WHERE score > $p0)) AS likes FROM user",
    );
    // The wildcard edge row IS the edge — the filter applies to it (never silently dropped).
    expect(
      compile({
        include: {
          rel: { wildcard: true, edge: true, where: { score: { gt: 4 } } },
        },
      }).sql,
    ).toBe(
      "SELECT *, (SELECT * FROM ->(? WHERE score > $p0)) AS rel FROM user",
    );
  });

  test("wildcards traverse any edge (`->?` for outgoing, target via `out.*`)", () => {
    expect(
      compile({ include: { rel: { wildcard: true, edge: true } } }).sql,
    ).toBe("SELECT *, (SELECT * FROM ->?) AS rel FROM user");
    expect(
      compile({ include: { rel: { wildcard: true, target: true } } }).sql,
    ).toBe("SELECT *, (SELECT out.* FROM ->?) AS rel FROM user");
  });
});

describe("include — _count", () => {
  test("edges and array links lower to correlated counts", () => {
    expect(
      compile({
        include: { _count: { select: { likes: true, friends: true } } },
      }).sql,
    ).toBe(
      "SELECT *, count(->likes->post) AS _count_likes, count(friends) AS _count_friends FROM user",
    );
  });

  test("filters split edge/target (and array elements)", () => {
    expect(
      compile({
        include: {
          _count: {
            select: { likes: { where: { score: { gt: 4 }, published: true } } },
          },
        },
      }).sql,
    ).toBe(
      "SELECT *, count(->(likes WHERE score > $p0)->(post WHERE published = $p1)) AS _count_likes FROM user",
    );
    expect(
      compile({
        include: {
          _count: { select: { friends: { where: { age: { gt: 18 } } } } },
        },
      }).sql,
    ).toBe(
      "SELECT *, count(friends[WHERE age > $p0]) AS _count_friends FROM user",
    );
  });

  test("single links and unknown keys are rejected", () => {
    expect(
      codeOf(() =>
        compile({ include: { _count: { select: { mentor: true } } } }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        compile({ include: { _count: { select: { nope: true } } } }),
      ),
    ).toBe("UnknownField");
    // `direction` is edge-only; unknown options never pass silently.
    expect(
      codeOf(() =>
        compile({
          include: { _count: { select: { friends: { direction: "in" } } } },
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        compile({ include: { _count: { select: { likes: { nope: true } } } } }),
      ),
    ).toBe("ValidationError");
  });
});

describe("relational where — lowering", () => {
  test("is/isNot prefix the target filter; isNot negates the group", () => {
    expect(compile({ where: { mentor: { is: { name: "Alice" } } } }).sql).toBe(
      "SELECT * FROM user WHERE mentor.name = $p0",
    );
    expect(
      compile({
        where: { mentor: { is: { name: "Alice", age: { gte: 18 } } } },
      }).sql,
    ).toBe("SELECT * FROM user WHERE mentor.name = $p0 AND mentor.age >= $p1");
    expect(
      compile({ where: { mentor: { isNot: { name: "Alice" } } } }).sql,
    ).toBe("SELECT * FROM user WHERE NOT (mentor.name = $p0)");
  });

  test("edges: some/none count, every compares counts; direction override", () => {
    expect(
      compile({ where: { likes: { some: { published: true } } } }).sql,
    ).toBe(
      "SELECT * FROM user WHERE count(->likes->(post WHERE published = $p0)) > 0",
    );
    expect(
      compile({ where: { likes: { none: { published: true } } } }).sql,
    ).toBe(
      "SELECT * FROM user WHERE count(->likes->(post WHERE published = $p0)) = 0",
    );
    expect(
      compile({ where: { likes: { every: { published: true } } } }).sql,
    ).toBe(
      "SELECT * FROM user WHERE count(->likes->post) = count(->likes->(post WHERE published = $p0))",
    );
    expect(
      compile({ where: { likes: { some: { score: { gt: 4 } } } } }).sql,
    ).toBe(
      "SELECT * FROM user WHERE count(->(likes WHERE score > $p0)->post) > 0",
    );
    expect(
      compile(
        { where: { likes: { some: { name: "Alice" }, direction: "in" } } },
        "posts",
      ).sql,
    ).toBe(
      "SELECT * FROM post WHERE count(<-likes<-(user WHERE name = $p0)) > 0",
    );
  });

  test("array links: some/every/none over `count(field[WHERE …])`", () => {
    expect(
      compile({ where: { friends: { some: { age: { gt: 18 } } } } }).sql,
    ).toBe("SELECT * FROM user WHERE count(friends[WHERE age > $p0]) > 0");
    expect(
      compile({ where: { friends: { every: { age: { gt: 18 } } } } }).sql,
    ).toBe(
      "SELECT * FROM user WHERE count(friends) = count(friends[WHERE age > $p0])",
    );
  });

  test("relation guards: wrong operator, mixed logical owners", () => {
    const err = (() => {
      try {
        compile({ where: { mentor: { some: { name: "Alice" } } } });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(err?.code).toBe("ValidationError");
    expect(err?.message).toContain("is");

    const mixed = (() => {
      try {
        compile({
          where: {
            likes: { some: { OR: [{ score: 4 }, { published: true }] } },
          },
        });
        return undefined;
      } catch (e) {
        return e as BetterSchemicError;
      }
    })();
    expect(mixed?.code).toBe("ValidationError");
    expect(mixed?.message).toContain("mixes edge and target");
  });
});

describe("relational where — write batches", () => {
  test("updateMany/deleteMany lower the same relational filters as reads", async () => {
    const update = fakeConn(() => [ok([])]);
    await betterSchemic(update.conn, { schema }).users.updateMany({
      where: { likes: { some: { published: true } } },
      data: { name: "Renamed" },
    });
    expect(update.calls[0]?.sql).toContain(
      "UPDATE user MERGE $p1 WHERE count(->likes->(post WHERE published = $p0)) > 0",
    );

    const remove = fakeConn(() => [ok([])]);
    await betterSchemic(remove.conn, { schema }).users.deleteMany({
      where: { mentor: { is: { name: "Alice" } } },
    });
    expect(remove.calls[0]?.sql).toBe(
      "DELETE FROM user WHERE mentor.name = $p0 RETURN BEFORE;",
    );
  });
});

describe("M3.5 — traversal/recursion via select fragments", () => {
  test("recursion and traversal sugar compile as projection expressions", () => {
    expect(
      compile({
        select: {
          name: true,
          descendants: surql`@.{1..10}->parent_of->person`.as<unknown[]>(),
          likedCount: surql`count(->likes)`.as<number>(),
        },
      }).sql,
    ).toBe(
      "SELECT name, (@.{1..10}->parent_of->person) AS descendants, (count(->likes)) AS likedCount FROM user",
    );
  });
});

// --- hydration -----------------------------------------------------------------------------------

const fullUser = (id: string, over: Record<string, unknown> = {}) => ({
  id: new RecordId("user", id),
  name: "Alice",
  age: 30,
  at: new DateTime(new Date("2025-01-02T03:04:05Z")),
  ...over,
});

describe("include — hydration", () => {
  test("FETCH decodes the link with the TARGET codec (nested too)", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([
        fullUser("b1", {
          name: "Bob",
          mentor: fullUser("a1", { name: "Ann" }),
          friends: [fullUser("a1", { name: "Ann" })],
        }),
      ]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.users.findMany({
      include: { mentor: true, friends: true },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM user FETCH mentor, friends;");
    expect(rows[0]?.mentor?.name).toBe("Ann");
    expect(rows[0]?.mentor?.at).toBeInstanceOf(Date);
    expect(rows[0]?.friends?.[0]?.name).toBe("Ann");
  });

  test("a fetched nested link hydrates recursively (missing -> null)", async () => {
    const { conn } = fakeConn(() => [
      ok([
        fullUser("c1", {
          name: "Carol",
          mentor: fullUser("b1", {
            name: "Bob",
            mentor: fullUser("a1", { name: "Ann" }),
          }),
        }),
      ]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.users.findMany({
      include: { mentor: { include: { mentor: true } } },
    });
    expect(rows[0]?.mentor?.mentor?.name).toBe("Ann");

    const { conn: conn2 } = fakeConn(() => [
      ok([fullUser("c2", { name: "C" })]),
    ]);
    const client2 = betterSchemic(conn2, { schema });
    const nulled = await client2.users.findMany({
      include: { mentor: { include: { mentor: true } } },
    });
    expect(nulled[0]?.mentor).toBeNull();
  });

  test("a projected link remounts from the flat columns", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([
        {
          id: new RecordId("user", "b1"),
          name: "Bob",
          age: 20,
          at: new DateTime(new Date("2025-01-01T00:00:00Z")),
          mentor_id: new RecordId("user", "a1"),
          mentor_name: "Ann",
          mentor_who: "Ann",
        },
      ]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.users.findMany({
      include: { mentor: { select: { id: true, name: true, who: "name" } } },
    });
    expect(calls[0]?.sql).toBe(
      "SELECT *, mentor.id AS mentor_id, mentor.name AS mentor_name, mentor.name AS mentor_who FROM user;",
    );
    expect(rows[0]?.mentor).toEqual({
      id: new RecordId("user", "a1"),
      name: "Ann",
      who: "Ann",
    });
  });

  test("a projected link without `id` still detects absence and decodes to null", async () => {
    expect(
      compile({ include: { mentor: { select: { name: true } } } }).sql,
    ).toBe(
      "SELECT *, mentor.name AS mentor_name, mentor.id AS mentor_id FROM user",
    );
    const { conn } = fakeConn(() => [
      ok([fullUser("x1", { mentor_name: undefined, mentor_id: undefined })]),
    ]);
    const rows = await betterSchemic(conn, { schema }).users.findMany({
      include: { mentor: { select: { name: true } } },
    });
    expect(rows[0]?.mentor).toBeNull();

    const present = fakeConn(() => [
      ok([
        fullUser("x1", {
          mentor_name: "Ann",
          mentor_id: new RecordId("user", "a1"),
        }),
      ]),
    ]);
    const found = await betterSchemic(present.conn, { schema }).users.findMany({
      include: { mentor: { select: { name: true } } },
    });
    expect(found[0]?.mentor).toEqual({ name: "Ann" });
  });

  test("graph targets decode with the target codec; edge+target remounts `{ edge, target }`", async () => {
    const target = {
      id: new RecordId("post", "p1"),
      title: "Hello",
      published: true,
      author: new RecordId("user", "a1"),
    };
    const { conn } = fakeConn((sql) =>
      sql.includes("out.*")
        ? [
            ok([
              fullUser("a1", {
                name: "Ann",
                likes: [{ score: 5, out: target }],
              }),
            ]),
          ]
        : [ok([fullUser("a1", { name: "Ann", likes: [target] })])],
    );
    const client = betterSchemic(conn, { schema });

    const rows = await client.users.findMany({ include: { likes: true } });
    expect(rows[0]?.likes?.[0]?.id).toEqual(new RecordId("post", "p1"));

    const both = await client.users.findMany({
      include: {
        likes: {
          edge: { select: { score: true } },
          target: { select: { id: true, title: true } },
        },
      },
    });
    expect(both[0]?.likes?.[0]).toEqual({
      edge: { score: 5 },
      target: { id: new RecordId("post", "p1"), title: "Hello" },
    });
  });

  test("_count remounts as one `_count` object", async () => {
    const { conn, calls } = fakeConn(() => [
      ok([fullUser("a1", { _count_likes: 3, _count_friends: 2 })]),
    ]);
    const client = betterSchemic(conn, { schema });
    const rows = await client.users.findMany({
      include: { _count: { select: { likes: true, friends: true } } },
    });
    expect(calls[0]?.sql).toBe(
      "SELECT *, count(->likes->post) AS _count_likes, count(friends) AS _count_friends FROM user;",
    );
    expect(rows[0]?._count).toEqual({ likes: 3, friends: 2 });
  });

  test("explain:true EXPLAINs the include statement (never executes)", async () => {
    const { conn, calls } = fakeConn((sql) => [
      ok(sql.startsWith("EXPLAIN") ? "plan" : []),
    ]);
    const client = betterSchemic(conn, { schema });
    const plan = await client.users.findMany({
      include: { likes: { where: { published: true } } },
      explain: true,
    });
    expect(plan.statements[0]?.surql).toContain("(SELECT * FROM ->likes->post");
    expect(plan.statements[0]?.surql).toContain("WHERE published = $p0");
    expect(calls[0]?.sql.startsWith("EXPLAIN SELECT")).toBe(true);
  });

  test("include rides findUnique (FROM ONLY + FETCH) and paginate", async () => {
    const { conn, calls } = fakeConn(() => [ok(fullUser("u1"))]);
    const client = betterSchemic(conn, { schema });
    const one = await client.users.findUnique({
      where: { id: "user:u1" },
      include: { mentor: true },
    });
    expect(calls[0]?.sql).toBe("SELECT * FROM ONLY user:u1 FETCH mentor;");
    expect(one?.id).toEqual(new RecordId("user", "u1"));

    const { conn: conn2, calls: calls2 } = fakeConn((sql) =>
      lines(sql).map((line) =>
        line.includes("count()") ? ok([{ count: 1 }]) : ok([fullUser("u2")]),
      ),
    );
    const paged = betterSchemic(conn2, { schema }).users.paginate({
      include: { mentor: true },
      limit: 1,
    });
    await paged;
    expect(calls2[0]?.sql).toContain("FETCH mentor;");
    expect(calls2[0]?.sql).toContain("\nSELECT count()");
  });
});
