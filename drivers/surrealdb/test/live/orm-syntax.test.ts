// M0.1 — ORM syntax map probes: every SurrealQL construct the `/orm` compiler will emit, verified
// against a REAL SurrealDB (the local `surreal` binary, ephemeral in-memory server), not inferred.
// This is the executable half of `docs/orm-syntax-map.md`: each test encodes the live-observed
// behaviour, so a server upgrade that changes any of it fails loudly here first.
//
// Skipped automatically when no `surreal` binary is available (like the e2e suite).
import { setDefaultTimeout } from "bun:test";

// The workspace gate runs every package's suite IN PARALLEL — live connects/DDL can be slow.
setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal, Uuid } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";

/** Normalize SDK values (RecordId/Uuid/Date/arrays/objects) to plain JSON-comparable values. */
const plain = (v: unknown): unknown => {
  if (v instanceof RecordId || v instanceof Uuid) return String(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        plain(x),
      ]),
    );
  }
  return v;
};

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-syntax] `surreal` binary unavailable — skipping");

const NS = "orm_syntax";
const DB = "map";

live("ORM syntax map — live probes (server 3.x)", () => {
  let server: EphemeralServer;
  let db: Surreal;

  /** Run a statement script and return the per-statement result array (SDK-faithful). */
  const run = <T extends unknown[] = unknown[]>(
    sql: string,
    vars?: Record<string, unknown>,
  ) => db.query<T>(sql, vars);

  /**
   * Run and return the LAST statement's value (SDK values normalized to plain JSON).
   * `any` on purpose: these probes assert arbitrary shapes, and bun:test's `expect`
   * resolves `unknown` to a `Matchers<undefined>`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary probe shapes vs. bun:test's expect typing.
  type AnyResult = any;

  const last = async (
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<AnyResult> => {
    const out = await run<unknown[]>(sql, vars);
    return plain(out[out.length - 1]);
  };

  /** Await a query, capturing the thrown error instead of failing the test (SDK throws on
   *  AlreadyExists/Cancelled responses during response collection — `.rejects` doesn't catch it). */
  const caught = async (p: Promise<unknown>): Promise<unknown> => {
    try {
      await p;
      return null;
    } catch (e) {
      return e;
    }
  };

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: NS, database: DB });

    await db.query(`
      DEFINE TABLE user SCHEMAFULL;
      DEFINE FIELD name ON user TYPE string;
      DEFINE FIELD age ON user TYPE int;
      DEFINE FIELD active ON user TYPE bool DEFAULT true;
      DEFINE FIELD tags ON user TYPE option<array<string>>;
      DEFINE FIELD mentor ON user TYPE option<record<user>>;
      DEFINE FIELD friends ON user TYPE option<array<record<user>>>;
      DEFINE TABLE post SCHEMAFULL;
      DEFINE FIELD title ON post TYPE string;
      DEFINE FIELD author ON post TYPE record<user>;
      DEFINE FIELD tags ON post TYPE option<array<string>>;
      DEFINE FIELD published ON post TYPE bool DEFAULT false;
      DEFINE TABLE likes TYPE RELATION IN user OUT post;
      DEFINE FIELD score ON likes TYPE int;

      CREATE user:alice CONTENT { name: "Alice", age: 30 };
      CREATE user:bob CONTENT { name: "Bob", age: 25, mentor: user:alice, friends: [user:alice] };
      CREATE user:carol CONTENT { name: "Carol", age: 35 };
      CREATE post:p1 CONTENT { title: "Hello", author: user:alice, tags: ["db", "graph"], published: true };
      CREATE post:p2 CONTENT { title: "World", author: user:bob, tags: ["db"], published: false };
      RELATE user:alice->likes->post:p1 SET score = 5;
      RELATE user:bob->likes->post:p1 SET score = 3;
    `);
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  describe("UPDATE — semantics and modes", () => {
    test("UPDATE t:id on a missing record returns [] and does NOT create", async () => {
      const out = await last("UPDATE user:ghost MERGE { name: 'G', age: 1 };");
      expect(out).toEqual([]);
      // `FROM ONLY <missing>` yields `undefined` through the SDK (JSON null on the wire).
      expect(await last("SELECT * FROM ONLY user:ghost;")).toBeFalsy();
    });

    test("CREATE t:id duplicate errors; CREATE ONLY/EQ return shapes", async () => {
      expect(
        await last("CREATE user:gone CONTENT { name: 'X', age: 1 };"),
      ).toEqual([expect.objectContaining({ id: "user:gone" })]);
      const dup = await caught(
        last("CREATE user:gone CONTENT { name: 'Y', age: 2 };"),
      );
      expect(String(dup)).toMatch(/already exists/);
      expect(
        await last("CREATE ONLY user:only1 CONTENT { name: 'Z', age: 3 };"),
      ).toEqual(expect.objectContaining({ id: "user:only1", name: "Z" }));
    });

    test("CREATE ONLY as an expression captures the created record (LET)", async () => {
      const created = await last(
        "LET $c = (CREATE ONLY user CONTENT { name: 'L', age: 4 }); RETURN $c;",
      );
      expect(created).toEqual(
        expect.objectContaining({ name: "L", age: 4, active: true }),
      );
    });

    test("modes: MERGE / SET / PATCH / UNSET; CONTENT drops DB defaults", async () => {
      await run(
        "CREATE ONLY user:m1 CONTENT { name: 'M', age: 10, tags: ['a','b'] };",
      );
      expect(await last("UPDATE user:m1 MERGE { age: 11 };")).toEqual([
        expect.objectContaining({ age: 11, name: "M" }),
      ]);
      expect(await last("UPDATE user:m1 SET age = 12;")).toEqual([
        expect.objectContaining({ age: 12, name: "M" }),
      ]);
      expect(
        await last(
          'UPDATE user:m1 PATCH [{ op: "add", path: "/tags/-", value: "c" }];',
        ),
      ).toEqual([expect.objectContaining({ tags: ["a", "b", "c"] })]);
      // CONTENT replaces the whole record — the DB-side default is NOT re-applied.
      await expect(
        last("UPDATE user:m1 CONTENT { name: 'M2', age: 13 };"),
      ).rejects.toThrow(/active/);
      // UNSET only works on optional fields.
      expect(await last("UPDATE user:m1 UNSET tags;")).toEqual([
        expect.objectContaining({ name: "M" }),
      ]);
      await expect(last("UPDATE user:m1 UNSET age;")).rejects.toThrow();
    });

    test("UPDATE ONLY t:id returns an object, not an array", async () => {
      const out = await last("UPDATE ONLY user:m1 SET name = 'M3';");
      expect(out).toEqual(expect.objectContaining({ name: "M3" }));
      expect(Array.isArray(out)).toBe(false);
    });

    test("RETURN modes: NONE / BEFORE / AFTER / DIFF", async () => {
      expect(await last("UPDATE user:m1 SET age = 20 RETURN NONE;")).toEqual(
        [],
      );
      expect(await last("UPDATE user:m1 SET age = 21 RETURN BEFORE;")).toEqual([
        expect.objectContaining({ age: 20 }),
      ]);
      expect(await last("UPDATE user:m1 SET age = 22 RETURN AFTER;")).toEqual([
        expect.objectContaining({ age: 22 }),
      ]);
      expect(await last("UPDATE user:m1 SET age = 23 RETURN DIFF;")).toEqual([
        [expect.objectContaining({ op: "replace", path: "/age", value: 23 })],
      ]);
    });

    test("UPDATE t MERGE ... WHERE cond: empty when no match, never creates", async () => {
      const out = await last(
        "UPDATE user MERGE { age: 1 } WHERE id = user:nope;",
      );
      expect(out).toEqual([]);
      expect(await last("SELECT * FROM ONLY user:nope;")).toBeFalsy();
    });

    test("TIMEOUT is accepted on UPDATE", async () => {
      expect(await last("UPDATE user:m1 SET age = 24 TIMEOUT 5s;")).toEqual([
        expect.objectContaining({ age: 24 }),
      ]);
    });
  });

  describe("INSERT — arrays, IGNORE, ON DUPLICATE KEY UPDATE", () => {
    test("INSERT INTO t $rows inserts and returns rows; duplicate errors", async () => {
      const out = await last(
        "INSERT INTO user [{ id: user:i1, name: 'I1', age: 1 }, { id: user:i2, name: 'I2', age: 2 }];",
      );
      expect(out).toEqual([
        expect.objectContaining({ id: "user:i1" }),
        expect.objectContaining({ id: "user:i2" }),
      ]);
      await expect(
        last("INSERT INTO user [{ id: user:i1, name: 'X', age: 9 }];"),
      ).rejects.toThrow(/already exists/);
    });

    test("INSERT IGNORE skips existing ids and returns only the inserted rows", async () => {
      const out = await last(
        "INSERT IGNORE INTO user [{ id: user:i1, name: 'X', age: 9 }, { id: user:i3, name: 'I3', age: 3 }];",
      );
      expect(out).toEqual([expect.objectContaining({ id: "user:i3" })]);
    });

    test("ON DUPLICATE KEY UPDATE: $input is the inserted record (nested paths too)", async () => {
      const out = await last(
        "INSERT INTO user [{ id: user:i1, name: 'U', age: 10 }] ON DUPLICATE KEY UPDATE name = $input.name, age = $input.age;",
      );
      expect(out).toEqual([
        expect.objectContaining({ id: "user:i1", name: "U", age: 10 }),
      ]);
    });

    test("ON DUPLICATE KEY UPDATE: bare field refs and $before/$after are NONE", async () => {
      // The existing record's fields are NOT addressable bare inside ON DUPLICATE — arithmetic
      // against prior state needs a correlated subquery by id.
      await expect(
        last(
          "INSERT INTO user [{ id: user:i1, name: 'V', age: 11 }] ON DUPLICATE KEY UPDATE age = age + 1;",
        ),
      ).rejects.toThrow(/addition/);
      await expect(
        last(
          "INSERT INTO user [{ id: user:i1, name: 'V', age: 11 }] ON DUPLICATE KEY UPDATE age = $before.age;",
        ),
      ).rejects.toThrow();
      const out = await last(
        "INSERT INTO user [{ id: user:i1, name: 'V', age: 11 }] ON DUPLICATE KEY UPDATE age = (SELECT VALUE age FROM ONLY user:i1) + 1;",
      );
      // Prior age was 10 (set by the $input test) -> 11 after the correlated subquery increment.
      expect(out).toEqual([expect.objectContaining({ age: 11 })]);
    });

    test("INSERT RELATION INTO edge works for edges", async () => {
      expect(
        await last(
          "INSERT RELATION INTO likes { id: likes:ir1, in: user:alice, out: post:p2, score: 7 };",
        ),
      ).toEqual([expect.objectContaining({ id: "likes:ir1", score: 7 })]);
    });
  });

  describe("UPSERT", () => {
    test("UPSERT t:id MERGE creates when missing and merges when present", async () => {
      expect(
        await last("UPSERT user:up1 MERGE { name: 'UP', age: 1 };"),
      ).toEqual([expect.objectContaining({ id: "user:up1" })]);
      expect(await last("UPSERT user:up1 MERGE { age: 2 };")).toEqual([
        expect.objectContaining({ age: 2, name: "UP" }),
      ]);
    });

    test("UPSERT t MERGE ... WHERE cond creates when nothing matches", async () => {
      const out = await last(
        "UPSERT user MERGE { name: 'Ghosty', age: 1 } WHERE name = 'Ghosty';",
      );
      expect(out).toEqual([expect.objectContaining({ name: "Ghosty" })]);
    });

    test("UPSERT ... SET partial-updates an existing record; a partial create fails schema", async () => {
      await run("CREATE ONLY user:set1 CONTENT { name: 'S', age: 5 };");
      // On an EXISTING record, SET behaves like a partial update (absent fields are kept).
      const updated = await last("UPSERT user:set1 SET age = 6;");
      expect(updated).toEqual([expect.objectContaining({ name: "S", age: 6 })]);
      // On a MISSING record, SET creates from the payload — required fields must be present.
      expect(await last("UPSERT user:set2 SET name = 'S2', age = 7;")).toEqual([
        expect.objectContaining({ name: "S2" }),
      ]);
      await expect(last("UPSERT user:set3 SET age = 8;")).rejects.toThrow(
        /name/,
      );
    });
  });

  describe("DELETE", () => {
    test("DELETE t:id RETURN BEFORE removes and returns; RETURN NONE empty", async () => {
      expect(await last("DELETE user:i3 RETURN BEFORE;")).toEqual([
        expect.objectContaining({ id: "user:i3" }),
      ]);
      expect(await last("DELETE user:i2 RETURN NONE;")).toEqual([]);
      expect(await last("DELETE user:nope;")).toEqual([]);
    });

    test("DELETE FROM t WHERE cond removes matching rows", async () => {
      const out = await last(
        "DELETE FROM user WHERE name = 'Ghosty' RETURN BEFORE;",
      );
      expect(out).toEqual([expect.objectContaining({ name: "Ghosty" })]);
    });
  });

  describe("SELECT — projections, clauses, FETCH", () => {
    test("aliases and nested paths project; unknown paths yield nulls", async () => {
      expect(
        await last(
          "SELECT id, title, author.name AS author_name FROM post ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ author_name: "Alice" }),
        expect.objectContaining({ author_name: "Bob" }),
      ]);
    });

    test("SELECT * OMIT drops fields (even explicitly selected ones)", async () => {
      const out = (await last(
        "SELECT id, title OMIT title FROM post;",
      )) as Record<string, unknown>[];
      expect(out[0]).not.toHaveProperty("title");
    });

    test("FETCH runs AFTER ORDER BY/LIMIT and materializes links (nested too)", async () => {
      const posts = (await last(
        "SELECT * FROM post ORDER BY id FETCH author;",
      )) as Record<string, unknown>[];
      expect(posts[0]?.author).toEqual(
        expect.objectContaining({ name: "Alice" }),
      );
      const bob = await last("SELECT * FROM ONLY user:bob FETCH mentor;");
      expect(bob).toEqual(
        expect.objectContaining({
          mentor: expect.objectContaining({ name: "Alice" }),
        }),
      );
      // FETCH before ORDER BY is a parse error — clause order matters.
      await expect(
        last("SELECT * FROM post FETCH author ORDER BY id;"),
      ).rejects.toThrow(/Parse error/);
    });

    test("link projection without FETCH flattens: author.id AS author_id", async () => {
      expect(
        await last("SELECT id, author.id AS author_id FROM post ORDER BY id;"),
      ).toEqual([
        expect.objectContaining({ author_id: "user:alice" }),
        expect.objectContaining({ author_id: "user:bob" }),
      ]);
    });

    test("only: FROM ONLY t:id returns an object; missing returns a falsy result", async () => {
      expect(await last("SELECT * FROM ONLY user:alice;")).toEqual(
        expect.objectContaining({ name: "Alice" }),
      );
      expect(await last("SELECT * FROM ONLY user:missing;")).toBeFalsy();
    });

    test("SPLIT works; SPLIT + GROUP BY is mutually exclusive", async () => {
      const rows = (await last(
        "SELECT id, tags FROM post SPLIT tags ORDER BY tags;",
      )) as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(1);
      await expect(
        last("SELECT tags, count() AS c FROM post SPLIT tags GROUP BY tags;"),
      ).rejects.toThrow(/mutually exclusive/);
    });

    test("GROUP BY / GROUP ALL, math::*, array::group/distinct, count subquery", async () => {
      expect(
        await last(
          "SELECT author, count() AS c FROM post GROUP BY author ORDER BY author;",
        ),
      ).toEqual([
        expect.objectContaining({ c: 1 }),
        expect.objectContaining({ c: 1 }),
      ]);
      expect(
        await last("SELECT math::sum(age) AS total FROM user GROUP ALL;"),
      ).toEqual([expect.objectContaining({ total: expect.any(Number) })]);
      expect(
        await last(
          "SELECT array::group(author) AS authors, array::distinct(tags) AS tagset FROM post GROUP ALL;",
        ),
      ).toEqual([expect.objectContaining({ authors: expect.any(Array) })]);
      expect(
        await last(
          "SELECT count() FROM (SELECT author FROM post GROUP BY author) GROUP ALL;",
        ),
      ).toEqual([expect.objectContaining({ count: 2 })]);
    });

    test("LIMIT n START m pagination; SELECT VALUE; count/exists probes", async () => {
      expect(
        await last("SELECT name FROM user ORDER BY name LIMIT 1 START 1;"),
      ).toEqual([expect.objectContaining({ name: expect.any(String) })]);
      expect(await last("SELECT VALUE name FROM user ORDER BY name;")).toEqual(
        expect.any(Array),
      );
      expect(await last("SELECT count() FROM user GROUP ALL;")).toEqual([
        expect.objectContaining({ count: expect.any(Number) }),
      ]);
      expect(await last("SELECT VALUE id FROM user LIMIT 1;")).toEqual(
        expect.any(Array),
      );
    });

    test("record ranges: t:start..end and t:start..=end", async () => {
      await run(
        "DEFINE TABLE r SCHEMALESS; CREATE r:1; CREATE r:2; CREATE r:3; CREATE r:4;",
      );
      expect(await last("SELECT VALUE id FROM r:2..4;")).toEqual([
        "r:2",
        "r:3",
      ]);
      expect(await last("SELECT VALUE id FROM r:2..=4;")).toEqual([
        "r:2",
        "r:3",
        "r:4",
      ]);
      // The prototype's `FROM users:1..users:100` is a parse error in 3.x.
      await expect(last("SELECT * FROM r:2..r:4;")).rejects.toThrow(
        /Parse error/,
      );
    });

    test("WITH [NO]INDEX, TIMEOUT, ORDER BY alias/expression", async () => {
      await run("DEFINE INDEX idx_user_name ON user FIELDS name;");
      expect(
        await last(
          "SELECT * FROM user WITH INDEX idx_user_name WHERE name = 'Alice';",
        ),
      ).toEqual([expect.objectContaining({ name: "Alice" })]);
      expect(await last("SELECT * FROM user WITH NOINDEX;")).toEqual(
        expect.any(Array),
      );
      expect(await last("SELECT * FROM user TIMEOUT 5s;")).toEqual(
        expect.any(Array),
      );
      const ordered = (await last(
        "SELECT id, (age * 2) AS double FROM user ORDER BY double DESC;",
      )) as { double: number }[];
      const doubles = ordered.map((r) => r.double);
      expect(doubles.length).toBeGreaterThan(0);
      expect(doubles).toEqual([...doubles].sort((a, b) => b - a));
    });

    test("PARALLEL is NOT a valid clause in 3.2", async () => {
      await expect(last("SELECT * FROM user PARALLEL;")).rejects.toThrow(
        /Parse error/,
      );
    });

    test("EXPLAIN works on SELECT only", async () => {
      expect(
        await last("EXPLAIN SELECT * FROM post WHERE published = true;"),
      ).toEqual(expect.any(String));
      await expect(
        last("EXPLAIN UPDATE user:alice SET age = 1;"),
      ).rejects.toThrow(/EXPLAIN is only supported/);
    });

    test("VERSION needs a versioned backend (memory server rejects it)", async () => {
      await run("DEFINE TABLE cf CHANGEFEED 1h; CREATE cf:a SET n = 1;");
      await expect(
        last("SELECT * FROM cf VERSION d'2000-01-01T00:00:00Z';"),
      ).rejects.toThrow(/versioned/);
    });
  });

  describe("WHERE operators", () => {
    test("set operators: CONTAINS family", async () => {
      const out = await last(
        `SELECT id FROM post
         WHERE tags CONTAINS 'db'
           AND tags CONTAINSANY ['db', 'x']
           AND tags CONTAINSALL ['db']
           AND tags CONTAINSNOT 'x'
           AND tags CONTAINSNONE ['x']
         ORDER BY id;`,
      );
      expect(out).toEqual([
        expect.objectContaining({ id: "post:p1" }),
        expect.objectContaining({ id: "post:p2" }),
      ]);
    });

    test("INSIDE is SCALAR membership; ALLINSIDE is subset; ANY/NONEINSIDE are set ops", async () => {
      const cases: [string, unknown][] = [
        ["'db' INSIDE ['db', 'graph']", true],
        ["['db'] INSIDE ['db', 'graph']", false],
        ["['db'] ALLINSIDE ['db', 'graph']", true],
        ["['db', 'x'] ALLINSIDE ['db', 'graph']", false],
        ["['db'] ANYINSIDE ['db', 'graph']", true],
        ["['x'] NONEINSIDE ['db', 'graph']", true],
        ["['db'] NONEINSIDE ['db', 'graph']", false],
        ["['x'] OUTSIDE ['db']", true],
      ];
      for (const [expr, expected] of cases) {
        expect(await last(`RETURN ${expr};`)).toBe(expected);
      }
    });

    test("?= is any-equals, *= is all-equals", async () => {
      expect(await last("RETURN ['db','graph'] ?= 'db';")).toBe(true);
      expect(await last("RETURN ['db','graph'] *= 'db';")).toBe(false);
      expect(await last("RETURN ['db'] *= 'db';")).toBe(true);
      // `*=` is vacuously true on an empty array (documented in the map §4.3).
      expect(await last("RETURN [] *= 'db';")).toBe(true);
    });

    test("fuzzy operators ~ / ?~ / *~ are NOT valid in 3.x", async () => {
      await expect(
        last("SELECT id FROM post WHERE title ~ 'hello';"),
      ).rejects.toThrow(/Parse error/);
      // Fuzzy matching is available via functions instead.
      expect(
        await last("RETURN string::similarity::jaro('hello', 'hallo');"),
      ).toBeGreaterThan(0.8);
      expect(await last("RETURN string::matches('hello', /hel/);")).toBe(true);
    });

    test("array paths: contacts[*].f returns an array — equality needs INSIDE/CONTAINS", async () => {
      await run(
        `DEFINE FIELD contacts ON user TYPE option<array<object>>;
         DEFINE FIELD contacts[*].type ON user TYPE string;
         DEFINE FIELD contacts[*].value ON user TYPE string;
         UPDATE user:alice MERGE { contacts: [{ type: 'email', value: 'a@x' }] };`,
      );
      expect(await last("RETURN user:alice.contacts[*].type;")).toEqual([
        "email",
      ]);
      expect(await last("RETURN user:alice.contacts[0].type;")).toBe("email");
      // Path equality with a scalar is FALSE (array vs scalar) …
      expect(
        await last("SELECT id FROM user WHERE contacts[*].type = 'email';"),
      ).toEqual([]);
      // … membership is the correct lowering.
      expect(
        await last(
          "SELECT id FROM user WHERE contacts[*].type CONTAINS 'email';",
        ),
      ).toEqual([expect.objectContaining({ id: "user:alice" })]);
    });

    test("correlated subqueries via $parent", async () => {
      expect(
        await last(
          "SELECT id, (SELECT VALUE title FROM post WHERE author = $parent.id) AS posts FROM user WHERE id = user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({ posts: expect.arrayContaining(["Hello"]) }),
      ]);
    });

    test("tuple cursor predicate parses and filters", async () => {
      const rows = await last(
        "SELECT id, age FROM user WHERE (age < $c0 OR (age = $c0 AND id > $c1)) ORDER BY age DESC, id ASC LIMIT 5;",
        { c0: 30, c1: "user:alice" },
      );
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  describe("graph traversal", () => {
    test("projection directions: ->edge, <-edge, <->edge (parenthesized), <->?", async () => {
      expect(await last("SELECT ->likes AS out_e FROM user:alice;")).toEqual([
        expect.objectContaining({ out_e: expect.any(Array) }),
      ]);
      expect(await last("SELECT <-likes AS in_e FROM post:p1;")).toEqual([
        expect.objectContaining({ in_e: expect.any(Array) }),
      ]);
      expect(await last("SELECT (<->likes) AS both FROM user:alice;")).toEqual([
        expect.objectContaining({ both: expect.any(Array) }),
      ]);
      // Record-anchored both-direction traversal works; bare table anchors do not.
      expect(await last("RETURN user:alice<->likes<->post;")).toEqual(
        expect.any(Array),
      );
    });

    test("target/edge filters: ->(edge WHERE) ->(node WHERE)", async () => {
      // Alice has a like to the unpublished post:p2 (INSERT RELATION, earlier test) -> she matches;
      // Bob only likes the published post:p1 -> he does not.
      const unpublished = (await last(
        "SELECT VALUE id FROM user WHERE count(->likes->(post WHERE published = false)) > 0;",
      )) as string[];
      expect(unpublished).toContain("user:alice");
      expect(unpublished).not.toContain("user:bob");
      expect(
        await last(
          "SELECT VALUE id FROM user WHERE count(->(likes WHERE score > 4)->post) > 0;",
        ),
      ).toEqual(["user:alice"]);
    });

    test("per-parent filtered include: edge filter inside the subquery", async () => {
      const out = (await last(
        "SELECT id, name, (SELECT id, title FROM ->(likes WHERE score > 4)->post ORDER BY title LIMIT 2) AS liked FROM user ORDER BY id;",
      )) as Record<string, unknown>[];
      const alice = out.find((u) => u.id === "user:alice");
      expect(alice).toEqual(
        expect.objectContaining({
          liked: expect.arrayContaining([
            expect.objectContaining({ id: "post:p1" }),
          ]),
        }),
      );
    });

    test("count(->edge[WHERE ...]) and edge+target combined subquery", async () => {
      expect(
        await last(
          "SELECT id, count(->likes) AS n FROM user WHERE id = user:alice;",
        ),
      ).toEqual([expect.objectContaining({ n: expect.any(Number) })]);
      const out = (await last(
        "SELECT id, (SELECT id, out.* FROM ->likes) AS likes FROM user WHERE id = user:alice;",
      )) as Record<string, unknown>[];
      expect(out[0]?.likes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            out: expect.objectContaining({ id: "post:p1" }),
          }),
        ]),
      );
    });

    test("recursion returns record ids only; projection must happen outside the body", async () => {
      expect(
        await last(
          "SELECT name, @.{1..2}->likes->post AS posts FROM user:alice;",
        ),
      ).toEqual([expect.objectContaining({ posts: expect.any(Array) })]);
      expect(
        await last(
          "SELECT name, user:alice.{1..2}(->likes->post) AS posts FROM user:alice;",
        ),
      ).toEqual([expect.objectContaining({ posts: expect.any(Array) })]);
      await expect(
        last("SELECT @.{1..2}->likes->post.title FROM user:alice;"),
      ).rejects.toThrow(
        /Expected a record ID during recursive graph traversal/,
      );
    });
  });

  describe("relations & graph lowering (M3)", () => {
    test("FETCH: multiple/nested links, alias preserved; an unselected link is NOT returned", async () => {
      expect(
        await last("SELECT * FROM user:bob FETCH mentor, friends;"),
      ).toEqual([
        expect.objectContaining({
          mentor: expect.objectContaining({ name: "Alice" }),
          friends: [expect.objectContaining({ name: "Alice" })],
        }),
      ]);
      expect(await last("SELECT * FROM user:bob FETCH mentor.mentor;")).toEqual(
        [
          expect.objectContaining({
            mentor: expect.objectContaining({ name: "Alice" }),
          }),
        ],
      );
      // A projected alias wins over FETCH (FETCH is applied last but doesn't overwrite).
      expect(
        await last(
          "SELECT id, author.id AS author_id FROM post ORDER BY id FETCH author;",
        ),
      ).toEqual([
        { author_id: "user:alice", id: "post:p1" },
        { author_id: "user:bob", id: "post:p2" },
      ]);
      // FETCH materializes a link only when it is part of the selection.
      expect(
        await last("SELECT id FROM post ORDER BY id FETCH author;"),
      ).toEqual([{ id: "post:p1" }, { id: "post:p2" }]);
      expect(
        await last("SELECT id, author FROM post ORDER BY id FETCH author;"),
      ).toEqual([
        expect.objectContaining({
          author: expect.objectContaining({ name: "Alice" }),
        }),
        expect.objectContaining({
          author: expect.objectContaining({ name: "Bob" }),
        }),
      ]);
    });

    test("incoming edges: the target follows the SAME direction (<-edge<-target); <-edge->target is empty", async () => {
      expect(await last("SELECT <-likes<-user AS users FROM post:p1;")).toEqual(
        [
          expect.objectContaining({
            users: expect.arrayContaining(["user:alice", "user:bob"]),
          }),
        ],
      );
      // Mixing directions mid-chain is NOT relative to the edge — it means out-of-edge.
      expect(await last("SELECT <-likes->user AS users FROM post:p1;")).toEqual(
        [{ users: [] }],
      );
      expect(
        await last(
          "SELECT (SELECT id, name FROM <-(likes WHERE score > 4)<-user) AS likers FROM post:p1;",
        ),
      ).toEqual([
        expect.objectContaining({
          likers: [expect.objectContaining({ name: "Alice" })],
        }),
      ]);
    });

    test("per-parent target subquery: projection, edge/target filters, order/limit/start", async () => {
      expect(
        await last(
          "SELECT (SELECT * FROM ->likes->post) AS liked FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          liked: expect.arrayContaining([
            expect.objectContaining({ id: "post:p1" }),
            expect.objectContaining({ id: "post:p2" }),
          ]),
        }),
      ]);
      expect(
        await last(
          "SELECT (SELECT id, title FROM ->(likes WHERE score > 4)->(post WHERE published = true) ORDER BY title DESC LIMIT 1 START 0) AS liked FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          liked: [{ id: "post:p1", title: "Hello" }],
        }),
      ]);
      // ORDER BY needs the idiom in the selection unless the projection is `*`.
      await expect(
        last(
          "SELECT (SELECT id FROM ->likes->post ORDER BY title DESC) AS liked FROM user:alice;",
        ),
      ).rejects.toThrow(/Missing order idiom/);
      expect(
        await last(
          "SELECT (SELECT * FROM ->likes->post ORDER BY title DESC) AS liked FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          liked: expect.arrayContaining([
            expect.objectContaining({ title: "Hello" }),
          ]),
        }),
      ]);
    });

    test("edge records and edge+target: `out`/`in` materialize the target nested", async () => {
      expect(
        await last("SELECT (SELECT * FROM ->likes) AS likes FROM user:alice;"),
      ).toEqual([
        expect.objectContaining({
          likes: expect.arrayContaining([
            expect.objectContaining({ score: 5, out: "post:p1" }),
          ]),
        }),
      ]);
      expect(
        await last(
          "SELECT (SELECT score, out.* FROM ->likes) AS likes FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          likes: expect.arrayContaining([
            expect.objectContaining({
              score: expect.any(Number),
              out: expect.objectContaining({ title: expect.any(String) }),
            }),
          ]),
        }),
      ]);
      // Incoming edges materialize the other endpoint under `in`.
      expect(
        await last(
          "SELECT (SELECT score, in.* FROM <-likes) AS likes FROM post:p1;",
        ),
      ).toEqual([
        expect.objectContaining({
          likes: expect.arrayContaining([
            expect.objectContaining({
              in: expect.objectContaining({ name: expect.any(String) }),
            }),
          ]),
        }),
      ]);
      // DIVERGE: `out.*` next to a target-parenthesized traversal returns EMPTY objects — filters
      // on the target must go through `WHERE out.<field>` instead.
      expect(
        await last(
          "SELECT (SELECT score, out.* FROM ->likes->(post WHERE published = true)) AS likes FROM user:alice;",
        ),
      ).toEqual([{ likes: [{}] }]);
      expect(
        await last(
          "SELECT (SELECT score, out.* FROM ->(likes WHERE score > 4) WHERE out.published = true) AS likes FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          likes: [
            expect.objectContaining({
              out: expect.objectContaining({ id: "post:p1" }),
            }),
          ],
        }),
      ]);
    });

    test("wildcards: ->? / <-? / <->? return edge records", async () => {
      expect(
        await last("SELECT (SELECT * FROM ->?) AS rel FROM user:alice;"),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([
            expect.objectContaining({ score: expect.any(Number) }),
          ]),
        }),
      ]);
      expect(
        await last("SELECT (SELECT * FROM <-?) AS rel FROM post:p1;"),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([
            expect.objectContaining({ out: "post:p1" }),
          ]),
        }),
      ]);
      expect(
        await last("SELECT (SELECT * FROM <->?) AS rel FROM user:alice;"),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([
            expect.objectContaining({ score: expect.any(Number) }),
          ]),
        }),
      ]);
      // A wildcard edge accepts a filter on the edge row (`->(? WHERE …)`)…
      expect(
        await last(
          "SELECT (SELECT * FROM ->(? WHERE score > 4)) AS rel FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([expect.objectContaining({ score: 5 })]),
        }),
      ]);
      // …and a bracket filter on `?` filters the edge array too (the compiler emits the paren form).
      expect(
        await last(
          "SELECT (SELECT * FROM ->?[WHERE score > 4]) AS rel FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([expect.objectContaining({ score: 5 })]),
        }),
      ]);
    });

    test("direction both: the target follows the SAME direction; `?.*` is a parse error", async () => {
      expect(
        await last(
          "SELECT (SELECT id, title FROM <->likes<->post ORDER BY id) AS rel FROM user:alice;",
        ),
      ).toEqual([
        expect.objectContaining({
          rel: [
            { id: "post:p1", title: "Hello" },
            { id: "post:p2", title: "World" },
          ],
        }),
      ]);
      expect(
        await last("SELECT (SELECT * FROM <->likes) AS rel FROM user:alice;"),
      ).toEqual([
        expect.objectContaining({
          rel: expect.arrayContaining([
            expect.objectContaining({ score: expect.any(Number) }),
          ]),
        }),
      ]);
      // There is no single target alias with direction `both` — `?.*` is NOT a thing.
      await expect(
        last(
          "SELECT (SELECT score, ?.* FROM <->likes) AS rel FROM user:alice;",
        ),
      ).rejects.toThrow(/Parse error/);
    });

    test("_count lowering: edges (bracket/target), both directions, record arrays, NONE arrays", async () => {
      expect(
        await last(
          "SELECT id, count(->likes) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ id: "user:alice", n: 2 }),
        expect.objectContaining({ id: "user:bob", n: 1 }),
        expect.objectContaining({ id: "user:carol", n: 0 }),
      ]);
      expect(
        await last(
          "SELECT id, count(->likes[WHERE score = 5]) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ id: "user:alice", n: 1 }),
        expect.objectContaining({ id: "user:bob", n: 0 }),
        expect.objectContaining({ id: "user:carol", n: 0 }),
      ]);
      expect(
        await last(
          "SELECT id, count(->likes->(post WHERE published = false)) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ id: "user:alice", n: 1 }),
        expect.objectContaining({ id: "user:bob", n: 0 }),
        expect.objectContaining({ id: "user:carol", n: 0 }),
      ]);
      // Record arrays count with `count(field)` — NONE-safe (unlike `array::len`).
      expect(
        await last(
          "SELECT id, count(friends) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ id: "user:alice", n: 0 }),
        expect.objectContaining({ id: "user:bob", n: 1 }),
        expect.objectContaining({ id: "user:carol", n: 0 }),
      ]);
      await expect(
        last(
          "SELECT id, array::len(friends) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).rejects.toThrow(/Expected `array` but found `NONE`/);
      expect(
        await last(
          "SELECT id, count(friends[WHERE name = 'Alice']) AS n FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] ORDER BY id;",
        ),
      ).toEqual([
        expect.objectContaining({ id: "user:alice", n: 0 }),
        expect.objectContaining({ id: "user:bob", n: 1 }),
        expect.objectContaining({ id: "user:carol", n: 0 }),
      ]);
      expect(
        await last("SELECT id, count(<-likes) AS n FROM post ORDER BY id;"),
      ).toEqual([
        expect.objectContaining({ id: "post:p1", n: 2 }),
        expect.objectContaining({ id: "post:p2", n: 1 }),
      ]);
    });

    test("relational WHERE: is/isNot (NONE in negation), some/none, every via count-equality", async () => {
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND mentor.name = 'Alice';",
        ),
      ).toEqual([{ name: "Bob" }]);
      // Negation is true for a missing link (NONE) and for a different value.
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND mentor.name != 'Alice' ORDER BY name;",
        ),
      ).toEqual([{ name: "Alice" }, { name: "Carol" }]);
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(->likes->(post WHERE published = true)) > 0 ORDER BY name;",
        ),
      ).toEqual([{ name: "Alice" }, { name: "Bob" }]);
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(->likes->(post WHERE published = true)) = 0 ORDER BY name;",
        ),
      ).toEqual([{ name: "Carol" }]);
      // `every` as an equality of counts — vacuously true for zero relations, NONE-safe.
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(->likes) = count(->likes->(post WHERE published = true)) ORDER BY name;",
        ),
      ).toEqual([{ name: "Bob" }, { name: "Carol" }]);
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(friends[WHERE name = 'Alice']) > 0;",
        ),
      ).toEqual([{ name: "Bob" }]);
      // `NOT` inside a traversal filter needs parentheses.
      await expect(
        last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(->likes->(post WHERE NOT published = true)) = 0;",
        ),
      ).rejects.toThrow(/Parse error/);
      expect(
        await last(
          "SELECT name FROM user WHERE name IN ['Alice', 'Bob', 'Carol'] AND count(->likes->(post WHERE NOT (published = true))) = 0 ORDER BY name;",
        ),
      ).toEqual([{ name: "Bob" }, { name: "Carol" }]);
    });
  });

  describe("full-text and vector search", () => {
    test("FULLTEXT index (3.x spelling) + @@ / @n@ / score / highlight", async () => {
      await run(
        "DEFINE ANALYZER ascii TOKENIZERS blank,class FILTERS lowercase,ascii;",
      );
      // 2.x's `SEARCH ANALYZER` is a parse error in 3.x — the clause is FULLTEXT.
      await expect(
        last("DEFINE INDEX bad ON post FIELDS title SEARCH ANALYZER ascii;"),
      ).rejects.toThrow(/Parse error/);
      await run(
        "DEFINE INDEX idx_ft ON post FIELDS title FULLTEXT ANALYZER ascii BM25 HIGHLIGHTS;",
      );
      expect(await last("SELECT id FROM post WHERE title @@ 'hello';")).toEqual(
        [expect.objectContaining({ id: "post:p1" })],
      );
      expect(
        await last(
          "SELECT id, search::score(0) AS score FROM post WHERE title @0@ 'hello';",
        ),
      ).toEqual([expect.objectContaining({ score: expect.any(Number) })]);
      expect(
        await last(
          `SELECT search::highlight('<b>', '</b>', 0, title) AS hl FROM post WHERE title @@ 'hello';`,
        ),
      ).toEqual([expect.objectContaining({ hl: "<b>Hello</b>" })]);
      expect(
        await last(
          "SELECT id, search::score(0) AS score FROM post WHERE title @@ 'hello' ORDER BY score DESC;",
        ),
      ).toEqual([expect.objectContaining({ id: "post:p1" })]);
    });

    test("KNN: HNSW index, <|k,metric|>, distance/similarity functions", async () => {
      await run(`
        DEFINE TABLE vec SCHEMALESS;
        DEFINE FIELD embedding ON vec TYPE array<float>;
        DEFINE INDEX idx_vec ON vec FIELDS embedding HNSW DIMENSION 3 DIST COSINE;
        CREATE vec:v1 SET embedding = [1.0, 0.0, 0.0];
        CREATE vec:v2 SET embedding = [0.9, 0.1, 0.0];
        CREATE vec:v3 SET embedding = [0.0, 1.0, 0.0];
      `);
      const hits = await last(
        "SELECT id, vector::distance::knn() AS dist FROM vec WHERE embedding <|3, COSINE|> $q;",
        { q: [1.0, 0.0, 0.0] },
      );
      expect(hits).toEqual([
        expect.objectContaining({ id: "vec:v1", dist: 0 }),
        expect.objectContaining({ id: "vec:v2" }),
        expect.objectContaining({ id: "vec:v3" }),
      ]);
      expect(
        await last(
          "SELECT id, vector::similarity::cosine(embedding, $q) AS sim FROM vec WHERE id = vec:v1;",
          { q: [1.0, 0.0, 0.0] },
        ),
      ).toEqual([expect.objectContaining({ sim: 1 })]);
    });
  });

  describe("batches, upsert-by-unique, transactions", () => {
    test("FOR loop = updateEach lowering", async () => {
      const out = await last(
        `FOR $row IN [{ by: user:alice, fields: { age: 31 } }, { by: user:bob, fields: { age: 26 } }] {
           UPDATE user MERGE $row.fields WHERE id = $row.by;
         };
         SELECT id, age FROM user WHERE id IN [user:alice, user:bob] ORDER BY id;`,
      );
      expect(out).toEqual([
        expect.objectContaining({ id: "user:alice", age: 31 }),
        expect.objectContaining({ id: "user:bob", age: 26 }),
      ]);
    });

    test("upsert-by-unique lowering: LET + IF/ELSE", async () => {
      const out = await last(
        `LET $e = (SELECT VALUE id FROM user WHERE name = 'Zed' LIMIT 1);
         IF array::len($e) = 0 THEN CREATE user CONTENT { name: 'Zed', age: 1 }
         ELSE UPDATE $e[0] MERGE { age: 2 } END;
         SELECT id, name, age FROM user WHERE name = 'Zed';`,
      );
      expect(out).toEqual([expect.objectContaining({ name: "Zed", age: 1 })]);
    });

    test("SQL transactions: BEGIN/COMMIT applies, CANCEL discards", async () => {
      await run(
        "BEGIN TRANSACTION; CREATE user:tx1 CONTENT { name: 'TX', age: 1 }; COMMIT TRANSACTION;",
      );
      expect(await last("SELECT id FROM ONLY user:tx1;")).toEqual(
        expect.objectContaining({ id: "user:tx1" }),
      );
      // CANCEL makes the SDK throw during response collection — the cancellation surfaces as an
      // error, and the transaction's writes are discarded.
      const cancelled = await caught(
        run(
          "BEGIN TRANSACTION; CREATE user:tx2 CONTENT { name: 'TX2', age: 1 }; CANCEL TRANSACTION;",
        ),
      );
      expect(String(cancelled)).toMatch(/cancelled transaction/);
      expect(await last("SELECT * FROM ONLY user:tx2;")).toBeFalsy();
    });
  });

  describe("live queries and changefeeds", () => {
    test("LIVE SELECT returns a uuid; KILL accepts a bound param", async () => {
      const uuid = (await last(
        "LIVE SELECT * FROM user WHERE active = true;",
      )) as string;
      expect(typeof uuid).toBe("string");
      await expect(last(`KILL "${uuid}";`)).rejects.toThrow(/Parse error/);
      await run("KILL $q;", { q: uuid });
    });

    test("DIFF: `LIVE SELECT DIFF FROM t` (no projection); DIFF after target is invalid", async () => {
      const uuid = await last(
        "LIVE SELECT DIFF FROM user WHERE active = true;",
      );
      expect(typeof uuid).toBe("string");
      await run("KILL $q;", { q: uuid });
      await expect(last("LIVE SELECT DIFF * FROM user;")).rejects.toThrow(
        /Parse error/,
      );
      await expect(
        last("LIVE SELECT * FROM user WHERE active = true DIFF;"),
      ).rejects.toThrow(/Parse error/);
    });

    test("SHOW CHANGES FOR TABLE / DATABASE normalizes to versionstamp + changes", async () => {
      await run(
        "DEFINE TABLE cf2 CHANGEFEED 1h; CREATE cf2:a SET n = 1; UPDATE cf2:a SET n = 2;",
      );
      const table = (await last(
        "SHOW CHANGES FOR TABLE cf2 SINCE 0 LIMIT 10;",
      )) as { versionstamp: unknown; changes: unknown[] }[];
      expect(table.length).toBeGreaterThan(0);
      expect(table[0]).toHaveProperty("versionstamp");
      expect(table[0]).toHaveProperty("changes");
      const database = await last("SHOW CHANGES FOR DATABASE SINCE 0 LIMIT 1;");
      expect(Array.isArray(database)).toBe(true);
    });
  });

  describe("read clauses — M1 compiler order and shapes", () => {
    test("FROM ONLY needs a single result: a table with 2 rows errors, LIMIT 1 unwraps", async () => {
      await expect(last("SELECT * FROM ONLY user;")).rejects.toThrow(
        /single result/,
      );
      expect(await last("SELECT * FROM ONLY user LIMIT 1;")).toEqual(
        expect.objectContaining({ id: expect.any(String) }),
      );
      // `only` + `range` is a compile-time error in the ORM; the server also can't express it.
      await expect(
        last("SELECT * FROM ONLY user:alice..=user:bob;"),
      ).rejects.toThrow(/Parse error/);
    });

    test("path projections nest by path; aliases flatten", async () => {
      await run(
        "UPDATE user:alice MERGE { contacts: [{ type: 'email', value: 'a@x' }] };",
      );
      expect(await last("SELECT contacts[*].type FROM user:alice;")).toEqual([
        { contacts: { type: ["email"] } },
      ]);
      expect(await last("SELECT contacts.type FROM user:alice;")).toEqual([
        { contacts: { type: ["email"] } },
      ]);
      expect(await last("SELECT contacts[0].value FROM user:alice;")).toEqual([
        { contacts: { value: "a@x" } },
      ]);
      expect(
        await last("SELECT contacts[*].type AS t FROM user:alice;"),
      ).toEqual([{ t: ["email"] }]);
    });

    test("clause order: WITH before WHERE, SPLIT after, VERSION before TIMEOUT", async () => {
      await run("DEFINE INDEX idx_user_age ON user FIELDS age;");
      expect(
        await last(
          "SELECT * FROM user WITH INDEX idx_user_age WHERE age > 20 SPLIT tags ORDER BY tags LIMIT 2 START 0 TIMEOUT 5s;",
        ),
      ).toEqual(expect.any(Array));
      await expect(
        last("SELECT * FROM user WHERE age > 20 WITH NOINDEX;"),
      ).rejects.toThrow(/Parse error/);
      await expect(
        last("SELECT * FROM user TIMEOUT 5s LIMIT 1;"),
      ).rejects.toThrow(/Parse error/);
      await expect(
        last("SELECT * FROM user TIMEOUT 5s VERSION d'2025-01-01T00:00:00Z';"),
      ).rejects.toThrow(/Parse error/);
    });

    test("SPLIT + GROUP ALL is mutually exclusive (not just GROUP BY)", async () => {
      await expect(
        last("SELECT tags, count() AS c FROM user SPLIT tags GROUP ALL;"),
      ).rejects.toThrow(/mutually exclusive/);
    });

    test("LIMIT/START accept binds; ORDER BY needs an alias, not a parenthesized expr", async () => {
      expect(
        await last("SELECT name FROM user ORDER BY name LIMIT $l START $s;", {
          l: 1,
          s: 1,
        }),
      ).toEqual([expect.objectContaining({ name: expect.any(String) })]);
      await expect(
        last("SELECT * FROM user ORDER BY (age + 1) DESC;"),
      ).rejects.toThrow(/Parse error/);
      expect(
        await last("SELECT (age + 1) AS bump FROM user ORDER BY bump DESC;"),
      ).toEqual(expect.any(Array));
    });

    test("count() without GROUP ALL is per-row; SELECT * with GROUP is invalid", async () => {
      const counted = (await last("SELECT count() FROM user;")) as {
        count: number;
      }[];
      expect(Array.isArray(counted)).toBe(true);
      expect(counted[0]).toEqual({ count: 1 });
      await expect(last("SELECT * FROM user GROUP ALL;")).rejects.toThrow(
        /cannot be aggregated/,
      );
      await expect(last("SELECT * FROM user GROUP BY active;")).rejects.toThrow(
        /cannot be aggregated/,
      );
    });

    test("record ranges use the id suffix (t:1..=2) and accept string ids", async () => {
      await run(
        "DEFINE TABLE rng SCHEMALESS; CREATE rng:1; CREATE rng:2; CREATE rng:3; CREATE rng:abc; CREATE rng:xyz;",
      );
      expect(await last("SELECT VALUE id FROM rng:1..=2;")).toEqual([
        "rng:1",
        "rng:2",
      ]);
      expect(await last("SELECT VALUE id FROM rng:abc..=xyz;")).toEqual([
        "rng:abc",
        "rng:xyz",
      ]);
      expect(await last("SELECT VALUE id FROM rng:1..3;")).toEqual([
        "rng:1",
        "rng:2",
      ]);
    });

    test("OMIT drops a required field without failing the projection", async () => {
      expect(await last("SELECT * OMIT age FROM user:alice;")).toEqual([
        expect.not.objectContaining({ age: expect.anything() }),
      ]);
      expect(await last("SELECT name, age OMIT age FROM user:alice;")).toEqual([
        { name: "Alice" },
      ]);
    });
  });

  describe("M2 — write forms the compiler emits", () => {
    test("INSERT binds an array or a single object; a STRING id is NOT coerced to a record id", async () => {
      expect(
        await last("INSERT INTO user $p;", {
          p: [
            { id: new RecordId("user", "ins-a"), name: "A", age: 2 },
            { id: new RecordId("user", "ins-b"), name: "B", age: 3 },
          ],
        }),
      ).toHaveLength(2);
      expect(
        await last("INSERT INTO user $p;", {
          p: { id: new RecordId("user", "ins-single"), name: "S", age: 1 },
        }),
      ).toEqual([expect.objectContaining({ name: "S", age: 1 })]);
      // DIVERGE: a "user:x" STRING id inserts a record whose id VALUE is the string (user:⟨user:x⟩).
      const coerced = (await last("INSERT INTO user $p;", {
        p: { id: "user:raw", name: "R", age: 9 },
      })) as { id: string }[];
      expect(String(coerced[0]?.id)).toBe("user:⟨user:raw⟩");
    });

    test("INSERT … ON DUPLICATE KEY UPDATE needs an insertable row and accepts $p.f / $input.f", async () => {
      await run("CREATE user:dup CONTENT { name: 'Old', age: 10 };");
      const partial = await caught(
        last("INSERT INTO user $p ON DUPLICATE KEY UPDATE name = $p.name;", {
          p: { id: new RecordId("user", "dup"), name: "New" },
        }),
      );
      expect(String(partial)).toMatch(/coerce value for field .age./);
      expect(
        await last(
          "INSERT INTO user $p ON DUPLICATE KEY UPDATE name = $p.name;",
          {
            p: { id: new RecordId("user", "dup"), name: "New", age: 10 },
          },
        ),
      ).toEqual([expect.objectContaining({ id: "user:dup", name: "New" })]);
      expect(
        await last(
          "INSERT INTO user $p ON DUPLICATE KEY UPDATE age = $input.age;",
          {
            p: { id: new RecordId("user", "dup"), name: "New2", age: 42 },
          },
        ),
      ).toEqual([expect.objectContaining({ id: "user:dup", age: 42 })]);
    });

    test("INSERT ON DUPLICATE RETURN BEFORE returns the PREVIOUS state; DIFF is a paged diff", async () => {
      const before = await last(
        "INSERT INTO user $p ON DUPLICATE KEY UPDATE name = $input.name RETURN BEFORE;",
        {
          p: { id: new RecordId("user", "dup"), name: "BeforeProbe", age: 42 },
        },
      );
      expect(before).toEqual([expect.objectContaining({ name: "New" })]);
      expect(await last("SELECT VALUE name FROM user:dup;")).toEqual([
        "BeforeProbe",
      ]);
      const diff = await last(
        "INSERT INTO user $p ON DUPLICATE KEY UPDATE name = $input.name RETURN DIFF;",
        { p: { id: new RecordId("user", "dup"), name: "DiffProbe", age: 42 } },
      );
      expect(diff).toEqual([
        [
          expect.objectContaining({
            op: "change",
            path: "/name",
            value: expect.any(String),
          }),
        ],
      ]);
    });

    test("UPSERT: per-field SET preserves missing fields; MERGE … WHERE creates", async () => {
      await run("CREATE user:ups CONTENT { name: 'U', age: 20, tags: ['x'] };");
      expect(await last("UPSERT user:ups SET age = $p;", { p: 21 })).toEqual([
        expect.objectContaining({ age: 21, name: "U" }),
      ]);
      // DIVERGE: "SET $obj" (whole-object bind) is a parse error — the compiler emits per-field.
      expect(
        await caught(last("UPSERT user:ups SET $p;", { p: { age: 22 } })),
      ).not.toBeNull();
      expect(
        await last("UPSERT user MERGE $p WHERE name = $v;", {
          p: { name: "UpsertCreated", age: 1 },
          v: "UpsertCreated",
        }),
      ).toEqual([
        expect.objectContaining({
          name: "UpsertCreated",
          id: expect.any(String),
        }),
      ]);
    });

    test("UPDATE … UNSET with RETURN and TIMEOUT order", async () => {
      await run(
        "CREATE ONLY user:unset2 CONTENT { name: 'U2', age: 5, tags: ['a'] };",
      );
      expect(
        await last("UPDATE user:unset2 UNSET tags RETURN BEFORE TIMEOUT 5s;"),
      ).toEqual([expect.objectContaining({ tags: ["a"] })]);
      expect(await last("SELECT * FROM user:unset2;")).toEqual([
        expect.not.objectContaining({ tags: expect.anything() }),
      ]);
    });

    test("UPDATE ONLY t:id works with and without WHERE", async () => {
      await run("CREATE user:onlyw CONTENT { name: 'OW', age: 1 };");
      expect(await last("UPDATE ONLY user:onlyw SET age = 2;")).toEqual(
        expect.objectContaining({ age: 2 }),
      );
      expect(
        await last("UPDATE ONLY user SET age = 3 WHERE name = 'OW';"),
      ).toEqual(expect.objectContaining({ age: 3 }));
    });

    test("UPDATE RETURN DIFF is a nested JSON Patch array", async () => {
      await run("CREATE user:diff1 CONTENT { name: 'D', age: 1 };");
      const diff = await last("UPDATE user:diff1 SET age = 2 RETURN DIFF;");
      expect(diff).toEqual([
        [expect.objectContaining({ op: "replace", path: "/age", value: 2 })],
      ]);
    });

    test("DELETE shapes: t:id, FROM t WHERE, whole table, RETURN BEFORE/NONE", async () => {
      await run(`
        DEFINE TABLE del SCHEMALESS;
        CREATE del:a CONTENT { v: 1 };
        CREATE del:b CONTENT { v: 2 };
      `);
      expect(await last("DELETE del:a RETURN BEFORE;")).toEqual([
        expect.objectContaining({ v: 1 }),
      ]);
      expect(await last("DELETE del:missing RETURN BEFORE;")).toEqual([]);
      expect(await last("DELETE FROM del WHERE v = 2 RETURN BEFORE;")).toEqual([
        expect.objectContaining({ v: 2 }),
      ]);
      await run("CREATE del:c CONTENT { v: 3 };");
      expect(await last("DELETE del RETURN NONE;")).toEqual([]);
      expect(await last("SELECT * FROM del;")).toEqual([]);
    });

    test("DIVERGE: FOR returns NONE — per-item statements carry updateEach results", async () => {
      await run(`
        DEFINE TABLE fe SCHEMALESS;
        CREATE fe:1 CONTENT { age: 1 };
        CREATE fe:2 CONTENT { age: 2 };
      `);
      const loop = await last(
        "FOR $__row IN $rows { UPDATE fe MERGE $__row.fields WHERE id = $__row.by; };",
        {
          rows: [
            { by: new RecordId("fe", 1), fields: { age: 11 } },
            { by: new RecordId("fe", 2), fields: { age: 22 } },
          ],
        },
      );
      expect(loop).toBeUndefined();
      const perItem = plain(
        await run(
          "UPDATE fe MERGE $f0 WHERE id = $b0 RETURN AFTER; UPDATE fe MERGE $f1 WHERE id = $b1 RETURN AFTER;",
          {
            f0: { age: 111 },
            b0: new RecordId("fe", 1),
            f1: { age: 1 },
            b1: new RecordId("fe", 999),
          },
        ),
      );
      expect(perItem).toEqual([[expect.objectContaining({ age: 111 })], []]);
    });

    test("INSERT IGNORE per row returns only the inserted rows (skipDuplicates)", async () => {
      await run(`
        DEFINE TABLE skip SCHEMALESS;
        CREATE skip:x CONTENT { v: 1 };
      `);
      const out = await last(
        "INSERT IGNORE INTO skip $p0; INSERT IGNORE INTO skip $p1;",
        {
          p0: { id: new RecordId("skip", "x"), v: 2 },
          p1: { id: new RecordId("skip", "y"), v: 3 },
        },
      );
      // Only the LAST statement's rows are read here; both ran (see the SELECTs below).
      expect(out).toEqual([expect.objectContaining({ v: 3 })]);
      expect(await last("SELECT v FROM skip:y;")).toEqual([{ v: 3 }]);
      expect(await last("SELECT v FROM skip:x;")).toEqual([{ v: 1 }]);
    });

    test("RELATE with SET data, a named edge id, and via LET $created", async () => {
      const edge = await last(
        "RELATE user:alice->likes->post:p2 SET score = $p;",
        { p: 7 },
      );
      expect(edge).toEqual([
        expect.objectContaining({ score: 7, in: "user:alice", out: "post:p2" }),
      ]);
      const named = await last(
        "RELATE user:alice->likes:named1->post:p2 SET score = 1;",
      );
      expect(named).toEqual([expect.objectContaining({ id: "likes:named1" })]);
      const created = await last(
        "LET $c = (CREATE ONLY post CONTENT { title: 'Rel', author: user:alice }); RELATE user:alice->likes->$c SET score = 2; RETURN $c;",
      );
      expect(created).toEqual(expect.objectContaining({ title: "Rel" }));
    });
  });
});
