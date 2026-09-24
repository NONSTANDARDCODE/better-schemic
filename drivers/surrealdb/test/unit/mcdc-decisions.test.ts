// Tier 2 — real MC/DC (unique-cause) proofs for the error predicates. Tier 1 already proves each
// operand is seen true AND false; `describeMcdc` proves each operand INDEPENDENTLY flips the decision
// (differ only in that operand → outcome changes). A redundant/masked operand fails a NAMED test even
// at 100% branch coverage. The inputs are synthesized from the condition assignment, then fed to the
// REAL predicate, so the proof tracks the shipped logic.
import { describeMcdc } from "@better-schemic/core/testing";
import { BetterSchemicError } from "../../src/orm/errors";
import {
  isNotFound,
  isUnsupportedCapability,
  isValidationError,
} from "../../src/orm/errors";

const errOf = (code: string | undefined): unknown =>
  code === undefined ? {} : new BetterSchemicError(code as never, "x");

describeMcdc({
  label: "isNotFound",
  conditions: ["isError", "ResultNotFound", "RecordNotFound"],
  evaluate: ({ isError, ResultNotFound, RecordNotFound }) =>
    isNotFound(
      errOf(
        !isError
          ? undefined
          : ResultNotFound
            ? "ResultNotFound"
            : RecordNotFound
              ? "RecordNotFound"
              : "Other",
      ),
    ),
});

describeMcdc({
  label: "isValidationError",
  conditions: ["ValidationError", "AssertionFailed", "ParseError"],
  evaluate: ({ ValidationError, AssertionFailed, ParseError }) =>
    isValidationError(
      errOf(
        ValidationError
          ? "ValidationError"
          : AssertionFailed
            ? "AssertionFailed"
            : ParseError
              ? "ParseError"
              : "Other",
      ),
    ),
});

describeMcdc({
  label: "isUnsupportedCapability",
  conditions: ["UnsupportedCapability", "LiveQueryUnsupported"],
  evaluate: ({ UnsupportedCapability, LiveQueryUnsupported }) =>
    isUnsupportedCapability(
      errOf(
        UnsupportedCapability
          ? "UnsupportedCapability"
          : LiveQueryUnsupported
            ? "LiveQueryUnsupported"
            : "Other",
      ),
    ),
});
