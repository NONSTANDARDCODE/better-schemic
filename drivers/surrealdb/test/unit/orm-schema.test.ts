// M0.2 — `defineSchema` + `SchemaIndex`: the runtime metadata pass over an authored schema
// (columns/families, record links, graph adjacency, singletons, functions, schemaless entries) plus
// the fail-fast validation that turns a bad schema module into an import-time `SchemaInvalid`.
import { describe, expect, test } from "bun:test";
import { BetterSchemicError } from "../../src/orm/errors";
import {
  buildSchemaIndex,
  defineSchema,
  isSchemaDef,
  type TableMeta,
} from "../../src/orm/schema";
import {
  defineFunction,
  defineRelation,
  defineSingleton,
  defineTable,
  s,
} from "../../src/pure";

const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  bio: s.string().optional(),
  bestFriend: s.recordId("user").optional(),
  reads: s.recordId("post").array(),
  tags: s.array(s.string()),
  scores: s.set(s.int()),
  location: s.geometry("point").optional(),
  meta: s.object({ city: s.string() }).optional(),
  role: s.enum(["admin", "member"]),
});

const Post = defineTable("post", {
  title: s.string(),
  author: s.recordId(User),
});

const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);

const Config = defineSingleton("config", { theme: s.string() });

const greet = defineFunction("greet", { name: s.string() }).returns(s.string());

const schema = defineSchema({
  users: User,
  posts: Post,
  likes: Likes,
  config: Config,
  greet,
  audit: "audit_log",
});

const meta = (
  index: ReturnType<typeof buildSchemaIndex>,
  key: string,
): TableMeta => {
  const found = index.tables.get(key);
  if (!found) throw new Error(`missing table meta: ${key}`);
  return found;
};

const column = (table: TableMeta, field: string) => {
  const found = table.columns.get(field);
  if (!found) throw new Error(`missing column meta: ${table.key}.${field}`);
  return found;
};

describe("defineSchema — branding and lookup", () => {
  test("brands the artifact and caches the index per schema object", () => {
    expect(isSchemaDef(schema)).toBe(true);
    expect(isSchemaDef({ users: User })).toBe(false);
    // defineSchema already validated/built once — buildSchemaIndex returns the SAME index.
    expect(buildSchemaIndex(schema)).toBe(buildSchemaIndex(schema));
  });

  test("a plain `{ key: def }` literal is accepted (unbranded) and indexed", () => {
    const index = buildSchemaIndex({ users: User });
    expect(isSchemaDef({ users: User })).toBe(false);
    expect(index.tables.get("users")?.name).toBe("user");
    expect(index.tables.size).toBe(1);
  });

  test("indexes every key by schema key AND physical name", () => {
    const index = buildSchemaIndex(schema);
    expect([...index.tables.keys()].sort()).toEqual([
      "config",
      "likes",
      "posts",
      "users",
    ]);
    expect(index.byName.get("user")).toBe(index.tables.get("users"));
    expect(index.byName.get("likes")).toBe(index.tables.get("likes"));
    expect(index.schemaless.get("audit")?.name).toBe("audit_log");
    expect(index.byName.get("audit_log")?.key).toBe("audit");
  });
});

describe("SchemaIndex — columns and field families", () => {
  const index = buildSchemaIndex(schema);
  const users = meta(index, "users");

  test("classifies scalar families from the DDL walker's wire type", () => {
    expect(column(users, "name")).toMatchObject({
      family: "string",
      type: "string",
    });
    expect(column(users, "age")).toMatchObject({
      family: "number",
      type: "int",
    });
    expect(column(users, "bio")).toMatchObject({
      family: "string",
      optional: true,
      type: "option<string>",
    });
    expect(column(users, "role").family).toBe("string"); // enum literals
    expect(column(users, "location")).toMatchObject({
      family: "geometry",
      optional: true,
    });
    expect(column(users, "meta")).toMatchObject({
      family: "object",
      optional: true,
    });
    expect(column(users, "id")).toMatchObject({
      family: "record",
      type: "record<user>",
    });
  });

  test("classifies collections with their element family", () => {
    expect(column(users, "tags")).toMatchObject({
      family: "array",
      element: "string",
    });
    expect(column(users, "scores")).toMatchObject({
      family: "set",
      element: "number",
    });
  });

  test("derives record links (single, optional, array, union) into `links`", () => {
    expect(column(users, "bestFriend").record).toEqual({
      targets: ["user"],
      list: false,
      optional: true,
    });
    expect(column(users, "reads").record).toEqual({
      targets: ["post"],
      list: true,
      optional: false,
    });
    expect(column(users, "id").record?.targets).toEqual(["user"]);

    expect(users.links.get("bestFriend")).toMatchObject({
      targets: ["user"],
      cardinality: "one",
      optional: true,
    });
    expect(users.links.get("reads")).toMatchObject({
      targets: ["post"],
      cardinality: "many",
    });
    expect(users.links.has("name")).toBe(false);
  });

  test("a bare `record` link has no target restriction", () => {
    const Any = defineTable("any_link", { ref: s.recordId() });
    const index2 = buildSchemaIndex({ any: Any });
    expect(column(meta(index2, "any"), "ref").record).toEqual({
      list: false,
      optional: false,
    });
  });
});

describe("SchemaIndex — graph adjacency and relations", () => {
  const index = buildSchemaIndex(schema);
  const users = meta(index, "users");
  const posts = meta(index, "posts");
  const likes = meta(index, "likes");

  test("a relation is a table with endpoints + kind", () => {
    expect(likes.kind).toBe("relation");
    expect(likes.endpoints).toEqual({
      from: ["user"],
      to: ["post"],
      enforced: false,
    });
    expect(column(likes, "score").family).toBe("number");
    expect(likes.links.get("in")?.targets).toEqual(["user"]);
    expect(likes.links.get("out")?.targets).toEqual(["post"]);
  });

  test("from/to build outgoing/incoming adjacency on the endpoints", () => {
    expect(users.outgoing.map((e) => e.name)).toContain("likes");
    expect(users.incoming).toEqual([]);
    expect(posts.incoming.map((e) => e.name)).toContain("likes");
    expect(posts.outgoing).toEqual([]);
    expect(users.outgoing[0]?.key).toBe("likes");
    expect(users.outgoing[0]?.def).toBe(Likes);
  });

  test("a relation without endpoints has no adjacency and no endpoints meta", () => {
    const Free = defineRelation("free");
    const index2 = buildSchemaIndex({ free: Free });
    const free = meta(index2, "free");
    expect(free.kind).toBe("relation");
    expect(free.endpoints).toEqual({ from: [], to: [], enforced: false });
  });
});

describe("SchemaIndex — singletons and functions", () => {
  const index = buildSchemaIndex(schema);

  test("singleton tables expose their fixed id key", () => {
    expect(meta(index, "config").singletonId).toBe("default");
    expect(meta(index, "users").singletonId).toBeUndefined();
  });

  test("functions expose name, arg metas and decoded return", () => {
    const fn = index.functions.get("greet");
    expect(fn?.name).toBe("greet");
    expect(fn?.args.get("name")).toMatchObject({ family: "string" });
    expect(fn?.returns).toMatchObject({ family: "string" });
  });
});

describe("SchemaIndex — fail-fast validation (SchemaInvalid)", () => {
  const bad = (entries: Record<string, unknown>, re: RegExp) => {
    const err = (() => {
      try {
        buildSchemaIndex(entries as never);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BetterSchemicError);
    expect((err as BetterSchemicError).code).toBe("SchemaInvalid");
    expect((err as Error).message).toMatch(re);
  };

  test("rejects an entry that is not a def or a schemaless name", () => {
    bad({ nope: 42 }, /not a table\/edge\/function/);
  });

  test("rejects duplicate physical table names", () => {
    const A = defineTable("dup", { x: s.string() });
    const B = defineTable("dup", { y: s.string() });
    bad({ a: A, b: B }, /duplicate table name "dup"/);
  });

  test("rejects a schemaless name colliding with a table", () => {
    const A = defineTable("user", { x: s.string() });
    bad({ a: A, b: "user" }, /duplicate table name "user"/);
  });

  test("rejects duplicate function names", () => {
    const f1 = defineFunction("greet", {});
    const f2 = defineFunction("greet", {});
    bad({ f1, f2 }, /duplicate function name "greet"/);
  });

  test("rejects a relation endpoint that no entry declares", () => {
    const Ghost = defineRelation("ghost", {}).from("nobody").to("user");
    bad({ users: User, ghost: Ghost }, /points to table "nobody"/);
  });

  test("accepts a relation endpoint that is a schemaless entry", () => {
    const Edge = defineRelation("edge", {}).from("user").to("audit_log");
    const index = buildSchemaIndex({
      users: User,
      audit: "audit_log",
      edge: Edge,
    });
    expect(meta(index, "users").outgoing.map((e) => e.name)).toContain("edge");
  });

  test("rejects a record-link field that collides with a relation name", () => {
    const Person = defineTable("person", {
      name: s.string(),
      likes: s.recordId("post"),
    });
    const Post = defineTable("post", { title: s.string() });
    const Likes = defineRelation("likes", {}).from(Person).to(Post);
    bad(
      { person: Person, post: Post, likes: Likes },
      /record-link field "likes"/,
    );
  });

  test("defineSchema validates EAGERLY (import-time failure)", () => {
    expect(() => defineSchema({ bad: 1 as never })).toThrow(BetterSchemicError);
  });
});
