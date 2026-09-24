/**
 * Observation hooks — the read-only half of the plugin system. Hooks are registered at bootstrap
 * (`betterSchemic(conn, { schema, hooks })`) or contributed by plugins; they observe every operation
 * and NEVER change its args or result (mutation is the job of a plugin `transform`).
 *
 * Contract: hooks may be async; a throw in a `before*` hook aborts the operation, while a throw in
 * an `after*` hook is routed to `onError` without undoing the work. `meta` is the per-call `meta`
 * merged over the `$withContext({ meta })` scope (the call wins) and reaches every payload.
 */

/** Reads — compiled to a `SELECT`-family statement. */
export type ReadOperation =
  | "findMany"
  | "findFirst"
  | "findOne"
  | "findUnique"
  | "count"
  | "exists"
  | "aggregate"
  | "paginate"
  | "cursor";

/** Creation — `CREATE`/`INSERT`. */
export type CreateOperation = "create" | "createMany" | "insert" | "insertMany";

/** Mutation — `UPDATE`/`UPSERT`/`PATCH`. */
export type UpdateOperation =
  | "update"
  | "updateMany"
  | "updateEach"
  | "upsert"
  | "upsertMany"
  | "patch";

/** Removal — `DELETE`. */
export type DeleteOperation = "delete" | "deleteMany";

/** Edges — `RELATE`/`DELETE` on a relation delegate. */
export type RelateOperation =
  | "relate"
  | "relateMany"
  | "unrelate"
  | "unrelateMany";

/** Every delegate operation a hook can observe. */
export type OperationKind =
  | ReadOperation
  | CreateOperation
  | UpdateOperation
  | DeleteOperation
  | RelateOperation;

/** The raw escape hatches (their own hook family). */
export type RawOperation = "$raw" | "$query" | "$unsafe";

/** What a `before*` delegate hook receives (all optional context, `table`/`operation` always set). */
export interface HookPayload {
  /** The physical table/edge name. */
  readonly table: string;
  readonly operation: OperationKind;
  /** The compiled SurrealQL (control statements excluded). */
  readonly surql?: string;
  /** The statement binds. */
  readonly vars?: Record<string, unknown>;
  /** The write payload, when the operation has one. */
  readonly data?: unknown;
  /** The filter, when the operation has one. */
  readonly where?: unknown;
  /** Per-call metadata merged over the scope's. */
  readonly meta?: Record<string, unknown>;
}

/** What an `after*` delegate hook receives (the operation already ran). */
export interface AfterHookPayload extends HookPayload {
  /** The decoded result. */
  readonly result: unknown;
  /** Wall-clock duration of the round-trip, in milliseconds. */
  readonly durationMs: number;
  /** Rows the operation returned (`count()`'s value for `count`), when meaningful. */
  readonly count?: number;
}

/** What `onError` receives for a failed delegate operation. */
export interface ErrorHookPayload {
  /** The physical table/edge name, when known. */
  readonly table?: string;
  readonly operation: OperationKind | RawOperation | "transaction";
  /** The thrown value (normalized when it came from the server). */
  readonly error: unknown;
  readonly surql?: string;
  readonly vars?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

/** What `beforeRaw`/`afterRaw`/`onRawError` receive. */
export interface RawHookPayload {
  readonly operation: RawOperation;
  readonly surql: string;
  readonly vars: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

/** What `afterRaw` receives (the raw script already ran). */
export interface RawAfterHookPayload extends RawHookPayload {
  readonly result: unknown;
  readonly durationMs: number;
}

/** What `onRawError` receives. */
export interface RawErrorHookPayload extends RawHookPayload {
  readonly error: unknown;
}

/** What `beforeTransaction` receives. */
export interface TransactionHookPayload {
  /** A per-client monotonic id, so nested/concurrent transactions stay distinguishable. */
  readonly id: number;
  readonly meta?: Record<string, unknown>;
}

/** What `afterTransactionCommit`/`afterTransactionRollback`/`onTransactionError` receive. */
export interface TransactionAfterHookPayload extends TransactionHookPayload {
  readonly durationMs: number;
}

/** What `afterTransactionRollback`/`onTransactionError` receive. */
export interface TransactionRollbackHookPayload
  extends TransactionAfterHookPayload {
  readonly error: unknown;
}

/**
 * The hook surface accepted by `betterSchemic(conn, { schema, hooks })`. Every hook is optional;
 * registering none leaves the client on its zero-overhead fast path.
 *
 * ```ts
 * const client = betterSchemic(db, {
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
  beforeQuery?(
    info: HookPayload & { operation: ReadOperation },
  ): void | Promise<void>;
  afterQuery?(
    info: AfterHookPayload & { operation: ReadOperation },
  ): void | Promise<void>;
  beforeCreate?(
    info: HookPayload & { operation: CreateOperation },
  ): void | Promise<void>;
  afterCreate?(
    info: AfterHookPayload & { operation: CreateOperation },
  ): void | Promise<void>;
  beforeUpdate?(
    info: HookPayload & { operation: UpdateOperation },
  ): void | Promise<void>;
  afterUpdate?(
    info: AfterHookPayload & { operation: UpdateOperation },
  ): void | Promise<void>;
  beforeDelete?(
    info: HookPayload & { operation: DeleteOperation },
  ): void | Promise<void>;
  afterDelete?(
    info: AfterHookPayload & { operation: DeleteOperation },
  ): void | Promise<void>;
  beforeRelate?(
    info: HookPayload & { operation: RelateOperation },
  ): void | Promise<void>;
  afterRelate?(
    info: AfterHookPayload & { operation: RelateOperation },
  ): void | Promise<void>;
  beforeRaw?(info: RawHookPayload): void | Promise<void>;
  afterRaw?(info: RawAfterHookPayload): void | Promise<void>;
  onRawError?(info: RawErrorHookPayload): void | Promise<void>;
  beforeTransaction?(info: TransactionHookPayload): void | Promise<void>;
  afterTransactionCommit?(
    info: TransactionAfterHookPayload,
  ): void | Promise<void>;
  afterTransactionRollback?(
    info: TransactionRollbackHookPayload,
  ): void | Promise<void>;
  onTransactionError?(
    info: TransactionRollbackHookPayload,
  ): void | Promise<void>;
  /** Any failed operation (delegate, raw or transaction). */
  onError?(info: ErrorHookPayload): void | Promise<void>;
}
