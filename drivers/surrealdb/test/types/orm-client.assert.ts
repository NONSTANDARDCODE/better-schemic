// M0.5 — TYPE assertions for the `/orm` client: schema keys map to delegates, functions do NOT
// (they land with client.fn in M5.2), and the lifecycle surface is intact.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import {
  defineFunction,
  defineRelation,
  defineTable,
  s,
} from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { Delegate, RelationDelegate } from "../../src/orm/delegate";
import { defineSchema } from "../../src/orm/schema";
import type { AnyTableDef } from "../../src/orm/types/schema";


const User = defineTable("user", { name: s.string() });
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
type C = Client<typeof schema>;

describe("Client<S> — schema keys -> delegates", () => {
  it("every model key resolves to a Delegate (typed per model)", () => {
    assertType<Delegate<typeof User, typeof schema>, C["users"]>();
    assertType<Delegate<typeof Post, typeof schema>, C["posts"]>();
    // A relation maps to the RelationDelegate (RELATE surface) with the schema-typed args.
    assertType<RelationDelegate<typeof Likes, typeof schema>, C["likes"]>();
    // Schemaless entries map to the loosely-typed delegate over unknown rows.
    assertType<Delegate<AnyTableDef, typeof schema>, C["audit"]>();
  });
  it("model keys are part of the client type; function keys are not", () => {
    assertType<true, "users" extends keyof C ? true : false>();
    assertType<true, "audit" extends keyof C ? true : false>();
    assertType<false, "greet" extends keyof C ? true : false>();
    assertType<false, "nope" extends keyof C ? true : false>();
  });
  it("lifecycle members survive the delegate mapping", () => {
    assertType<readonly string[], C["tables"]>();
    assertType<Delegate, ReturnType<C["repository"]>>();
    assertType<Promise<void>, ReturnType<C["close"]>>();
    assertType<Promise<Client<typeof schema>>, ReturnType<C["forkSession"]>>();
  });
});
