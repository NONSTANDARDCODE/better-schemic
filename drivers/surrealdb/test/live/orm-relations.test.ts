// M3 — relations & graph end-to-end: `include` links (FETCH/projected/nested), graph edges
// (target/edge/edge+target/wildcard/incoming), `_count` and the relational `where`
// (`is`/`isNot`/`some`/`every`/`none`). Ephemeral server; skipped without a `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineRelation, defineTable, s, surql } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-relations] `surreal` binary unavailable — skipping");

const UserBase = defineTable("rl_user", {
  name: s.string(),
  age: s.int(),
  home: s.object({ city: s.string(), line: s.string() }).optional(),
});
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
  friends: s
    .recordId(() => UserBase)
    .array()
    .optional(),
});
const Post = defineTable("rl_post", {
  title: s.string(),
  published: s.boolean(),
  author: s.recordId(User),
});
const Likes = defineRelation("rl_likes", { score: s.int() })
  .from(User)
  .to(Post);
const schema = defineSchema({ users: User, posts: Post, likes: Likes });

live("orm relations — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "orm_relations", database: "live" });
    await db.query(`
      DEFINE TABLE rl_user SCHEMAFULL;
      DEFINE FIELD name ON rl_user TYPE string;
      DEFINE FIELD age ON rl_user TYPE int;
      DEFINE FIELD mentor ON rl_user TYPE option<record<rl_user>>;
      DEFINE FIELD friends ON rl_user TYPE option<array<record<rl_user>>>;
      DEFINE FIELD home ON rl_user TYPE option<object> FLEXIBLE;
      DEFINE TABLE rl_post SCHEMAFULL;
      DEFINE FIELD title ON rl_post TYPE string;
      DEFINE FIELD published ON rl_post TYPE bool;
      DEFINE FIELD author ON rl_post TYPE record<rl_user>;
      DEFINE TABLE rl_likes TYPE RELATION IN rl_user OUT rl_post;
      DEFINE FIELD score ON rl_likes TYPE int;

      CREATE rl_user:alice CONTENT { name: "Alice", age: 30, home: { city: "São Paulo", line: "Rua A" } };
      CREATE rl_user:bob CONTENT { name: "Bob", age: 25, mentor: rl_user:alice, friends: [rl_user:alice] };
      CREATE rl_user:carol CONTENT { name: "Carol", age: 35 };
      CREATE rl_post:p1 CONTENT { title: "Hello", published: true, author: rl_user:alice };
      CREATE rl_post:p2 CONTENT { title: "World", published: false, author: rl_user:bob };
      RELATE rl_user:alice->rl_likes->rl_post:p1 SET score = 5;
      RELATE rl_user:bob->rl_likes->rl_post:p1 SET score = 3;
      RELATE rl_user:alice->rl_likes->rl_post:p2 SET score = 4;
    `);
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("link include: FETCH single/array/nested, projected fields + aliases", async () => {
    const bob = await client.users.findMany({
      include: { mentor: true, friends: true },
      where: { name: "Bob" },
    });
    expect(bob[0]?.mentor?.name).toBe("Alice");
    expect(bob[0]?.mentor?.id).toBeInstanceOf(RecordId);
    expect(bob[0]?.friends).toHaveLength(1);
    expect(bob[0]?.friends?.[0]?.name).toBe("Alice");

    const carol = await client.users.findMany({
      include: { mentor: { include: { mentor: true } } },
      where: { name: "Carol" },
    });
    expect(carol[0]?.mentor).toBeNull();

    const nested = await client.users.findMany({
      include: { mentor: { include: { mentor: true } } },
      where: { name: "Bob" },
    });
    expect(nested[0]?.mentor?.name).toBe("Alice");

    const projected = await client.users.findMany({
      include: { mentor: { select: { id: true, name: true, who: "name" } } },
      where: { name: "Bob" },
    });
    expect(String(projected[0]?.mentor?.id)).toBe("rl_user:alice");
    expect(projected[0]?.mentor?.name).toBe("Alice");
    expect(projected[0]?.mentor?.who).toBe("Alice");
  });

  test("edge include: target records, projection, per-parent filters and order/limit", async () => {
    const all = await client.users.findMany({
      include: { likes: true },
      where: { name: "Alice" },
    });
    expect(all[0]?.likes.map((post) => post.title).sort()).toEqual([
      "Hello",
      "World",
    ]);
    expect(all[0]?.likes[0]?.author).toBeInstanceOf(RecordId);

    const published = await client.users.findMany({
      include: { likes: { where: { published: true } } },
      where: { name: "Alice" },
    });
    expect(published[0]?.likes.map((post) => post.title)).toEqual(["Hello"]);

    const high = await client.users.findMany({
      include: {
        likes: {
          where: { score: { gt: 4 } },
          select: { id: true, title: true },
          orderBy: [{ title: "desc" }],
          limit: 1,
        },
      },
      where: { name: "Alice" },
    });
    expect(high[0]?.likes).toEqual([
      { id: new RecordId("rl_post", "p1"), title: "Hello" },
    ]);
  });

  test("edge include: edge records, edge+target remount and wildcard", async () => {
    const edgeOnly = await client.users.findMany({
      include: { likes: { edge: true } },
      where: { name: "Alice" },
    });
    expect(edgeOnly[0]?.likes).toHaveLength(2);
    expect(edgeOnly[0]?.likes[0]?.score).toBeGreaterThan(0);

    const both = await client.users.findMany({
      include: {
        likes: {
          edge: { select: { score: true } },
          target: { select: { id: true, title: true } },
          orderBy: [{ score: "desc" }],
        },
      },
      where: { name: "Alice" },
    });
    expect(both[0]?.likes[0]).toEqual({
      edge: { score: 5 },
      target: { id: new RecordId("rl_post", "p1"), title: "Hello" },
    });

    const wildcard = (await client.users.findMany({
      include: {
        relations: { wildcard: true, target: { id: true, title: true } },
      },
      where: { name: "Alice" },
    } as never)) as { relations: { title: string }[] }[];
    expect(wildcard[0]?.relations).toHaveLength(2);
    expect(wildcard[0]?.relations[0]?.title).toBeString();
  });

  test("projected links: absent decodes to null; nested object selects remount", async () => {
    const missing = await client.users.findMany({
      include: { mentor: { select: { name: true } } },
      where: { name: "Alice" },
    });
    expect(missing[0]?.mentor).toBeNull();

    const nested = await client.users.findMany({
      include: { mentor: { select: { home: { city: true } } } },
      where: { name: "Bob" },
    });
    expect(nested[0]?.mentor).toEqual({ home: { city: "São Paulo" } });
  });

  test("direction both: edge records and target records (edge+target is rejected)", async () => {
    const edges = await client.users.findMany({
      include: { likes: { direction: "both", edge: true } },
      where: { name: "Alice" },
    });
    expect(edges[0]?.likes).toHaveLength(2);

    const targets = await client.users.findMany({
      include: {
        likes: { direction: "both", select: { id: true, title: true } },
      },
      where: { name: "Alice" },
    });
    expect(targets[0]?.likes.map((row) => row.title).sort()).toEqual([
      "Hello",
      "World",
    ]);
  });

  test("wildcard edge records accept a where filter", async () => {
    const filtered = (await client.users.findMany({
      include: {
        relations: { wildcard: true, edge: true, where: { score: { gte: 4 } } },
      },
      where: { name: "Alice" },
    } as never)) as { relations: { score: number }[] }[];
    expect(filtered[0]?.relations.map((edge) => edge.score).sort()).toEqual([
      4, 5,
    ]);
  });

  test("relational where rides write batches (one round-trip)", async () => {
    await db.query(`
      CREATE rl_user:wendy CONTENT { name: "Wendy", age: 41 };
      CREATE rl_post:p9 CONTENT { title: "Temp", published: false, author: rl_user:wendy };
      RELATE rl_user:wendy->rl_likes->rl_post:p9 SET score = 9;
    `);
    const updated = await client.users.updateMany({
      where: { likes: { some: { score: 9 } } },
      data: { age: 42 },
    });
    expect(updated.count).toBe(1);
    const removed = await client.posts.deleteMany({
      where: { likes: { some: { score: 9 } }, title: "Temp" },
    });
    expect(removed.count).toBe(1);
    await db.query(
      "DELETE rl_likes WHERE in = rl_user:wendy; DELETE rl_user:wendy;",
    );
  });

  test("incoming edges: direction auto and explicit, filters on the other endpoint", async () => {
    const incoming = await client.posts.findMany({
      include: { likes: { select: { id: true, name: true } } },
      where: { id: "rl_post:p1" },
    });
    expect(incoming[0]?.likes.map((user) => user.name).sort()).toEqual([
      "Alice",
      "Bob",
    ]);

    const filtered = await client.posts.findMany({
      include: {
        likes: {
          where: { score: { gt: 4 } },
          select: { id: true, name: true },
        },
      },
      where: { id: "rl_post:p1" },
    });
    expect(filtered[0]?.likes).toEqual([
      { id: new RecordId("rl_user", "alice"), name: "Alice" },
    ]);
  });

  test("_count: edges (filtered per edge/target), array links and NONE arrays", async () => {
    const counted = await client.users.findMany({
      include: {
        _count: {
          select: {
            likes: true,
            friends: true,
          },
        },
      },
      where: { name: { in: ["Alice", "Bob", "Carol"] } },
      orderBy: [{ name: "asc" }],
    });
    expect(
      counted.map((row) => [row._count.likes, row._count.friends]),
    ).toEqual([
      [2, 0],
      [1, 1],
      [0, 0],
    ]);

    const filtered = await client.users.findMany({
      include: {
        _count: { select: { likes: { where: { score: { gt: 4 } } } } },
      },
      where: { name: "Alice" },
    });
    expect(filtered[0]?._count.likes).toBe(1);
  });

  test("relational where: is/isNot (NONE), some/none/every and direction override", async () => {
    const is = await client.users.findMany({
      where: { mentor: { is: { name: "Alice" } } },
      select: { name: true },
    });
    expect(is.map((row) => row.name)).toEqual(["Bob"]);

    // `isNot` is TRUE for a missing link (NONE) and for a different value.
    const isNot = await client.users.findMany({
      where: { mentor: { isNot: { name: "Alice" } } },
      select: { name: true },
      orderBy: [{ name: "asc" }],
    });
    expect(isNot.map((row) => row.name)).toEqual(["Alice", "Carol"]);

    const some = await client.users.findMany({
      where: { likes: { some: { published: true } } },
      select: { name: true },
      orderBy: [{ name: "asc" }],
    });
    expect(some.map((row) => row.name)).toEqual(["Alice", "Bob"]);

    const none = await client.users.findMany({
      where: { likes: { none: { published: true } } },
      select: { name: true },
    });
    expect(none.map((row) => row.name)).toEqual(["Carol"]);

    const every = await client.users.findMany({
      where: { likes: { every: { published: true } } },
      select: { name: true },
      orderBy: [{ name: "asc" }],
    });
    expect(every.map((row) => row.name)).toEqual(["Bob", "Carol"]);

    const arraySome = await client.users.findMany({
      where: { friends: { some: { age: { gt: 18 } } } },
      select: { name: true },
    });
    expect(arraySome.map((row) => row.name)).toEqual(["Bob"]);

    const incoming = await client.posts.findMany({
      where: { likes: { some: { name: "Alice" }, direction: "in" } },
      select: { id: true },
      orderBy: [{ id: "asc" }],
    });
    expect(incoming.map((row) => String(row.id))).toEqual([
      "rl_post:p1",
      "rl_post:p2",
    ]);
  });

  test("include rides findUnique, paginate and cursor", async () => {
    const unique = await client.users.findUnique({
      where: { id: "rl_user:bob" },
      include: { mentor: { select: { name: true } } },
    });
    expect(unique?.mentor?.name).toBe("Alice");

    const page = await client.users.paginate({
      include: { likes: true },
      where: { name: "Alice" },
      limit: 1,
    });
    expect(page.data[0]?.likes).toHaveLength(2);
    expect(page.pagination.total).toBe(1);

    const cursor = await client.users.cursor({
      include: { _count: { select: { likes: true } } },
      limit: 1,
    });
    expect(cursor.data[0]?._count).toBeDefined();
  });

  test("M3.5: recursion flows through a surql projection fragment", async () => {
    const rows = await client.users.findMany({
      select: {
        name: true,
        likes: surql`@.{1..2}->rl_likes->rl_post`.as<RecordId[]>(),
      },
      where: { id: "rl_user:alice" },
    });
    expect(rows[0]?.likes).toHaveLength(2);
    expect(rows[0]?.likes[0]).toBeInstanceOf(RecordId);
  });

  test("include guards: unknown key, single-link _count, value conflict", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(
      code(() => client.users.findMany({ include: { nope: true } as never })),
    ).toBe("UnknownField");
    expect(
      code(() =>
        client.users.findMany({
          include: { _count: { select: { mentor: true } } } as never,
        }),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        client.users.findMany({
          include: { mentor: true } as never,
          value: true,
          select: { name: true },
        }),
      ),
    ).toBe("ClauseNotSupported");
  });
});
