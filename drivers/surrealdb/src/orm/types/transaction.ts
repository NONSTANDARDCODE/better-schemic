/**
 * Types for `client.transaction` — the callback client, the retry/deadline options and the defaults
 * accepted at bootstrap (`betterSchemic(conn, { schema, transaction: { … } })`).
 *
 * `mode: "sql"` is deliberately ABSENT from the public union: on 3.2.0 `BEGIN`/`COMMIT` do not
 * survive across separate RPC calls (each `query()` is its own transaction — see
 * `docs/orm-syntax-map.md` §7), so the SDK's managed transaction is the only correct lowering.
 * Passing `"sql"` from untyped JS fails fast with `UnsupportedCapability`.
 */
import type { SurrealTransaction } from "surrealdb";
import type { Client } from "../client";
import type { SchemaInput } from "./schema";

/** Why a failed transaction attempt may be retried. */
export type RetryReason =
  | "writeConflict"
  | "serializationFailure"
  | "connectionError";

/** Retry policy for `transaction` — the callback re-runs from scratch on a retryable failure. */
export interface RetryOptions {
  /** Total attempts (1 = no retry). Default `1` — retry is opt-in. */
  readonly attempts?: number;
  /** Retryable failures. Default `["writeConflict"]`. */
  readonly on?: readonly RetryReason[];
  /** Base delay: ms, or a function of the failed attempt (1-based) and its error. */
  readonly delayMs?: number | ((attempt: number, error: Error) => number);
  /** Multiply the delay by a random factor in `[0.5, 1.5)` to spread out contention. */
  readonly jitter?: boolean;
}

/** What to do when a requested transaction feature isn't expressible on the server. */
export type UnsupportedPolicy = "warn" | "throw" | "ignore";

/** Options for one `transaction(...)` call (merged over the client defaults). */
export interface TransactionOptions {
  /** Only `"sdk"` is supported (see the module note). */
  readonly mode?: "sdk";
  readonly retries?: RetryOptions;
  /**
   * Overall budget for the whole call, retries included — milliseconds or a duration string like
   * `"30s"`. SurrealDB has no transaction timeout clause, so this is a client-side deadline: on
   * expiry the transaction is CANCELLED and the call fails with `DatabaseError`
   * (`details.timedOut`). A callback that keeps running after the deadline will fail its next
   * statement (the transaction is gone).
   */
  readonly timeout?: number | string;
  /** SurrealDB has no isolation levels — any value here is reported per {@link onUnsupported}. */
  readonly isolation?: "snapshot";
  /** Metadata attached to transaction-level errors (`timeout`); hooks consume it in M6. */
  readonly meta?: Record<string, unknown>;
  /** Policy for `isolation` (default `"warn"`). */
  readonly onUnsupported?: UnsupportedPolicy;
}

/** Client-level transaction defaults (`betterSchemic(conn, { schema, transaction: { … } })`). */
export type TransactionDefaults = Omit<TransactionOptions, "meta">;

/**
 * The client a `transaction(fn)` callback receives: the delegate surface bound to the transaction —
 * every compiled operation rides the SAME transaction — plus the transaction controls.
 *
 * Members that cannot work on a `SurrealTransaction` are omitted: lifecycle (`close`),
 * `forkSession`/`$withContext`, the realtime surfaces (`live`/`liveOf`/`kill`/`changes`) and the
 * session-bound admin (`export`/`import`/`version`). `api`/`auth`/`info`/`ping`/`$raw`/`$query`/`fn`
 * do work in-transaction.
 */
export type TransactionClient<S = SchemaInput> = Omit<
  Client<S, SurrealTransaction>,
  | "close"
  | "forkSession"
  | "$withContext"
  | "live"
  | "liveOf"
  | "kill"
  | "changes"
  | "export"
  | "import"
  | "version"
> & {
  /** The underlying SDK transaction (the escape hatch). */
  readonly $sdk: SurrealTransaction;
  /**
   * Abort the transaction: cancels it and makes `transaction(...)` reject with
   * `TransactionRollback` (whose `details.reason` is your argument). Typed `never`, so the
   * compiler knows the code after it is unreachable.
   */
  rollback(reason?: unknown): never;
};
