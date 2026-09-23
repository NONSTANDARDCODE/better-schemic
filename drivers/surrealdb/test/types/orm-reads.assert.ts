// M1.8 — TYPE assertions for the read surface: `where`, `select`/`omit`/`value`/`only`/`split`
// result shapes, the throwing reads, the aggregate/count/paginate/cursor envelopes, and `explain`.
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { Surql } from "../../src/frag";
import { defineTable, s } from "../../src/index";
import type { Client } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import type { ExplainResult, ThrowingResult } from "../../src/orm/results";
import { defineSchema } from "../../src/orm/schema";
import type {
  AggregateShape,
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
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

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
    attest<
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
    attest<false, { age: { contains: "x" } } extends Where<U> ? true : false>();
    attest<
      false,
      { name: { containsAll: ["a"] } } extends Where<U> ? true : false
    >();
    attest<false, { age: "old" } extends Where<U> ? true : false>();
    attest<
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
    attest<true, { id: "user:aeon" } extends Where<U> ? true : false>();
    attest<
      true,
      { OR: [{ NOT: { id: "user:a" } }, { age: 1 }] } extends Where<U>
        ? true
        : false
    >();
  });
});

describe("select — result shapes", () => {
  it("no projection is the decoded row", () => {
    attest<Row, ResultOf<U, Record<string, never>>>();
  });

  it("field lists, paths (nested), aliases and fragments", () => {
    attest<
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
    attest<
      { id: Row["id"]; name: string },
      ResultOf<U, { select: ["id", "name"] }>
    >();
    attest<
      { bump: number },
      ResultOf<U, { select: { bump: Surql<[number]> } }>
    >();
  });

  it("nested sub-objects and star + expression", () => {
    attest<
      { address: { city: string; country: string } },
      ResultOf<U, { select: { address: { city: true; country: true } } }>
    >();
    attest<
      Row & { score: number },
      ResultOf<U, { select: { "*": true; score: Surql<[number]> } }>
    >();
  });

  it("omit removes keys; value unwraps; only unwraps the page", () => {
    attest<Omit<Row, "age">, ResultOf<U, { omit: ["age"] }>>();
    attest<string, ResultOf<U, { select: { name: true }; value: true }>>();
    // `only` unwraps the PAGE (see FindManyResult) — ResultOf stays the row shape.
    attest<Row, ResultOf<U, { only: true }>>();
  });

  it("split changes the field to its element type", () => {
    attest<
      Omit<Row, "tags"> & { tags: string },
      ResultOf<U, { split: "tags" }>
    >();
    attest<
      { name: string; tags: string },
      ResultOf<U, { select: { name: true; tags: true }; split: "tags" }>
    >();
  });
});

describe("read envelopes", () => {
  it("findMany is a lazy promise with .explain(); explain:true yields the plan", () => {
    attest<
      Promise<Row[]> & { explain(): Promise<ExplainResult> },
      FindManyResult<U, Record<string, never>>
    >();
    attest<Promise<ExplainResult>, FindManyResult<U, { explain: true }>>();
  });

  it("findFirst/findOne/findUnique are ThrowingResults with .explain()", () => {
    attest<
      ThrowingResult<Row> & { explain(): Promise<ExplainResult> },
      FindOneResult<U, Record<string, never>>
    >();
    attest<
      ThrowingResult<Row> & { explain(): Promise<ExplainResult> },
      FindUniqueResult<U, { where: { id: "user:a" } }>
    >();
  });

  it("count/exists/aggregate/paginate/cursor carry their payloads", () => {
    attest<
      Promise<number> & { explain(): Promise<ExplainResult> },
      ReadResult<number, Record<string, never>>
    >();
    attest<
      Promise<boolean> & { explain(): Promise<ExplainResult> },
      ReadResult<boolean, Record<string, never>>
    >();
    attest<
      { _count: number; avgAge: number; names: string[] },
      AggregateShape<
        U,
        { _count: true; avgAge: { avg: "age" }; names: { collect: "name" } }
      >
    >();
    attest<
      PaginationResult<Row>,
      Awaited<ReadResult<PaginationResult<Row>, Record<string, never>>>
    >();
    attest<
      CursorResult<Row>,
      Awaited<ReadResult<CursorResult<Row>, Record<string, never>>>
    >();
  });

  it("aggregate shapes dispatch per operator", () => {
    attest<
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
    attest<Promise<ExplainResult>, ReadResult<number, { explain: true }>>();
    attest<Promise<ExplainResult>, ReadResult<boolean, { explain: true }>>();
  });

  it("the delegate exposes the read surface", () => {
    attest<true, "findMany" extends keyof Users ? true : false>();
    attest<true, "findUnique" extends keyof Users ? true : false>();
    attest<true, "aggregate" extends keyof Users ? true : false>();
    attest<true, "paginate" extends keyof Users ? true : false>();
    attest<true, "cursor" extends keyof Users ? true : false>();
    attest<Delegate<U>, Users>();
  });
});
