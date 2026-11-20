/**
 * Observation hooks — the read- half of the plugin system. Hooks register them at bootstrap
 * (`orm(conn, { schema, hooks })`) or contributed by plugins; they observe every operation
 * and NEVER change its args or result (mutation is the job of a plugin `transform`).
 *
 * Contract: hooks may be async; a throw in a `before*` hook aborts the operation, while a throw in
 * an `after*` hook routs it to `onError` without undoing the work. `meta` is the per-call `meta`
 * merged over the `$withContext({ meta })` scope (the call wins) and reaches every payload.
 */

/** Reads — compiled to a `SELECT`-family statement. */
export type ReadOperation =
  | "aggregate"
  | "count"
  | "cursor"
  | "exists"
  | "findFirst"
  | "findMany"
  | "findOne"
  | "findUnique"
  | "paginate"

/** Creation — `CREATE`/`INSERT`. */
export type CreateOperation = "create" | "createMany" | "insert" | "insertMany"

/** Mutation — `UPDATE`/`UPSERT`/`PATCH`. */
export type UpdateOperation =
  "patch" | "update" | "updateEach" | "updateMany" | "upsert" | "upsertDelta" | "upsertMany"

/** Removal — `DELETE`. */
export type DeleteOperation = "delete" | "deleteMany"

/** Edges — `RELATE`/`DELETE` on a relation delegate. */
export type RelateOperation = "relate" | "relateMany" | "unrelate" | "unrelateMany"

/** Every delegate operation a hook can observe. */
export type OperationKind =
  CreateOperation | DeleteOperation | ReadOperation | RelateOperation | UpdateOperation

/** The raw escape hatches (their own hook family). */
export type RawOperation = "$query" | "$raw" | "$unsafe"

/** What a `before*` delegate hook receives (all optional context, `table`/`operation` always set). */
export interface HookPayload {
  /** The write payload, when the operation has one. */
  readonly data?: unknown
  /** Per-call metadata merged over the scope's. */
  readonly meta?: Record<string, unknown>
  readonly operation: OperationKind
  /** The compiled SurrealQL (control statements excluded). */
  readonly surql?: string
  /** The physical table/edge name. */
  readonly table: string
  /** The statement binds. */
  readonly vars?: Record<string, unknown>
  /** The filter, when the operation has one. */
  readonly where?: unknown
}

/** What an `after*` delegate hook receives (the operation already ran). */
export interface AfterHookPayload extends HookPayload {
  /** Rows the operation returned (`count()`'s value for `count`), when meaningful. */
  readonly count?: number
  /** Wall-clock duration of the round-trip, in milliseconds. */
  readonly durationMs: number
  /** The decoded result. */
  readonly result: unknown
}

/** What `onError` receives for a failed delegate operation. */
export interface ErrorHookPayload {
  /** The thrown value (normalized when it came from the server). */
  readonly error: unknown
  readonly meta?: Record<string, unknown>
  readonly operation: "transaction" | OperationKind | RawOperation
  readonly surql?: string
  /** The physical table/edge name, when known. */
  readonly table?: string
  readonly vars?: Record<string, unknown>
}

/** What `beforeRaw`/`afterRaw`/`onRawError` receive. */
export interface RawHookPayload {
  readonly meta?: Record<string, unknown>
  readonly operation: RawOperation
  readonly surql: string
  readonly vars: Record<string, unknown>
}

/** What `afterRaw` receives (the raw script already ran). */
export interface RawAfterHookPayload extends RawHookPayload {
  readonly durationMs: number
  readonly result: unknown
}

/** What `onRawError` receives. */
export interface RawErrorHookPayload extends RawHookPayload {
  readonly error: unknown
}

/** What `beforeTransaction` receives. */
export interface TransactionHookPayload {
  /** A per-client monotonic id, so nested/concurrent transactions stay distinguishable. */
  readonly id: number
  readonly meta?: Record<string, unknown>
}

/** What `afterTransactionCommit`/`afterTransactionRollback`/`onTransactionError` receive. */
export interface TransactionAfterHookPayload extends TransactionHookPayload {
  readonly durationMs: number
}

/** What `afterTransactionRollback`/`onTransactionError` receive. */
export interface TransactionRollbackHookPayload extends TransactionAfterHookPayload {
  readonly error: unknown
}

/**
 * The hook surface accepted by `orm(conn, { schema, hooks })`. Every hook is optional;
 * registering none leaves the client on its zero-overhead fast path.
 *
 * ```ts
 * const client = orm(db, {
 *   schema,
 *   hooks: {
 *     beforeQuery: ({ table, operation, surql }) => logger.debug({ table, operation, surql }),
 *     afterQuery: ({ table, operation, durationMs, count }) => metrics.timing(`db.${table}.${operation}`, durationMs),
 *     onError: ({ operation, error }) => logger.error({ err: error, operation }),
 *   },
 * });
 * ```
 */
export interface Hooks {
  afterCreate?(info: AfterHookPayload & { operation: CreateOperation }): Promise<void> | void
  afterDelete?(info: AfterHookPayload & { operation: DeleteOperation }): Promise<void> | void
  afterQuery?(info: AfterHookPayload & { operation: ReadOperation }): Promise<void> | void
  afterRaw?(info: RawAfterHookPayload): Promise<void> | void
  afterRelate?(info: AfterHookPayload & { operation: RelateOperation }): Promise<void> | void
  afterTransactionCommit?(info: TransactionAfterHookPayload): Promise<void> | void
  afterTransactionRollback?(info: TransactionRollbackHookPayload): Promise<void> | void
  afterUpdate?(info: AfterHookPayload & { operation: UpdateOperation }): Promise<void> | void
  beforeCreate?(info: HookPayload & { operation: CreateOperation }): Promise<void> | void
  beforeDelete?(info: HookPayload & { operation: DeleteOperation }): Promise<void> | void
  beforeQuery?(info: HookPayload & { operation: ReadOperation }): Promise<void> | void
  beforeRaw?(info: RawHookPayload): Promise<void> | void
  beforeRelate?(info: HookPayload & { operation: RelateOperation }): Promise<void> | void
  beforeTransaction?(info: TransactionHookPayload): Promise<void> | void
  beforeUpdate?(info: HookPayload & { operation: UpdateOperation }): Promise<void> | void
  /** Any failed operation (delegate, raw or transaction). */
  onError?(info: ErrorHookPayload): Promise<void> | void
  onRawError?(info: RawErrorHookPayload): Promise<void> | void
  onTransactionError?(info: TransactionRollbackHookPayload): Promise<void> | void
}
