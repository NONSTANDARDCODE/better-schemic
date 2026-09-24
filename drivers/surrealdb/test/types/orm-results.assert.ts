// M0.3 — TYPE assertions for the result wrappers (`ThrowingResult` / `BatchResult` / `StatementResult`).
// Run under node/tsx (NOT bun): `bun run --cwd drivers/surrealdb test:types`.
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { BetterSchemicError } from "../../src/orm/errors";
import type {
  BatchResult,
  NotFoundInfo,
  StatementResult,
  ThrowingResult,
} from "../../src/orm/results";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

describe("ThrowingResult<T>", () => {
  it("is a Promise<T | null> augmented with `.throw()` yielding T", () => {
    attest<
      Promise<number | null> & {
        throw(factory?: (info: NotFoundInfo) => Error): Promise<number>;
      },
      ThrowingResult<number>
    >();
  });
});

describe("BatchResult<T>", () => {
  it("carries count/data/skipped/statements (count optional with return:'none')", () => {
    attest<
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
    attest<
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
