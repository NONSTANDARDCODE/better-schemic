// M0.3 — error normalization: real SDK `ServerError`s (kind + structured details + message
// heuristics) and arbitrary thrown values all land on the stable `BetterSchemicError` catalog, so
// `code`/predicates never depend on a message string at a call site.
import { describe, expect, test } from "bun:test";
import {
  AlreadyExistsError,
  ConfigurationError,
  NotAllowedError,
  NotFoundError,
  QueryError,
  SerializationError,
  ServerError,
  ThrownError,
  ValidationError,
} from "surrealdb";
import { z } from "zod";
import {
  BetterSchemicError,
  isAssertionFailed,
  isBetterSchemicError,
  isNotFound,
  isPermissionDenied,
  isTransactionRollback,
  isUniqueViolation,
  isUnsupportedCapability,
  isValidationError,
  isWriteConflict,
  normalizeError,
} from "../../src/orm/errors";

const code = (e: unknown) => normalizeError(e).code;
const norm = (e: unknown, ctx?: Parameters<typeof normalizeError>[1]) =>
  normalizeError(e, ctx);

describe("normalizeError — SDK ServerError kinds", () => {
  test("AlreadyExists -> RecordAlreadyExists (table extracted from details)", () => {
    const e = new AlreadyExistsError({
      kind: "AlreadyExists",
      message: "Database record `user:u1` already exists",
      details: { kind: "Record", details: { id: "user:u1" } },
    });
    const err = norm(e);
    expect(err.code).toBe("RecordAlreadyExists");
    expect(err.table).toBe("user");
    expect(err.status).toBe(409);
    expect(err.details).toEqual(e.details);
  });

  test("NotFound -> RecordNotFound", () => {
    const e = new NotFoundError({
      kind: "NotFound",
      message: "The table 'r' does not exist",
      details: { kind: "Table", details: { name: "r" } },
    });
    expect(norm(e)).toMatchObject({ code: "RecordNotFound", table: "r" });
  });

  test("Validation + Parse detail -> ParseError; other details -> ValidationError", () => {
    const parse = new ValidationError({
      kind: "Validation",
      message: "Parse error: Unexpected token `PARALLEL`",
      details: { kind: "Parse" },
    });
    expect(code(parse)).toBe("ParseError");
    const invalid = new ValidationError({
      kind: "Validation",
      message: "Invalid request",
      details: { kind: "InvalidRequest" },
    });
    expect(code(invalid)).toBe("ValidationError");
  });

  test("Thrown -> AssertionFailed", () => {
    const e = new ThrownError({ kind: "Thrown", message: "assert failed" });
    expect(code(e)).toBe("AssertionFailed");
  });

  test("Query + Cancelled -> TransactionRollback; other Query kinds fall back to the message", () => {
    const cancelled = new QueryError({
      kind: "Query",
      message: "The query was not executed due to a cancelled transaction",
      details: { kind: "Cancelled" },
    });
    expect(code(cancelled)).toBe("TransactionRollback");

    // In an aborted transaction the server marks sibling statements as NotExecuted.
    const notExecuted = new QueryError({
      kind: "Query",
      message: "The query was not executed due to a failed transaction",
      details: { kind: "NotExecuted" },
    });
    expect(code(notExecuted)).toBe("TransactionRollback");

    const conflict = new QueryError({
      kind: "Query",
      message: "There was a write conflict on this transaction",
      details: { kind: "NotExecuted" },
    });
    expect(code(conflict)).toBe("WriteConflict");
  });

  test("Serialization -> SerializationFailure", () => {
    const e = new SerializationError({
      kind: "Serialization",
      message: "failed to deserialize",
      details: { kind: "Deserialization" },
    });
    expect(code(e)).toBe("SerializationFailure");
  });

  test("NotAllowed + Auth -> NotAuthenticated; otherwise PermissionDenied", () => {
    const auth = new NotAllowedError({
      kind: "NotAllowed",
      message: "token expired",
      details: { kind: "Auth", details: { kind: "TokenExpired" } },
    });
    expect(code(auth)).toBe("NotAuthenticated");
    const scripting = new NotAllowedError({
      kind: "NotAllowed",
      message: "Scripting is not allowed",
      details: { kind: "Scripting" },
    });
    expect(code(scripting)).toBe("PermissionDenied");
  });

  test("Configuration + LiveQueryNotSupported -> LiveQueryUnsupported", () => {
    const e = new ConfigurationError({
      kind: "Configuration",
      message: "Live queries are not supported",
      details: { kind: "LiveQueryNotSupported" },
    });
    expect(code(e)).toBe("LiveQueryUnsupported");
  });

  test("Internal and unknown kinds -> DatabaseError", () => {
    expect(code(new ServerError({ kind: "Internal", message: "boom" }))).toBe(
      "DatabaseError",
    );
    expect(code(new ServerError({ kind: "Teapot", message: "418" }))).toBe(
      "DatabaseError",
    );
  });
});

describe("normalizeError — message heuristics on plain errors", () => {
  const cases: [string, string][] = [
    ["Database record `x:y` already exists", "RecordAlreadyExists"],
    ["Couldn't coerce value for field `age`", "AssertionFailed"],
    ["Expected `string` but found `NONE`", "AssertionFailed"],
    [
      "There was a problem with the key-value store: does not support versioned queries",
      "UnsupportedCapability",
    ],
    ["You don't have permission to perform this action", "PermissionDenied"],
    ["Parse error: Unexpected token", "ParseError"],
    [
      "The query was not executed due to a cancelled transaction",
      "TransactionRollback",
    ],
    ["The table 'ghost' does not exist", "RecordNotFound"],
    ["write conflict", "WriteConflict"],
    ["something entirely different", "DatabaseError"],
  ];
  for (const [message, expected] of cases)
    test(`"${message.slice(0, 40)}…" -> ${expected}`, () => {
      expect(code(new Error(message))).toBe(expected);
    });
});

describe("normalizeError — zod, context, idempotency", () => {
  test("a ZodError becomes ValidationError with the issues preserved", () => {
    const result = z.object({ name: z.string() }).safeParse({});
    if (result.success) throw new Error("expected a failed parse");
    const err = norm(result.error);
    expect(err.code).toBe("ValidationError");
    expect(err.message).toContain('Validation failed at "name"');
    expect(err.details).toBe(result.error.issues);
  });

  test("context is attached, and an explicit context table wins over the extracted one", () => {
    const e = new AlreadyExistsError({
      kind: "AlreadyExists",
      message: "already exists",
      details: { kind: "Record", details: { id: "user:u1" } },
    });
    const err = norm(e, {
      table: "override",
      operation: "create",
      statementIndex: 3,
      surql: "CREATE user:u1 CONTENT $p",
      vars: { p: {} },
    });
    expect(err).toMatchObject({
      table: "override",
      operation: "create",
      statementIndex: 3,
      surql: "CREATE user:u1 CONTENT $p",
      vars: { p: {} },
    });
  });

  test("normalizing a BetterSchemicError is idempotent (identity)", () => {
    const mine = new BetterSchemicError("ResultNotFound", "nope");
    expect(norm(mine)).toBe(mine);
  });

  test("non-Error throwables become DatabaseError", () => {
    const err = norm("boom");
    expect(err.code).toBe("DatabaseError");
    expect(err.message).toBe("boom");
    expect(err.details).toBe("boom");
  });

  test("isBetterSchemicError narrows", () => {
    expect(
      isBetterSchemicError(new BetterSchemicError("ParseError", "x")),
    ).toBe(true);
    expect(isBetterSchemicError(new Error("x"))).toBe(false);
    expect(isBetterSchemicError("x")).toBe(false);
  });
});

describe("predicates", () => {
  test("match on the normalized code", () => {
    const already = new AlreadyExistsError({
      kind: "AlreadyExists",
      message: "already exists",
    });
    const thrown = new ThrownError({ kind: "Thrown", message: "assert" });
    const denied = new NotAllowedError({
      kind: "NotAllowed",
      message: "nope",
      details: { kind: "Scripting" },
    });
    const cancelled = new QueryError({
      kind: "Query",
      message: "cancelled",
      details: { kind: "Cancelled" },
    });
    const conflict = new QueryError({
      kind: "Query",
      message: "write conflict",
      details: { kind: "NotExecuted" },
    });
    const live = new ConfigurationError({
      kind: "Configuration",
      message: "live unsupported",
      details: { kind: "LiveQueryNotSupported" },
    });

    expect(isUniqueViolation(norm(already))).toBe(true);
    expect(isAssertionFailed(norm(thrown))).toBe(true);
    expect(isPermissionDenied(norm(denied))).toBe(true);
    expect(isTransactionRollback(norm(cancelled))).toBe(true);
    expect(isWriteConflict(norm(conflict))).toBe(true);
    expect(isUnsupportedCapability(norm(live))).toBe(true);
    expect(isValidationError(norm(thrown))).toBe(true);
    expect(
      isNotFound(norm(new BetterSchemicError("ResultNotFound", "x"))),
    ).toBe(true);
    expect(isNotFound(norm(already))).toBe(false);
  });

  test("predicates return false for unrelated values", () => {
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(isValidationError({})).toBe(false);
  });
});
