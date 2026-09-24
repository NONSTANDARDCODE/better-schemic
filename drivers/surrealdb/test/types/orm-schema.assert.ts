// M0.2 — TYPE assertions for the schema artifact (`defineSchema` -> `SchemaIndex` derivations).
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
//
// `attest<Expected, Actual>()` fails to COMPILE if Actual isn't exactly Expected — so a key-extraction
// regression (an edge leaking into SchemalessKeys, `AppAt` losing the codec type, …) turns red here.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import {
  defineFunction,
  defineRelation,
  defineTable,
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
import { setupTypes, teardownTypes } from "./_setup";

// attest needs its checker set up once per run; `_setup.ts` memoizes it so every assert file in the
// package's single node process shares ONE TypeScript program. See docs/TYPE-PERF-TESTING.md.
before(setupTypes);
after(teardownTypes);

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

describe("SchemaDef — key extraction", () => {
  it("TableKeys is tables AND relation keys", () => {
    attest<"users" | "posts" | "likes", TableKeys<S>>();
  });
  it("RelationKeys is exactly the edge keys", () => {
    attest<"likes", RelationKeys<S>>();
  });
  it("SchemalessKeys is exactly the string entries", () => {
    attest<"audit", SchemalessKeys<S>>();
  });
  it("FunctionKeys is exactly the function entries", () => {
    attest<"greet", FunctionKeys<S>>();
  });
});

describe("SchemaDef — def lookup", () => {
  it("TableAt preserves the authored def type", () => {
    attest<typeof User, TableAt<S, "users">>();
    attest<typeof Likes, TableAt<S, "likes">>();
  });
  it("AppAt resolves the DECODED row (codecs included)", () => {
    attest<App<typeof User>, AppAt<S, "users">>();
    attest<App<typeof Post>, AppAt<S, "posts">>();
  });
  it("RelationAt / FunctionAt narrow to their defs", () => {
    attest<typeof Likes, RelationAt<S, "likes">>();
    attest<true, [RelationAt<S, "users">] extends [never] ? true : false>();
    attest<typeof greet, FunctionAt<S, "greet">>();
    attest<true, [FunctionAt<S, "users">] extends [never] ? true : false>();
  });
  it("SchemaOf recovers the authored entries object", () => {
    attest<typeof schema.entries, SchemaOf<S>>();
  });
});
