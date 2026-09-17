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
}

/** Narrow to a {@link BetterSchemicError} (cross-realm safe: checks name + code shape). */
export function isBetterSchemicError(e: unknown): e is BetterSchemicError {
  return (
    e instanceof Error &&
    e.name === "BetterSchemicError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}
