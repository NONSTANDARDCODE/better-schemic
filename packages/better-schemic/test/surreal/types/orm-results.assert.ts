// M0.3 — TYPE assertions for the result wrappers (`ThrowingResult` / `BatchResult` / `StatementResult`).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.

import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import type { OrmError } from "../../../src/surreal/orm/errors"
import type {
  BatchResult,
  NotFoundInfo,
  StatementResult,
  ThrowingResult,
} from "../../../src/surreal/orm/results"

void describe("ThrowingResult<T>", () => {
  void it("is a Promise<T | null> augmented with `.throw()` yielding T", () => {
    assertType<
      Promise<null | number> & {
        throw(factory?: (info: NotFoundInfo) => Error): Promise<number>
      },
      ThrowingResult<number>
    >()
  })
})

void describe("BatchResult<T>", () => {
  void it("carries count/data/skipped/statements (count optional with return:'none')", () => {
    assertType<
      {
        readonly count?: number
        readonly data?: readonly string[]
        readonly skipped?: number
        readonly statements: number
      },
      BatchResult<string>
    >()
  })
})

void describe("StatementResult<T>", () => {
  void it("carries result/status/time/error", () => {
    assertType<
      {
        readonly error?: OrmError
        readonly result: number[]
        readonly status: "ERR" | "OK"
        readonly time?: string
      },
      StatementResult<number[]>
    >()
  })
})
