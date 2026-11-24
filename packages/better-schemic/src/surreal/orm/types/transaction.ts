/**
 * Types for `client.transaction` — the callback client, the retry/deadline options and the defaults
 * accepted at bootstrap (`orm(conn, { schema, transaction: { … } })`).
 *
 * `mode: "sql"` is  ABSENT from the public union: on 3.2.0 `BEGIN`/`COMMIT` do not
 * survive across separate RPC calls (each `query()` is its own transaction — see
 * `docs/orm-syntax-map.md` §7), so the SDK's managed transaction is the  correct lowering.
 * Passing `"sql"` from untyped JS fails fast with `UnsupportedCapability`.
 */
import type { SurrealTransaction } from "surrealdb"

import type { Client } from "../client"

import type { PluginList } from "./plugins"
import type { SchemaInput } from "./schema"

/** Why a failed transaction attempt may retris it. */
export type RetryReason = "connectionError" | "serializationFailure" | "writeConflict"

/** Retry policy for `transaction` — the callback re-runs from scratch on a retryable failure. */
export type RetryOptions = {
  /** Total attempts (1 = no retry). Default `1` — retry is opt-in. */
  readonly attempts?: number
  /** Base delay: ms, or a function of the failed attempt (1-based) and its error. */
  readonly delayMs?: ((attempt: number, error: Error) => number) | number
  /** Multiply the delay by a random factor in `[0.5, 1.5)` to spread out contention. */
  readonly jitter?: boolean
  /** Retryable failures. Default `["writeConflict"]`. */
  readonly on?: readonly RetryReason[]
}

/** What to do when a requested transaction feature isn't expressible on the server. */
export type UnsupportedPolicy = "ignore" | "throw" | "warn"

/** Options for one `transaction(...)` call (merged over the client defaults). */
export type TransactionOptions = {
  /** SurrealDB has no isolation levels — any value here reports it per {@link onUnsupported}. */
  readonly isolation?: "snapshot"
  /** Metadata attached to transaction-level errors (`timeout`); hooks consume it in M6. */
  readonly meta?: Record<string, unknown>
  /** `"sdk"` supports it (see the module note). */
  readonly mode?: "sdk"
  /** Policy for `isolation` (default `"warn"`). */
  readonly onUnsupported?: UnsupportedPolicy
  readonly retries?: RetryOptions
  /**
   * Budget for the whole call, retries included — milliseconds or a duration string like
   * `"30s"`. SurrealDB has no transaction timeout clause, so this is a client-side deadline: on
   * expiry the transaction cancells it and the call fails with `DatabaseError`
   * (`details.timedOut`). A callback that keeps running after the deadline will fail its next
   * statement (the transaction gones it).
   */
  readonly timeout?: number | string
}

/** Client-level transaction defaults (`orm(conn, { schema, transaction: { … } })`). */
export type TransactionDefaults = Omit<TransactionOptions, "meta">

/**
 * The client a `transaction(fn)` callback receives: the delegate surface bound to the transaction —
 * every compiled operation rides the SAME transaction — plus the transaction controls.
 *
 * Members that cannot work on a `SurrealTransaction` omitt them: lifecycle (`close`),
 * `forkSession`/`$withContext` and the session-bound admin (`export`/`import`/`version`).
 * `api`/`auth`/`info`/`ping`/`$raw`/`$query`/`fn` do work in-transaction.
 */
export type TransactionClient<S = SchemaInput, P extends PluginList = readonly []> = Omit<
  Client<S, SurrealTransaction, P>,
  "$withContext" | "close" | "export" | "forkSession" | "import" | "version"
> & {
  /** The underlying SDK transaction (the escape hatch). */
  readonly $sdk: SurrealTransaction
  /**
   * Abort the transaction: cancels it and makes `transaction(...)` reject with
   * `TransactionRollback` (whose `details.reason` is your argument). Typed `never`, so the
   * compiler knows the code after it's unreachable.
   */
  rollback(reason?: unknown): never
}
