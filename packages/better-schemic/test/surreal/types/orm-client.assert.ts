import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { defineFunction, relation, s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import type { Delegate, RelationDelegate } from "../../../src/surreal/orm/delegate"
import { schema } from "../../../src/surreal/orm/schema"
import type { AnyTableDef } from "../../../src/surreal/orm/types/schema"

// M0.5 — TYPE assertions for the `/orm` client: schema keys map to delegates, functions do NOT
// (they land with client.fn in M5.2), and the lifecycle surface is intact.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

const User = table("user", { name: s.string() })
const Post = table("post", {
  author: s.recordId(User),
  title: s.string(),
})
const Likes = relation("likes", { score: s.int() }).from(User).to(Post)
const greet = defineFunction("greet", { name: s.string() }).returns(s.string())

const _schemaDef = schema({
  audit: "audit_log",
  greet,
  likes: Likes,
  posts: Post,
  users: User,
})
type C = Client<typeof _schemaDef>

void describe("Client<S> — schema keys -> delegates", () => {
  void it("every model key resolves to a Delegate (typed per model)", () => {
    assertType<Delegate<typeof User, typeof _schemaDef>, C["users"]>()
    assertType<Delegate<typeof Post, typeof _schemaDef>, C["posts"]>()
    // A relation maps to the RelationDelegate (RELATE surface) with the schema-typed args.
    assertType<RelationDelegate<typeof Likes, typeof _schemaDef>, C["likes"]>()
    // Schemaless entries map to the -typed delegate over unknown rows.
    assertType<Delegate<AnyTableDef, typeof _schemaDef>, C["audit"]>()
  })
  void it("model keys are part of the client type; function keys are not", () => {
    assertType<true, "users" extends keyof C ? true : false>()
    assertType<true, "audit" extends keyof C ? true : false>()
    assertType<false, "greet" extends keyof C ? true : false>()
    assertType<false, "nope" extends keyof C ? true : false>()
  })
  void it("lifecycle members survive the delegate mapping", () => {
    assertType<readonly string[], C["tables"]>()
    assertType<Delegate, ReturnType<C["repository"]>>()
    assertType<Promise<void>, ReturnType<C["close"]>>()
    assertType<Promise<Client<typeof _schemaDef>>, ReturnType<C["forkSession"]>>()
  })
})
