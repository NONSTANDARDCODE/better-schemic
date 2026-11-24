import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { s, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"
import type { InferWriteResult, UpsertDeltaFor } from "../../../src/surreal/orm/types/write"

// Bun AOT / DX — `upsertDelta` result inference without `as unknown as UpsertDeltaResult`.

const Customer = table("customer", {
  balance: s.number(),
  name: s.string(),
})
const _schemaDef = schema({ customers: Customer })
type D = Client<typeof _schemaDef>["customers"]

void describe("AOT — upsertDelta inference", () => {
  void it("ReturnType of the delegate method keeps the typed record (no cast)", () => {
    type R = Awaited<ReturnType<D["upsertDelta"]>>
    assertType<number, R["record"]["balance"]>()
  })

  void it("explicit public helpers spell the result type for a call site", () => {
    type R = UpsertDeltaFor<typeof _schemaDef, "customers", { data: { balance: number } }>
    assertType<number, R["record"]["balance"]>()
    type I = InferWriteResult<D["upsertDelta"], { data: { balance: number } }>
    assertType<number, I["record"]["balance"]>()
  })
})
