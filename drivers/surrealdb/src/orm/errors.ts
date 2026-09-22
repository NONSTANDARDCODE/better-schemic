/**
 * The structured error every `/orm` surface throws — one class, a stable {@link BetterSchemicErrorCode}
 * catalog, and the request context that makes a failure actionable (`table`/`field`/`operation`/
 * `statementIndex`/`surql`/`vars`).
 *
 * M0.2 ships the class + the catalog (so `defineSchema`/`SchemaIndex` can fail with `SchemaInvalid`);
 * normalization of SDK/server errors and the `is*` predicates land in M0.3 (`errors.ts` grows, the
 * constructor contract does not change).
 */

/** Every structured failure code the `/orm` layer can report. */
export type BetterSchemicErrorCode =
  // results
  | "ResultNotFound"
  // server / transport
  | "DatabaseError"
  | "ParseError"
  | "AssertionFailed"
  | "RecordAlreadyExists"
  | "RecordNotFound"
  | "WriteConflict"
  | "SerializationFailure"
  | "PermissionDenied"
  | "NotAuthenticated"
  // client-side validation
  | "ValidationError"
  | "UnsafeDisabled"
  | "UnsupportedCapability"
  | "UnknownField"
  | "SchemaInvalid"
  // live
  | "LiveQueryUnsupported"
  | "ClauseNotSupportedInLive"
  | "LiveInTransaction"
  // transactions
  | "TransactionAlreadyActive"
  | "TransactionRollback"
  // API contract
  | "CursorDirectionConflict"
  | "CursorTiebreakerRequired"
  | "UniqueTargetRequired"
  | "ReturnNotSupported"
  | "HavingUnsupported"
  | "ClauseNotSupported"
  | "RepositoryNotFound"
  | "PluginError"
  | "UnsafeMutation";

/** HTTP-like default status per code — a server/SDK status wins when present. */
const DEFAULT_STATUS: Record<BetterSchemicErrorCode, number> = {
  ResultNotFound: 404,
  DatabaseError: 500,
  ParseError: 400,
  AssertionFailed: 400,
  RecordAlreadyExists: 409,
  RecordNotFound: 404,
  WriteConflict: 409,
  SerializationFailure: 409,
  PermissionDenied: 403,
  NotAuthenticated: 401,
  ValidationError: 400,
  UnsafeDisabled: 403,
  UnsupportedCapability: 501,
  UnknownField: 400,
  SchemaInvalid: 500,
  LiveQueryUnsupported: 501,
  ClauseNotSupportedInLive: 400,
  LiveInTransaction: 409,
  TransactionAlreadyActive: 409,
  TransactionRollback: 409,
  CursorDirectionConflict: 400,
  CursorTiebreakerRequired: 400,
  UniqueTargetRequired: 400,
  ReturnNotSupported: 400,
  HavingUnsupported: 400,
  ClauseNotSupported: 400,
  RepositoryNotFound: 404,
  PluginError: 500,
  UnsafeMutation: 403,
};

/** The context an operation attaches to a {@link BetterSchemicError}. */
export interface BetterSchemicErrorOptions {
  /** HTTP-like status — defaults per {@link BetterSchemicErrorCode}. */
  status?: number;
  /** The table/edge the operation targeted (physical name). */
  table?: string;
  /** The field involved, when the failure is field-scoped. */
  field?: string;
  /** The delegate operation, e.g. `"findMany"` / `"create"`. */
  operation?: string;
  /** Index of the failing statement inside a multi-statement batch. */
  statementIndex?: number;
  /** The SurrealQL emitted for the failing statement (values never inlined). */
  surql?: string;
  /** The bound variables of the failing statement (omitted unless `debug: true`). */
  vars?: Record<string, unknown>;
  /** The raw server/SDK payload, for debugging. */
  details?: unknown;
  /** The underlying error. */
  cause?: unknown;
}

/**
 * The one error type the ORM throws. `code` is the stable discriminant (never a message match);
 * `status` is HTTP-like for API layers; the context fields are populated as the operation unwinds.
 */
export class BetterSchemicError extends Error {
  readonly code: BetterSchemicErrorCode;
  readonly status: number;
  readonly table?: string;
  readonly field?: string;
  readonly operation?: string;
  readonly statementIndex?: number;
  readonly surql?: string;
  readonly vars?: Record<string, unknown>;
  readonly details?: unknown;

  constructor(
    code: BetterSchemicErrorCode,
    message: string,
    options: BetterSchemicErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BetterSchemicError";
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.table = options.table;
    this.field = options.field;
    this.operation = options.operation;
    this.statementIndex = options.statementIndex;
    this.surql = options.surql;
    this.vars = options.vars;
    this.details = options.details;
  }

  /**
   * Normalize ANY thrown value into a {@link BetterSchemicError}: SDK `ServerError`s (by `kind` +
   * structured details + message heuristics), Zod validation errors, plain `Error`s, and non-Error
   * throwables. Idempotent — an existing `BetterSchemicError` is returned unchanged.
   *
   * ```ts
   * try { await conn.query(sql, vars); }
   * catch (e) { throw BetterSchemicError.from(e, { table, operation: "findMany", surql }); }
   * ```
   */
  static from(
    error: unknown,
    context: BetterSchemicErrorOptions = {},
  ): BetterSchemicError {
    return normalizeError(error, context);
  }
}

/** The structural slice of an SDK `ServerError` the normalizer reads (no runtime import needed). */
interface ServerErrorLike {
  kind: string;
  code?: number;
  details?: { kind?: string; details?: unknown } | null;
  cause?: unknown;
  message: string;
  /** Convenience getters present on the typed subclasses. */
  tableName?: string;
  recordId?: string;
  isParseError?: boolean;
  isCancelled?: boolean;
  isTimedOut?: boolean;
  isNotExecuted?: boolean;
  isLiveQueryNotSupported?: boolean;
}

const isServerErrorLike = (e: unknown): e is Error & ServerErrorLike =>
  e instanceof Error && typeof (e as { kind?: unknown }).kind === "string";

const hasIssues = (e: unknown): e is { issues: unknown[]; message: string } =>
  typeof e === "object" &&
  e !== null &&
  typeof (e as { message?: unknown }).message === "string" &&
  Array.isArray((e as { issues?: unknown }).issues);

/** SDK error `kind` -> our code (refined by the structured details below). */
const KIND_CODES: Record<string, BetterSchemicErrorCode> = {
  AlreadyExists: "RecordAlreadyExists",
  NotFound: "RecordNotFound",
  Validation: "ValidationError",
  Configuration: "UnsupportedCapability",
  Thrown: "AssertionFailed",
  Query: "DatabaseError",
  Serialization: "SerializationFailure",
  NotAllowed: "PermissionDenied",
  Connection: "DatabaseError",
  Internal: "DatabaseError",
};

/** Message heuristics — the fallback when the kind is generic (Query/Internal) or absent. */
const MESSAGE_CODES: readonly (readonly [RegExp, BetterSchemicErrorCode])[] = [
  [/already exists/i, "RecordAlreadyExists"],
  [/write conflict|transaction conflict/i, "WriteConflict"],
  [/cancelled transaction/i, "TransactionRollback"],
  [
    /not executed due to a (?:failed|cancelled) transaction/i,
    "TransactionRollback",
  ],
  [
    /does not support|not supported|unsupported|is not supported/i,
    "UnsupportedCapability",
  ],
  [/parse error|unexpected token/i, "ParseError"],
  [/couldn't coerce|expected .* but found|assertion/i, "AssertionFailed"],
  [/permission|not allowed|forbidden|denied/i, "PermissionDenied"],
  [
    /not authenticated|invalid auth|token expired|session expired|missing user or pass/i,
    "NotAuthenticated",
  ],
  [/does not exist|not found/i, "RecordNotFound"],
];

function codeFromMessage(message: string): BetterSchemicErrorCode {
  for (const [re, code] of MESSAGE_CODES) if (re.test(message)) return code;
  return "DatabaseError";
}

/** The table a server error names, when the structured details carry one. */
function tableFrom(error: ServerErrorLike): string | undefined {
  if (typeof error.tableName === "string" && error.tableName)
    return error.tableName;
  const kind = error.details?.kind;
  const inner = error.details?.details as
    | { name?: unknown; id?: unknown }
    | undefined;
  if (kind === "Table" && typeof inner?.name === "string") return inner.name;
  if (kind === "Record" && typeof inner?.id === "string")
    return inner.id.split(":")[0];
  if (typeof error.recordId === "string" && error.recordId)
    return error.recordId.split(":")[0];
  return undefined;
}

/** Refine the kind-derived code with the structured `details.kind`. */
function refineCode(
  error: ServerErrorLike,
  code: BetterSchemicErrorCode,
): BetterSchemicErrorCode {
  const detail = error.details?.kind;
  if (error.isParseError === true || detail === "Parse") return "ParseError";
  if (
    error.isLiveQueryNotSupported === true ||
    detail === "LiveQueryNotSupported"
  )
    return "LiveQueryUnsupported";
  if (error.kind === "NotAllowed" && detail === "Auth")
    return "NotAuthenticated";
  if (error.isCancelled === true || detail === "Cancelled")
    return "TransactionRollback";
  if (error.isNotExecuted === true || detail === "NotExecuted") {
    // A statement skipped because a sibling failed — but a write conflict can arrive under this
    // shape too, and the message is the only discriminator.
    const byMessage = codeFromMessage(error.message);
    return byMessage === "DatabaseError" ? "TransactionRollback" : byMessage;
  }
  if (error.isTimedOut === true || detail === "TimedOut")
    return "DatabaseError";
  return code;
}

/**
 * Normalize a thrown value into a {@link BetterSchemicError}. Exported as a standalone function too,
 * for call sites that prefer it over the static {@link BetterSchemicError.from}.
 */
export function normalizeError(
  error: unknown,
  context: BetterSchemicErrorOptions = {},
): BetterSchemicError {
  if (isBetterSchemicError(error)) return error;

  if (hasIssues(error)) {
    const first = error.issues[0] as
      | { message?: string; path?: unknown[] }
      | undefined;
    const path = first?.path?.join(".");
    return new BetterSchemicError(
      "ValidationError",
      first?.message
        ? `Validation failed${path ? ` at "${path}"` : ""}: ${first.message}`
        : error.message,
      { ...context, details: context.details ?? error.issues, cause: error },
    );
  }

  if (isServerErrorLike(error)) {
    const byKind = KIND_CODES[error.kind] ?? "DatabaseError";
    const refined = refineCode(error, byKind);
    const code =
      refined === "DatabaseError" ? codeFromMessage(error.message) : refined;
    return new BetterSchemicError(code, error.message, {
      ...context,
      table: context.table ?? tableFrom(error),
      details: context.details ?? error.details,
      cause: context.cause ?? error.cause ?? error,
    });
  }

  if (error instanceof Error) {
    return new BetterSchemicError(
      codeFromMessage(error.message),
      error.message,
      {
        ...context,
        cause: error,
      },
    );
  }

  return new BetterSchemicError(
    "DatabaseError",
    typeof error === "string" ? error : `Non-Error thrown: ${String(error)}`,
    { ...context, details: context.details ?? error },
  );
}

/** Narrow to a {@link BetterSchemicError} (cross-realm safe: checks name + code shape). */
export function isBetterSchemicError(e: unknown): e is BetterSchemicError {
  return (
    e instanceof Error &&
    e.name === "BetterSchemicError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

// --- predicates — match on `code`, never on a message string ------------------------------------

const codeOf = (e: unknown): BetterSchemicErrorCode | undefined =>
  isBetterSchemicError(e) ? e.code : undefined;

/** A record/duplicate-id conflict (`CREATE`/`INSERT` on an existing id). */
export const isUniqueViolation = (e: unknown): boolean =>
  codeOf(e) === "RecordAlreadyExists";

/** A schema `ASSERT`/`TYPE` violation (or the codec rejecting a value server-side). */
export const isAssertionFailed = (e: unknown): boolean =>
  codeOf(e) === "AssertionFailed";

/** Permissions / record access denied. */
export const isPermissionDenied = (e: unknown): boolean =>
  codeOf(e) === "PermissionDenied";

/** Optimistic-concurrency conflict — retryable inside a transaction. */
export const isWriteConflict = (e: unknown): boolean =>
  codeOf(e) === "WriteConflict";

/** A serialization failure — retryable inside a transaction. */
export const isSerializationFailure = (e: unknown): boolean =>
  codeOf(e) === "SerializationFailure";

/** An explicit `tx.rollback(...)` (or a cancelled transaction). */
export const isTransactionRollback = (e: unknown): boolean =>
  codeOf(e) === "TransactionRollback";

/** No record matched (`ResultNotFound` from `.throw()`, or a server `NotFound`). */
export const isNotFound = (e: unknown): boolean =>
  codeOf(e) === "ResultNotFound" || codeOf(e) === "RecordNotFound";

/** Any client/server validation failure (Zod, asserts, SurrealQL parse). */
export const isValidationError = (e: unknown): boolean => {
  const code = codeOf(e);
  return (
    code === "ValidationError" ||
    code === "AssertionFailed" ||
    code === "ParseError"
  );
};

/** The server (or the schema/connection) cannot express this operation. */
export const isUnsupportedCapability = (e: unknown): boolean => {
  const code = codeOf(e);
  return code === "UnsupportedCapability" || code === "LiveQueryUnsupported";
};
