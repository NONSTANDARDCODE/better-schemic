// M0.2 — TYPE assertions for the schema artifact (`defineSchema` -> `SchemaIndex` derivations).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
//
// `assertType<Expected, Actual>()` fails to COMPILE if Actual isn't exactly Expected — so a key-extraction
// regression (an edge leaking into SchemalessKeys, `AppAt` losing the codec type, …) turns red here.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import {
  defineFunction,
  defineRelation,
  defineTable,
  type IdStrategy,
  s,
} from "../../src/index";
import { defineSchema } from "../../src/orm/schema";
import type {
  AppAt,
  FunctionAt,
  FunctionKeys,
  RelationAt,
  RelationKeys,
  SchemalessKeys,
  SchemaOf,
  TableAt,
  TableKeys,
} from "../../src/orm/types/schema";
import type { App } from "../../src/pure";

// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

const User = defineTable("user", { name: s.string(), age: s.int() });
const Post = defineTable("post", {
  title: s.string(),
  author: s.recordId(User),
});
const Likes = defineRelation("likes", { score: s.int() }).from(User).to(Post);
const greet = defineFunction("greet", { name: s.string() }).returns(s.string());

const schema = defineSchema({
  users: User,
  posts: Post,
  likes: Likes,
  greet,
  audit: "audit_log",
});
type S = typeof schema;

describe("idStrategy — authoring types", () => {
  it("the strategy union is enforced and chainable", () => {
    const withUuid = defineTable("t", { name: s.string() }).idStrategy("uuid");
    const withRand = defineTable("t", { name: s.string() }).idStrategy("rand");
    const withUlid = defineTable("t", { name: s.string() }).idStrategy("ulid");
    // `config` is the general `TableConfig`, so the property is the union (not the literal).
    assertType<IdStrategy | undefined, (typeof withUuid)["config"]["idStrategy"]>();
    assertType<IdStrategy | undefined, (typeof withRand)["config"]["idStrategy"]>();
    assertType<IdStrategy | undefined, (typeof withUlid)["config"]["idStrategy"]>();
    // @ts-expect-error — "nanoid" is not an IdStrategy
    const bad: IdStrategy = "nanoid";
    void bad;
  });
  it("IdStrategy is exported from the authoring index", () => {
    assertType<"ulid" | "uuid" | "rand", IdStrategy>();
  });
});

describe("SchemaDef — key extraction", () => {
  it("TableKeys is tables AND relation keys", () => {
    assertType<"users" | "posts" | "likes", TableKeys<S>>();
  });
  it("RelationKeys is exactly the edge keys", () => {
    assertType<"likes", RelationKeys<S>>();
  });
  it("SchemalessKeys is exactly the string entries", () => {
    assertType<"audit", SchemalessKeys<S>>();
  });
  it("FunctionKeys is exactly the function entries", () => {
    assertType<"greet", FunctionKeys<S>>();
  });
});

describe("SchemaDef — def lookup", () => {
  it("TableAt preserves the authored def type", () => {
    assertType<typeof User, TableAt<S, "users">>();
    assertType<typeof Likes, TableAt<S, "likes">>();
  });
  it("AppAt resolves the DECODED row (codecs included)", () => {
    assertType<App<typeof User>, AppAt<S, "users">>();
    assertType<App<typeof Post>, AppAt<S, "posts">>();
  });
  it("RelationAt / FunctionAt narrow to their defs", () => {
    assertType<typeof Likes, RelationAt<S, "likes">>();
    assertType<true, [RelationAt<S, "users">] extends [never] ? true : false>();
    assertType<typeof greet, FunctionAt<S, "greet">>();
    assertType<true, [FunctionAt<S, "users">] extends [never] ? true : false>();
  });
  it("SchemaOf recovers the authored entries object", () => {
    assertType<typeof schema.entries, SchemaOf<S>>();
  });
});
