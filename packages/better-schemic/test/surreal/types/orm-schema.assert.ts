// M0.2 — TYPE assertions for the schema artifact (`schema` -> `SchemaIndex` derivations).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
//
// `assertType<Expected, Actual>()` fails to COMPILE if Actual isn't Expected — so a key-extraction
// regression (an edge leaking into SchemalessKeys, `AppAt` losing the codec type, …) turns red here.

import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { defineFunction, type IdStrategy, relation, s, table } from "../../../src/surreal"
import { schema } from "../../../src/surreal/orm/schema"
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
} from "../../../src/surreal/orm/types/schema"
import type { App } from "../../../src/surreal/pure"

// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

const User = table("user", { age: s.int(), name: s.string() })
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
type S = typeof _schemaDef

void describe("idStrategy — authoring types", () => {
  void it("the strategy union is enforced and chainable", () => {
    const _withUuid = table("t", { name: s.string() }).idStrategy("uuid")
    const _withRand = table("t", { name: s.string() }).idStrategy("rand")
    const _withUlid = table("t", { name: s.string() }).idStrategy("ulid")
    // `config` is the general `TableConfig`, so the property is the union (not the literal).
    assertType<IdStrategy | undefined, (typeof _withUuid)["config"]["idStrategy"]>()
    assertType<IdStrategy | undefined, (typeof _withRand)["config"]["idStrategy"]>()
    assertType<IdStrategy | undefined, (typeof _withUlid)["config"]["idStrategy"]>()
    // @ts-expect-error — "nanoid" is not an IdStrategy
    const bad: IdStrategy = "nanoid"
    const _probe_55 = bad
  })
  void it("IdStrategy is exported from the authoring index", () => {
    assertType<"rand" | "ulid" | "uuid", IdStrategy>()
  })
})

void describe("SchemaDef — key extraction", () => {
  void it("TableKeys is tables AND relation keys", () => {
    assertType<"likes" | "posts" | "users", TableKeys<S>>()
  })
  void it("RelationKeys is exactly the edge keys", () => {
    assertType<"likes", RelationKeys<S>>()
  })
  void it("SchemalessKeys is exactly the string entries", () => {
    assertType<"audit", SchemalessKeys<S>>()
  })
  void it("FunctionKeys is exactly the function entries", () => {
    assertType<"greet", FunctionKeys<S>>()
  })
})

void describe("SchemaDef — def lookup", () => {
  void it("TableAt preserves the authored def type", () => {
    assertType<typeof User, TableAt<S, "users">>()
    assertType<typeof Likes, TableAt<S, "likes">>()
  })
  void it("AppAt resolves the DECODED row (codecs included)", () => {
    assertType<App<typeof User>, AppAt<S, "users">>()
    assertType<App<typeof Post>, AppAt<S, "posts">>()
  })
  void it("RelationAt / FunctionAt narrow to their defs", () => {
    assertType<typeof Likes, RelationAt<S, "likes">>()
    assertType<true, [RelationAt<S, "users">] extends [never] ? true : false>()
    assertType<typeof greet, FunctionAt<S, "greet">>()
    assertType<true, [FunctionAt<S, "users">] extends [never] ? true : false>()
  })
  void it("SchemaOf recovers the authored entries object", () => {
    assertType<typeof _schemaDef.entries, SchemaOf<S>>()
  })
})
