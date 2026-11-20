// Bun AOT / DX — `upsertDelta` result inference without `as unknown as UpsertDeltaResult`.
import { describe, it } from "node:test";
import { assertType } from "../../../../../scripts/type-assert";
import { s, table } from "../../../src/surreal";
import type { Client } from "../../../src/surreal/orm/client";
import { schema } from "../../../src/surreal/orm/schema";
import type {
  InferWriteResult,
  UpsertDeltaFor,
} from "../../../src/surreal/orm/types/write";

const Customer = table("customer", {
  balance: s.number(),
  name: s.string(),
});
const schemaDef = schema({ customers: Customer });
type D = Client<typeof schemaDef>["customers"];

describe("AOT — upsertDelta inference", () => {
  it("ReturnType of the delegate method keeps the typed record (no cast)", () => {
    type R = Awaited<ReturnType<D["upsertDelta"]>>;
    assertType<number, R["record"]["balance"]>();
  });

  it("explicit public helpers spell the result type for a call site", () => {
    type R = UpsertDeltaFor<
      typeof schemaDef,
      "customers",
      { data: { balance: number } }
    >;
    assertType<number, R["record"]["balance"]>();
    type I = InferWriteResult<D["upsertDelta"], { data: { balance: number } }>;
    assertType<number, I["record"]["balance"]>();
  });
});
