// M0.3 — TYPE assertions for the result wrappers (`ThrowingResult` / `BatchResult` / `StatementResult`).
// Type-checked by `bun check` as part of `typecheck` — no runtime: see docs/TYPE-PERF-TESTING.md.
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";
import type { BetterSchemicError } from "../../src/orm/errors";
import type {
  BatchResult,
  NotFoundInfo,
  StatementResult,
  ThrowingResult,
} from "../../src/orm/results";


describe("ThrowingResult<T>", () => {
  it("is a Promise<T | null> augmented with `.throw()` yielding T", () => {
    assertType<
      Promise<number | null> & {
        throw(factory?: (info: NotFoundInfo) => Error): Promise<number>;
      },
      ThrowingResult<number>
    >();
  });
});

describe("BatchResult<T>", () => {
  it("carries count/data/skipped/statements (count optional with return:'none')", () => {
    assertType<
      {
        readonly count?: number;
        readonly data?: readonly string[];
        readonly skipped?: number;
        readonly statements: number;
      },
      BatchResult<string>
    >();
  });
});

describe("StatementResult<T>", () => {
  it("carries result/status/time/error", () => {
    assertType<
      {
        readonly result: number[];
        readonly status: "OK" | "ERR";
        readonly time?: string;
        readonly error?: BetterSchemicError;
      },
      StatementResult<number[]>
    >();
  });
});
