const _MAGIC_18 = 18
const _MAGIC_2 = 2
const _MAGIC_65 = 65
// M1.8 — TYPE assertions for the read surface: `where`, `select`/`omit`/`value`/``/`split`
// result shapes, the throwing reads, the combine/count/paginate/cursor envelopes, and `explain`.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { s, table } from "../../../src/surreal"
import type { Surql } from "../../../src/surreal/frag"
import type { Client } from "../../../src/surreal/orm/client"
import type { Delegate } from "../../../src/surreal/orm/delegate"
import type { ExplainResult, SqlPreview, ThrowingResult } from "../../../src/surreal/orm/results"
import { schema } from "../../../src/surreal/orm/schema"
import type {
  AggregateShape,
  CursorArgs,
  CursorResult,
  FindManyResult,
  FindOneResult,
  FindUniqueResult,
  PaginationResult,
  ReadResult,
  ResultOf,
} from "../../../src/surreal/orm/types/select"
import type { Where } from "../../../src/surreal/orm/types/where"
import type { App } from "../../../src/surreal/pure"

const User = table("user", {
  active: s.boolean(),
  address: s.object({ city: s.string(), country: s.string() }),
  age: s.int(),
  at: s.datetime(),
  createdAt: s.datetime(),
  email: s.string(),
  name: s.string(),
  tags: s.array(s.string()),
})
  .index("user_idx_email", ["email"], { unique: true })
  .index("user_idx_tenant_email", ["name", "email"], { unique: true })
const _schemaDef = schema({ users: User })
type U = typeof User
type Row = App<U>
type C = Client<typeof _schemaDef>
type Users = C["users"]

void describe("where — family-aware filters and paths", () => {
  void it("pure values, operators and paths typecheck", () => {
    assertType<
      true,
      {
        active: true
        "address.city": "SP"
        age: { gte: typeof _MAGIC_18; lt: typeof _MAGIC_65 }
        "contacts[*].type": "email"
        name: { startsWith: "A" }
        NOT: { active: false }
        OR: [{ age: 1 }, { age: typeof _MAGIC_2 }]
        tags: { containsAny: ["db"] }
      } extends Where<U>
        ? true
        : false
    >()
  })

  void it("rejects wrong-family operators and wrong value types", () => {
    assertType<false, { age: { contains: "x" } } extends Where<U> ? true : false>()
    assertType<false, { name: { containsAll: ["a"] } } extends Where<U> ? true : false>()
    assertType<false, { age: "old" } extends Where<U> ? true : false>()
    assertType<
      false,
      { active: { between: [1, typeof _MAGIC_2] } } extends Where<U> ? true : false
    >()
  })

  void it("a typo (not a path) is rejected by excess-property checking", () => {
    // @ts-expect-error — "nmae" is neither a field nor a dotted path
    const bad: Where<U> = { nmae: "x" }
    const _probe_78 = bad
  })

  void it("record ids accept strings; the logical combinators recurse", () => {
    assertType<true, { id: "user:aeon" } extends Where<U> ? true : false>()
    assertType<
      true,
      { OR: [{ NOT: { id: "user:a" } }, { age: 1 }] } extends Where<U> ? true : false
    >()
  })
})

void describe("select — result shapes", () => {
  void it("no projection is the decoded row", () => {
    assertType<Row, ResultOf<U, Record<string, never>>>()
  })

  void it("field lists, paths (nested), aliases and fragments", () => {
    assertType<
      {
        address: { city: string }
        city: string
        id: Row["id"]
        name: string
      },
      ResultOf<
        U,
        {
          select: {
            "address.city": true
            city: "address.city"
            id: true
            name: true
          }
        }
      >
    >()
    assertType<{ id: Row["id"]; name: string }, ResultOf<U, { select: ["id", "name"] }>>()
    assertType<{ bump: number }, ResultOf<U, { select: { bump: Surql<[number]> } }>>()
  })

  void it("nested sub-objects and star + expression", () => {
    assertType<
      { address: { city: string; country: string } },
      ResultOf<U, { select: { address: { city: true; country: true } } }>
    >()
    assertType<
      Row & { score: number },
      ResultOf<U, { select: { "*": true; score: Surql<[number]> } }>
    >()
  })

  void it("omit removes keys; value unwraps; only unwraps the page", () => {
    assertType<Omit<Row, "age">, ResultOf<U, { omit: ["age"] }>>()
    assertType<string, ResultOf<U, { select: { name: true }; value: true }>>()
    // `` unwraps the PAGE (see FindManyResult) — ResultOf stays the row shape.
    assertType<Row, ResultOf<U, { only: true }>>()
  })

  void it("split changes the field to its element type", () => {
    assertType<Omit<Row, "tags"> & { tags: string }, ResultOf<U, { split: "tags" }>>()
    assertType<
      { name: string; tags: string },
      ResultOf<U, { select: { name: true; tags: true }; split: "tags" }>
    >()
  })
})

void describe("read envelopes", () => {
  void it("findMany is a lazy promise with .explain(); explain:true yields the plan", () => {
    assertType<
      Promise<Row[]> & {
        explain(): Promise<ExplainResult>
        toSQL(): SqlPreview
      },
      FindManyResult<U, Record<string, never>>
    >()
    assertType<
      Promise<ExplainResult> & { toSQL(): SqlPreview },
      FindManyResult<U, { explain: true }>
    >()
  })

  void it("findFirst/findOne/findUnique are ThrowingResults with .explain()/.toSQL()", () => {
    assertType<
      ThrowingResult<Row> & {
        explain(): Promise<ExplainResult>
        toSQL(): SqlPreview
      },
      FindOneResult<U, Record<string, never>>
    >()
    assertType<
      ThrowingResult<Row> & {
        explain(): Promise<ExplainResult>
        toSQL(): SqlPreview
      },
      FindUniqueResult<U, { where: { id: "user:a" } }>
    >()
  })

  void it("count/exists/aggregate/paginate/cursor carry their payloads", () => {
    assertType<
      Promise<number> & {
        explain(): Promise<ExplainResult>
        toSQL(): SqlPreview
      },
      ReadResult<number, Record<string, never>>
    >()
    assertType<
      Promise<boolean> & {
        explain(): Promise<ExplainResult>
        toSQL(): SqlPreview
      },
      ReadResult<boolean, Record<string, never>>
    >()
    assertType<
      { _count: number; avgAge: number; names: string[] },
      AggregateShape<U, { _count: true; avgAge: { avg: "age" }; names: { collect: "name" } }>
    >()
    assertType<
      PaginationResult<Row>,
      Awaited<ReadResult<PaginationResult<Row>, Record<string, never>>>
    >()
    assertType<CursorResult<Row>, Awaited<ReadResult<CursorResult<Row>, Record<string, never>>>>()
  })

  void it("cursor: select may omit the orderBy fields; value/only/start are off-surface", () => {
    assertType<
      { name: string },
      ResultOf<
        U,
        {
          orderBy: [{ age: "desc" }, { id: "asc" }]
          select: { name: true }
        }
      >
    >()
    // @ts-expect-error — a VALUE projection is a scalar, not a keyset row
    const withValue: CursorArgs<U> = { limit: 1, value: true }
    // @ts-expect-error — a cursor page is  rows
    const withOnly: CursorArgs<U> = { limit: 1, only: true }
    // @ts-expect-error — offsets are `paginate`'s job
    const withStart: CursorArgs<U> = { limit: 1, start: 5 }
    const _probe_221 = withValue
    const _probe_222 = withOnly
    const _probe_223 = withStart
  })

  void it("cursor: the LAST orderBy field must be unique (typed from the schema)", () => {
    // `id` is unique by construction — the portable tiebreaker.
    const byId: CursorArgs<U> = {
      limit: 2,
      orderBy: [{ age: "desc" }, { id: "asc" }],
    }
    const idOnly: CursorArgs<U> = { limit: 2, orderBy: [{ id: "desc" }] }
    // `email` carries a single-field UNIQUE index, so it's a valid tiebreaker too.
    const byEmail: CursorArgs<U> = {
      limit: 2,
      orderBy: [{ createdAt: "desc" }, { email: "asc" }],
    }
    const nonUnique: CursorArgs<U> = {
      limit: 2,
      // @ts-expect-error — `createdAt` is not unique: a keyset page could skip/duplicate a row
      orderBy: [{ createdAt: "desc" }],
    }
    // The tiebreaker must come LAST: a trailing non-unique field refuss it too.
    const wrongPosition = [{ id: "asc" }, { age: "desc" }] as const
    const badOrder: CursorArgs<U> = {
      limit: 2,
      // @ts-expect-error — `age` is not unique, so it cannot close the keyset
      orderBy: wrongPosition,
    }
    const _probe_250 = byId
    const _probe_251 = idOnly
    const _probe_252 = byEmail
    const _probe_253 = nonUnique
    const _probe_254 = badOrder
  })

  void it("aggregate shapes dispatch per operator", () => {
    assertType<
      {
        first: Date
        last: Date
        tags: string[]
        tagSets: string[][]
        total: number
        upper: string
      },
      AggregateShape<
        U,
        {
          first: { min: "at" }
          last: { max: "at" }
          tags: { distinct: "name" }
          tagSets: { collect: "tags" }
          total: { sum: "age" }
          upper: Surql<[string]>
        }
      >
    >()
  })

  void it("explain: true flips count/exists to the plan (still previewable)", () => {
    assertType<
      Promise<ExplainResult> & { toSQL(): SqlPreview },
      ReadResult<number, { explain: true }>
    >()
    assertType<
      Promise<ExplainResult> & { toSQL(): SqlPreview },
      ReadResult<boolean, { explain: true }>
    >()
  })

  void it("the delegate exposes the read surface", () => {
    assertType<true, "findMany" extends keyof Users ? true : false>()
    assertType<true, "findUnique" extends keyof Users ? true : false>()
    assertType<true, "aggregate" extends keyof Users ? true : false>()
    assertType<true, "paginate" extends keyof Users ? true : false>()
    assertType<true, "cursor" extends keyof Users ? true : false>()
    assertType<Delegate<U>, Users>()
  })
})
