// M0.5 — TYPE assertions for the `/orm` client: schema keys map to delegates, functions do NOT
// (they land with client.fn in M5.2), and the lifecycle surface is intact.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest, setup, teardown } from "@ark/attest";
import {
  defineFunction,
  defineRelation,
  defineTable,
  s,
} from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import { defineSchema } from "../../src/orm/schema";

let cleanup: (() => void) | undefined;
before(() => {
  cleanup = setup() as unknown as () => void;
});
after(() => {
  cleanup?.();
  teardown();
});

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
  it("every model key resolves to a Delegate", () => {
    attest<Delegate, C["users"]>();
    attest<Delegate, C["posts"]>();
    attest<Delegate, C["likes"]>();
    attest<Delegate, C["audit"]>();
  });
  it("model keys are part of the client type; function keys are not", () => {
    attest<true, "users" extends keyof C ? true : false>();
    attest<true, "audit" extends keyof C ? true : false>();
    attest<false, "greet" extends keyof C ? true : false>();
    attest<false, "nope" extends keyof C ? true : false>();
  });
  it("lifecycle members survive the delegate mapping", () => {
    attest<readonly string[], C["tables"]>();
    attest<Delegate, ReturnType<C["repository"]>>();
    attest<Promise<void>, ReturnType<C["close"]>>();
    attest<Promise<Client<typeof schema>>, ReturnType<C["forkSession"]>>();
  });
});
