// M1.8 — TYPE assertions for the read surface: `where`, `select`/`omit`/`value`/`only`/`split`
// result shapes, the throwing reads, the aggregate/count/paginate/cursor envelopes, and `explain`.
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import type { Surql } from "../../src/frag";
import { defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import type { ExplainResult, ThrowingResult } from "../../src/orm/results";
import { defineSchema } from "../../src/orm/schema";
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
} from "../../src/orm/types/select";
import type { Where } from "../../src/orm/types/where";
import type { App } from "../../src/pure";


const User = defineTable("user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
  at: s.datetime(),
  tags: s.array(s.string()),
  address: s.object({ city: s.string(), country: s.string() }),
});
const schema = defineSchema({ users: User });
type U = typeof User;
type Row = App<U>;
type C = Client<typeof schema>;
type Users = C["users"];

describe("where — family-aware filters and paths", () => {
  it("pure values, operators and paths typecheck", () => {
    assertType<
      true,
      {
        active: true;
        age: { gte: 18; lt: 65 };
        name: { startsWith: "A" };
        tags: { containsAny: ["db"] };
        "address.city": "SP";
        "contacts[*].type": "email";
        OR: [{ age: 1 }, { age: 2 }];
        NOT: { active: false };
      } extends Where<U>
        ? true
        : false
    >();
  });

  it("rejects wrong-family operators and wrong value types", () => {
    assertType<false, { age: { contains: "x" } } extends Where<U> ? true : false>();
    assertType<
      false,
      { name: { containsAll: ["a"] } } extends Where<U> ? true : false
    >();
    assertType<false, { age: "old" } extends Where<U> ? true : false>();
    assertType<
      false,
      { active: { between: [1, 2] } } extends Where<U> ? true : false
    >();
  });

  it("a typo (not a path) is rejected by excess-property checking", () => {
    // @ts-expect-error — "nmae" is neither a field nor a dotted path
    const bad: Where<U> = { nmae: "x" };
    void bad;
  });

  it("record ids accept strings; the logical combinators recurse", () => {
    assertType<true, { id: "user:aeon" } extends Where<U> ? true : false>();
    assertType<
      true,
      { OR: [{ NOT: { id: "user:a" } }, { age: 1 }] } extends Where<U>
        ? true
        : false
    >();
  });
});

describe("select — result shapes", () => {
  it("no projection is the decoded row", () => {
    assertType<Row, ResultOf<U, Record<string, never>>>();
  });

  it("field lists, paths (nested), aliases and fragments", () => {
    assertType<
      {
        id: Row["id"];
        address: { city: string };
        city: string;
        name: string;
      },
      ResultOf<
        U,
        {
          select: {
            id: true;
            "address.city": true;
            city: "address.city";
            name: true;
          };
        }
      >
    >();
    assertType<
      { id: Row["id"]; name: string },
      ResultOf<U, { select: ["id", "name"] }>
    >();
    assertType<
      { bump: number },
      ResultOf<U, { select: { bump: Surql<[number]> } }>
    >();
  });

  it("nested sub-objects and star + expression", () => {
    assertType<
      { address: { city: string; country: string } },
      ResultOf<U, { select: { address: { city: true; country: true } } }>
    >();
    assertType<
      Row & { score: number },
      ResultOf<U, { select: { "*": true; score: Surql<[number]> } }>
    >();
  });

  it("omit removes keys; value unwraps; only unwraps the page", () => {
    assertType<Omit<Row, "age">, ResultOf<U, { omit: ["age"] }>>();
    assertType<string, ResultOf<U, { select: { name: true }; value: true }>>();
    // `only` unwraps the PAGE (see FindManyResult) — ResultOf stays the row shape.
    assertType<Row, ResultOf<U, { only: true }>>();
  });

  it("split changes the field to its element type", () => {
    assertType<
      Omit<Row, "tags"> & { tags: string },
      ResultOf<U, { split: "tags" }>
    >();
    assertType<
      { name: string; tags: string },
      ResultOf<U, { select: { name: true; tags: true }; split: "tags" }>
    >();
  });
});

describe("read envelopes", () => {
  it("findMany is a lazy promise with .explain(); explain:true yields the plan", () => {
    assertType<
      Promise<Row[]> & { explain(): Promise<ExplainResult> },
      FindManyResult<U, Record<string, never>>
    >();
    assertType<Promise<ExplainResult>, FindManyResult<U, { explain: true }>>();
  });

  it("findFirst/findOne/findUnique are ThrowingResults with .explain()", () => {
    assertType<
      ThrowingResult<Row> & { explain(): Promise<ExplainResult> },
      FindOneResult<U, Record<string, never>>
    >();
    assertType<
      ThrowingResult<Row> & { explain(): Promise<ExplainResult> },
      FindUniqueResult<U, { where: { id: "user:a" } }>
    >();
  });

  it("count/exists/aggregate/paginate/cursor carry their payloads", () => {
    assertType<
      Promise<number> & { explain(): Promise<ExplainResult> },
      ReadResult<number, Record<string, never>>
    >();
    assertType<
      Promise<boolean> & { explain(): Promise<ExplainResult> },
      ReadResult<boolean, Record<string, never>>
    >();
    assertType<
      { _count: number; avgAge: number; names: string[] },
      AggregateShape<
        U,
        { _count: true; avgAge: { avg: "age" }; names: { collect: "name" } }
      >
    >();
    assertType<
      PaginationResult<Row>,
      Awaited<ReadResult<PaginationResult<Row>, Record<string, never>>>
    >();
    assertType<
      CursorResult<Row>,
      Awaited<ReadResult<CursorResult<Row>, Record<string, never>>>
    >();
  });

  it("cursor: select may omit the orderBy fields; value/only/start are off-surface", () => {
    assertType<
      { name: string },
      ResultOf<
        U,
        {
          select: { name: true };
          orderBy: [{ age: "desc" }, { id: "asc" }];
        }
      >
    >();
    // @ts-expect-error — a VALUE projection is a scalar, not a keyset row
    const withValue: CursorArgs<U> = { limit: 1, value: true };
    // @ts-expect-error — a cursor page is many rows
    const withOnly: CursorArgs<U> = { limit: 1, only: true };
    // @ts-expect-error — offsets are `paginate`'s job
    const withStart: CursorArgs<U> = { limit: 1, start: 5 };
    void withValue;
    void withOnly;
    void withStart;
  });

  it("aggregate shapes dispatch per operator", () => {
    assertType<
      {
        total: number;
        first: Date;
        last: Date;
        tagSets: string[][];
        tags: string[];
        upper: string;
      },
      AggregateShape<
        U,
        {
          total: { sum: "age" };
          first: { min: "at" };
          last: { max: "at" };
          tagSets: { collect: "tags" };
          tags: { distinct: "name" };
          upper: Surql<[string]>;
        }
      >
    >();
  });

  it("explain: true flips count/exists to the plan", () => {
    assertType<Promise<ExplainResult>, ReadResult<number, { explain: true }>>();
    assertType<Promise<ExplainResult>, ReadResult<boolean, { explain: true }>>();
  });

  it("the delegate exposes the read surface", () => {
    assertType<true, "findMany" extends keyof Users ? true : false>();
    assertType<true, "findUnique" extends keyof Users ? true : false>();
    assertType<true, "aggregate" extends keyof Users ? true : false>();
    assertType<true, "paginate" extends keyof Users ? true : false>();
    assertType<true, "cursor" extends keyof Users ? true : false>();
    assertType<Delegate<U>, Users>();
  });
});
