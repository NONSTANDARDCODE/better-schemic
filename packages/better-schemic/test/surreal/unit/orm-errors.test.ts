const MAGIC_40 = 40
const MAGIC_403 = 403
const MAGIC_404 = 404
const MAGIC_409 = 409
const MAGIC_418 = 418
const MAGIC_42 = 42
// M0.3 — error normalization: real SDK `ServerError`s (kind + structured details + message
// heuristics) and arbitrary thrown values all land on the stable `OrmError` catalog, so
// `code`/predicates never depend on a message string at a call site.
import { describe, expect, test } from "bun:test"
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
} from "surrealdb"
import { z } from "zod"

import {
  isAssertionFailed,
  isCreateOnlyViolation,
  isNotFound,
  isOrmError,
  isPermissionDenied,
  isTenantViolation,
  isTransactionRollback,
  isUniqueViolation,
  isUnsupportedCapability,
  isValidationError,
  isWriteConflict,
  normalizeError,
  OrmError,
  type OrmErrorCode,
} from "../../../src/surreal/orm/errors"

const code = (e: unknown): OrmErrorCode => normalizeError(e).code
const norm = (e: unknown, ctx?: Parameters<typeof normalizeError>[1]): OrmError =>
  normalizeError(e, ctx)

/** A plain Error shaped like an SDK ServerError (so all the typed getters undefin them). */
const serverLike = (over: Record<string, unknown>): Error =>
  Object.assign(new Error((over.message as string | undefined) ?? "boom"), {
    kind: "Query",
    ...over,
  })

describe("normalizeError — SDK ServerError kinds", () => {
  test("AlreadyExists -> RecordAlreadyExists (table extracted from details)", () => {
    const e = new AlreadyExistsError({
      details: { details: { id: "user:u1" }, kind: "Record" },
      kind: "AlreadyExists",
      message: "Database record `user:u1` already exists",
    })
    const err = norm(e)
    expect(err.code).toBe("RecordAlreadyExists")
    expect(err.table).toBe("user")
    expect(err.status).toBe(MAGIC_409)
    expect(err.details).toEqual(e.details)
  })

  test("NotFound -> RecordNotFound", () => {
    const e = new NotFoundError({
      details: { details: { name: "r" }, kind: "Table" },
      kind: "NotFound",
      message: "The table 'r' does not exist",
    })
    expect(norm(e)).toMatchObject({ code: "RecordNotFound", table: "r" })
  })

  test("Validation + Parse detail -> ParseError; other details -> ValidationError", () => {
    const parse = new ValidationError({
      details: { kind: "Parse" },
      kind: "Validation",
      message: "Parse error: Unexpected token `PARALLEL`",
    })
    expect(code(parse)).toBe("ParseError")
    const invalid = new ValidationError({
      details: { kind: "InvalidRequest" },
      kind: "Validation",
      message: "Invalid request",
    })
    expect(code(invalid)).toBe("ValidationError")
  })

  test("Thrown -> AssertionFailed", () => {
    const e = new ThrownError({ kind: "Thrown", message: "assert failed" })
    expect(code(e)).toBe("AssertionFailed")
  })

  test("Query + Cancelled -> TransactionRollback; other Query kinds fall back to the message", () => {
    const cancelled = new QueryError({
      details: { kind: "Cancelled" },
      kind: "Query",
      message: "The query was not executed due to a cancelled transaction",
    })
    expect(code(cancelled)).toBe("TransactionRollback")

    // In an aborted transaction the server marks sibling statements as NotExecuted.
    const notExecuted = new QueryError({
      details: { kind: "NotExecuted" },
      kind: "Query",
      message: "The query was not executed due to a failed transaction",
    })
    expect(code(notExecuted)).toBe("TransactionRollback")

    const conflict = new QueryError({
      details: { kind: "NotExecuted" },
      kind: "Query",
      message: "There was a write conflict on this transaction",
    })
    expect(code(conflict)).toBe("WriteConflict")
  })

  test("Serialization -> SerializationFailure", () => {
    const e = new SerializationError({
      details: { kind: "Deserialization" },
      kind: "Serialization",
      message: "failed to deserialize",
    })
    expect(code(e)).toBe("SerializationFailure")
  })

  test("NotAllowed + Auth -> NotAuthenticated; otherwise PermissionDenied", () => {
    const auth = new NotAllowedError({
      details: { details: { kind: "TokenExpired" }, kind: "Auth" },
      kind: "NotAllowed",
      message: "token expired",
    })
    expect(code(auth)).toBe("NotAuthenticated")
    const scripting = new NotAllowedError({
      details: { kind: "Scripting" },
      kind: "NotAllowed",
      message: "Scripting is not allowed",
    })
    expect(code(scripting)).toBe("PermissionDenied")
  })

  test("Internal and unknown kinds -> DatabaseError", () => {
    expect(code(new ServerError({ kind: "Internal", message: "boom" }))).toBe("DatabaseError")
    expect(code(new ServerError({ kind: "Teapot", message: "418" }))).toBe("DatabaseError")
  })
})

describe("normalizeError — message heuristics on plain errors", () => {
  const cases: [string, OrmErrorCode][] = [
    ["Database record `x:y` already exists", "RecordAlreadyExists"],
    ["Couldn't coerce value for field `age`", "AssertionFailed"],
    ["Expected `string` but found `NONE`", "AssertionFailed"],
    [
      "There was a problem with the key-value store: does not support versioned queries",
      "UnsupportedCapability",
    ],
    ["You don't have permission to perform this action", "PermissionDenied"],
    ["Parse error: Unexpected token", "ParseError"],
    ["The query was not executed due to a cancelled transaction", "TransactionRollback"],
    ["The table 'ghost' does not exist", "RecordNotFound"],
    ["write conflict", "WriteConflict"],
    ["something entirely different", "DatabaseError"],
  ]
  cases.forEach(([message, expected]) => {
    test(`"${message.slice(0, MAGIC_40)}…" -> ${expected}`, () => {
      expect(code(new Error(message))).toBe(expected)
    })
  })
})

describe("normalizeError — zod, context, idempotency", () => {
  test("a ZodError becomes ValidationError with the issues preserved", () => {
    const result = z.object({ name: z.string() }).safeParse({})
    if (result.success) throw new Error("expected a failed parse")
    const err = norm(result.error)
    expect(err.code).toBe("ValidationError")
    expect(err.message).toContain('Validation failed at "name"')
    expect(err.details).toBe(result.error.issues)
  })

  test("context is attached, and an explicit context table wins over the extracted one", () => {
    const e = new AlreadyExistsError({
      details: { details: { id: "user:u1" }, kind: "Record" },
      kind: "AlreadyExists",
      message: "already exists",
    })
    const err = norm(e, {
      operation: "create",
      statementIndex: 3,
      surql: "CREATE user:u1 CONTENT $p",
      table: "override",
      vars: { p: {} },
    })
    expect(err).toMatchObject({
      operation: "create",
      statementIndex: 3,
      surql: "CREATE user:u1 CONTENT $p",
      table: "override",
      vars: { p: {} },
    })
  })

  test("normalizing a OrmError is idempotent (identity)", () => {
    const mine = new OrmError("ResultNotFound", "nope")
    expect(norm(mine)).toBe(mine)
  })

  test("non-Error throwables become DatabaseError", () => {
    const err = norm("boom")
    expect(err.code).toBe("DatabaseError")
    expect(err.message).toBe("boom")
    expect(err.details).toBe("boom")
  })

  test("isOrmError narrows", () => {
    expect(isOrmError(new OrmError("ParseError", "x"))).toBe(true)
    expect(isOrmError(new Error("x"))).toBe(false)
    expect(isOrmError("x")).toBe(false)
  })
})

describe("predicates", () => {
  test("match on the normalized code", () => {
    const already = new AlreadyExistsError({
      kind: "AlreadyExists",
      message: "already exists",
    })
    const thrown = new ThrownError({ kind: "Thrown", message: "assert" })
    const denied = new NotAllowedError({
      details: { kind: "Scripting" },
      kind: "NotAllowed",
      message: "nope",
    })
    const cancelled = new QueryError({
      details: { kind: "Cancelled" },
      kind: "Query",
      message: "cancelled",
    })
    const conflict = new QueryError({
      details: { kind: "NotExecuted" },
      kind: "Query",
      message: "write conflict",
    })
    const live = new ConfigurationError({
      details: { kind: "LiveQueryNotSupported" },
      kind: "Configuration",
      message: "live unsupported",
    })

    expect(isUniqueViolation(norm(already))).toBe(true)
    expect(isAssertionFailed(norm(thrown))).toBe(true)
    expect(isPermissionDenied(norm(denied))).toBe(true)
    expect(isTransactionRollback(norm(cancelled))).toBe(true)
    expect(isWriteConflict(norm(conflict))).toBe(true)
    expect(isUnsupportedCapability(norm(live))).toBe(true)
    expect(isValidationError(norm(thrown))).toBe(true)
    expect(isNotFound(norm(new OrmError("ResultNotFound", "x")))).toBe(true)
    expect(isNotFound(norm(already))).toBe(false)
  })

  test("isTenantViolation matches both tenant-scope codes (403)", () => {
    const required = new OrmError("TenantRequired", "no scope")
    const violation = new OrmError("TenantViolation", "forged")
    expect(isTenantViolation(required)).toBe(true)
    expect(isTenantViolation(violation)).toBe(true)
    expect(required.status).toBe(MAGIC_403)
    expect(violation.status).toBe(MAGIC_403)
  })

  test("isCreateOnlyViolation matches the append-only guard code (403)", () => {
    const violation = new OrmError("CreateOnlyViolation", "no updates")
    expect(isCreateOnlyViolation(violation)).toBe(true)
    expect(violation.status).toBe(MAGIC_403)
    expect(isCreateOnlyViolation(new Error("x"))).toBe(false)
  })

  test("predicates return false for unrelated values", () => {
    expect(isUniqueViolation(new Error("x"))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
    expect(isValidationError({})).toBe(false)
    expect(isTenantViolation(new Error("x"))).toBe(false)
    expect(isCreateOnlyViolation(undefined)).toBe(false)
  })
})

describe("normalizeError — refineCode detail flags (isX getters false)", () => {
  test("detail Parse / Cancelled / NotExecuted", () => {
    expect(code(serverLike({ details: { kind: "Parse" } }))).toBe("ParseError")
    expect(code(serverLike({ details: { kind: "Cancelled" } }))).toBe("TransactionRollback")
    expect(code(serverLike({ details: { kind: "NotExecuted" } }))).toBe("TransactionRollback")
  })

  test("NotExecuted with a non-DatabaseError message refines by message", () => {
    expect(
      code(
        serverLike({
          details: { kind: "NotExecuted" },
          message: "write conflict",
        }),
      ),
    ).toBe("WriteConflict")
  })

  test("TimedOut (flag and detail) -> DatabaseError", () => {
    expect(code(serverLike({ isTimedOut: true }))).toBe("DatabaseError")
    expect(code(serverLike({ details: { kind: "TimedOut" } }))).toBe("DatabaseError")
  })

  test("table extraction: Table detail, recordId, and tableName", () => {
    expect(
      norm(serverLike({ details: { details: { name: "widget" }, kind: "Table" } })).table,
    ).toBe("widget")
    expect(norm(serverLike({ recordId: "user:u1" })).table).toBe("user")
    expect(norm(serverLike({ tableName: "account" })).table).toBe("account")
  })
})

describe("normalizeError — context passthrough and non-Error shapes", () => {
  test("OrmError.from delegates to normalizeError", () => {
    const err = OrmError.from(new Error("already exists"), {
      operation: "create",
    })
    expect(err.code).toBe("RecordAlreadyExists")
    expect(err.operation).toBe("create")
  })

  test("a context details/cause wins over the payload's", () => {
    const payload = Object.assign(new Error("x"), {
      cause: new Error("inner"),
      details: { kind: "Other" },
      kind: "Query",
    })
    const err = norm(payload, { cause: "ctx", details: { custom: 1 } })
    expect(err.details).toEqual({ custom: 1 })
    expect(err.cause).toBe("ctx")
  })

  test("an issues payload with no message falls back to the payload message", () => {
    const err = norm({ issues: [{}], message: "raw issue message" })
    expect(err.code).toBe("ValidationError")
    expect(err.message).toBe("raw issue message")
  })

  test("a non-string, non-Error throwable is stringified", () => {
    expect(norm(MAGIC_42).message).toBe("Non-Error thrown: 42")
  })

  test("an explicit status wins over the catalog default", () => {
    expect(new OrmError("ResultNotFound", "x", { status: 418 }).status).toBe(MAGIC_418)
    expect(new OrmError("ResultNotFound", "x").status).toBe(MAGIC_404)
  })

  test("from() with no context uses the empty default", () => {
    expect(OrmError.from(new Error("boom")).code).toBe("DatabaseError")
  })

  test("null and message-less issues payloads are DatabaseError", () => {
    expect(norm(null).code).toBe("DatabaseError")
    expect(norm({ issues: [] }).code).toBe("DatabaseError")
  })

  test("empty tableName / recordId and non-string detail ids fall through", () => {
    expect(norm(serverLike({ tableName: "" })).table).toBeUndefined()
    expect(
      norm(serverLike({ details: { details: { name: 5 }, kind: "Table" } })).table,
    ).toBeUndefined()
    expect(
      norm(serverLike({ details: { details: { id: 5 }, kind: "Record" } })).table,
    ).toBeUndefined()
    expect(norm(serverLike({ recordId: "" })).table).toBeUndefined()
  })

  test("issues payload keeps an explicit context.details", () => {
    const err = norm({ issues: [{}], message: "m" }, { details: { d: 1 } })
    expect(err.details).toEqual({ d: 1 })
  })

  test("a server error's own cause flows through", () => {
    const err = norm(serverLike({ cause: new Error("inner") }))
    expect(err.cause).toBeInstanceOf(Error)
  })

  test("a non-Error throwable keeps an explicit context.details", () => {
    expect(norm(MAGIC_42, { details: { d: 1 } }).details).toEqual({ d: 1 })
  })

  test("isOrmError rejects a same-named Error without a code", () => {
    const fake = Object.assign(new Error("x"), { name: "OrmError" })
    expect(isOrmError(fake)).toBe(false)
  })
})
