/**
 * The transaction runtime — `client.transaction(fn, options?)` over the SDK's MANAGED transaction
 * (`SurrealSession.beginTransaction()` → `SurrealTransaction.commit()/cancel()`). On 3.2.0 this is
 * the only correct lowering: `BEGIN`/`COMMIT` executed through separate `query()` RPCs do NOT hold
 * the transaction (each call is its own transaction — live-probed, see `docs/orm-syntax-map.md` §7).
 *
 * Guarantees:
 * - the callback receives a full client bound to the transaction (delegates, batches — batch
 *   wrappers skip their implicit `BEGIN` because {@link TransactionHost} marks the scope);
 * - success → `commit()`; any exception → `cancel()` + propagate (no partial commit);
 * - `tx.rollback(reason)` cancels and surfaces `TransactionRollback` (with `details.reason`);
 * - nested calls on the same tx run in the SAME transaction (SurrealDB has no savepoints), and
 *   opening a transaction from the ROOT client while one is active fails with
 *   `TransactionAlreadyActive`;
 * - `retries` re-runs the whole callback on a retryable failure (opt-in; default no retry);
 * - `timeout` is a client-side deadline that cancels the transaction (the server has no such clause);
 * - `afterCommit`/`afterRollback` callbacks run after the outcome and never change it.
 */
import { parseDurationMs } from "./compiler/shared";
import {
  BetterSchemicError,
  isBetterSchemicError,
  normalizeError,
} from "./errors";
import type { Queryable } from "./execute";
import type { SchemaInput } from "./types/schema";
import type {
  RetryReason,
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
} from "./types/transaction";

/** The managed transaction connection the SDK hands back (structurally — no SDK import needed). */
export interface TransactionConnection extends Queryable {
  commit(): Promise<void>;
  cancel(): Promise<void>;
}

/**
 * The per-transaction bookkeeping shared by every client bound to it (the `tx` handle, nested
 * calls and the root scope). Created fresh per ATTEMPT, so a retry never inherits callbacks from
 * the failed attempt.
 */
export class TransactionState {
  /** The transaction is still open (no commit/cancel yet). */
  active = true;
  /** `tx.rollback(...)` was called (even if the signal was swallowed by user code). */
  rolledBack = false;
  rollbackReason: unknown;
  private readonly commits: Array<() => unknown> = [];
  private readonly rollbacks: Array<(reason: unknown) => unknown> = [];

  /** Register a post-commit side effect (fails once the transaction settled). */
  addAfterCommit(callback: () => unknown): void {
    this.assertActive("afterCommit");
    this.commits.push(callback);
  }

  /** Register a post-rollback side effect (fails once the transaction settled). */
  addAfterRollback(callback: (reason: unknown) => unknown): void {
    this.assertActive("afterRollback");
    this.rollbacks.push(callback);
  }

  /** The registered callbacks (the runtime owns invocation). */
  get afterCommit(): readonly (() => unknown)[] {
    return this.commits;
  }

  get afterRollback(): readonly ((reason: unknown) => unknown)[] {
    return this.rollbacks;
  }

  /** Mark an explicit rollback (`tx.rollback`). */
  markRolledBack(reason: unknown): void {
    this.rolledBack = true;
    this.rollbackReason = reason;
  }

  private assertActive(name: string): void {
    if (!this.active)
      throw new BetterSchemicError(
        "ValidationError",
        `tx.${name}(...) needs an active transaction — this one already settled.`,
        { operation: "transaction" },
      );
  }
}

/** The internal unwind `tx.rollback()` throws (converted to `TransactionRollback` by the wrapper). */
class RollbackSignal extends Error {
  constructor(readonly reason: unknown) {
    super("transaction rollback");
    this.name = "TransactionRollbackSignal";
  }
}

/** Explicit rollback: mark the state (safety net if user code swallows the signal) and unwind. */
export function rollbackTransaction(
  state: TransactionState,
  reason?: unknown,
): never {
  state.markRolledBack(reason);
  throw new RollbackSignal(reason);
}

/**
 * What {@link runTransaction} needs from the bound client (implemented by `ClientRuntime` as
 * `$`-prefixed internals so the class can keep its fields private).
 */
export interface TransactionHost {
  /** The wrapped connection (root or tx — the host decides). */
  readonly conn: Queryable;
  /** Client-level defaults (`betterSchemic(conn, { schema, transaction: … })`). */
  $transactionDefaults(): TransactionDefaults | undefined;
  /** Present iff this client is BOUND to a transaction (the `tx` handle). */
  $txState(): TransactionState | undefined;
  /** Root clients only: the scope of the transaction currently running on this client. */
  $rootScope(): TransactionState | undefined;
  /** Root clients only: set/clear the running scope (used while the callback executes). */
  $setRootScope(state: TransactionState | undefined): void;
  /** Build the transaction-bound client over `conn` sharing `state`. */
  buildTransactionClient(
    conn: TransactionConnection,
    state: TransactionState,
  ): TransactionHost;
}

/** The resolved (validated) options one `transaction` call runs with. */
interface ResolvedOptions {
  readonly retries: {
    readonly attempts: number;
    readonly on: readonly RetryReason[];
    readonly delayMs: number | ((attempt: number, error: Error) => number);
    readonly jitter: boolean;
  };
  readonly timeoutMs?: number;
  readonly meta?: Record<string, unknown>;
}

const RETRY_REASONS: readonly RetryReason[] = [
  "writeConflict",
  "serializationFailure",
  "connectionError",
];

/** Merge client defaults + call options, validate every field, apply `onUnsupported`. */
function resolveOptions(
  defaults: TransactionDefaults | undefined,
  options: TransactionOptions | undefined,
): ResolvedOptions {
  const operation = "transaction";
  const merged: TransactionOptions = {
    ...defaults,
    ...options,
    ...(defaults?.retries || options?.retries
      ? { retries: { ...defaults?.retries, ...options?.retries } }
      : {}),
  };
  if (merged.mode !== undefined && merged.mode !== "sdk")
    throw new BetterSchemicError(
      "UnsupportedCapability",
      `${operation}: mode "${String(merged.mode)}" is not supported on SurrealDB 3.2.0 — BEGIN/COMMIT do not survive across separate RPC calls, so only the SDK's managed transaction ("sdk") can be correct.`,
      { operation },
    );
  if (merged.isolation !== undefined) {
    const policy = merged.onUnsupported ?? "warn";
    const message = `${operation}: "isolation" is not supported by SurrealDB (transactions are optimistic) — the option is being ignored.`;
    if (policy === "throw")
      throw new BetterSchemicError("UnsupportedCapability", message, {
        operation,
      });
    if (policy === "warn") console.warn(`[better-schemic] ${message}`);
  }

  const retries = merged.retries ?? {};
  const attempts = retries.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: retries.attempts must be a positive integer (got ${String(retries.attempts)}).`,
      { operation },
    );
  const on = retries.on ?? ["writeConflict"];
  if (!Array.isArray(on) || on.some((r) => !RETRY_REASONS.includes(r)))
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: retries.on accepts ${RETRY_REASONS.join(", ")} (got ${JSON.stringify(retries.on)}).`,
      { operation },
    );
  const delayMs = retries.delayMs ?? 0;
  if (typeof delayMs !== "number" && typeof delayMs !== "function")
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: retries.delayMs must be milliseconds or a function (attempt, error) => ms.`,
      { operation },
    );
  if (typeof delayMs === "number" && (!Number.isFinite(delayMs) || delayMs < 0))
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: retries.delayMs (ms) must be a finite, non-negative number (got ${delayMs}).`,
      { operation },
    );

  return {
    retries: {
      attempts,
      on,
      delayMs,
      jitter: retries.jitter === true,
    },
    ...(merged.timeout !== undefined
      ? { timeoutMs: parseDurationMs(merged.timeout, operation) }
      : {}),
    ...(merged.meta !== undefined ? { meta: merged.meta } : {}),
  };
}

/** Unwrap `BEGIN TRANSACTION`-style errors: the SDK call itself, normalized. */
async function begin(
  conn: Queryable,
  operation: string,
): Promise<TransactionConnection> {
  const sdk = conn as {
    beginTransaction?: () => Promise<TransactionConnection>;
  };
  if (typeof sdk.beginTransaction !== "function")
    throw new BetterSchemicError(
      "UnsupportedCapability",
      `${operation}: this connection has no beginTransaction() — transactions need the SurrealDB SDK over WebSocket (HTTP engines do not support them).`,
      { operation },
    );
  try {
    return await sdk.beginTransaction();
  } catch (e) {
    throw normalizeError(e, { operation });
  }
}

/** A connection-level failure (SDK socket/reconnect errors) — retryable when requested. */
function isConnectionError(error: BetterSchemicError): boolean {
  const cause = error.cause as { kind?: unknown; name?: unknown } | undefined;
  const name = typeof cause?.name === "string" ? cause.name : "";
  if (/connection|reconnect|socket/i.test(name)) return true;
  if (cause?.kind === "Connection") return true;
  return (
    error.code === "DatabaseError" &&
    /connection|socket|reconnect|disconnected|unavailable|network/i.test(
      error.message,
    )
  );
}

/** Does the normalized failure match one of the configured retry reasons? */
function isRetryable(
  error: BetterSchemicError,
  on: readonly RetryReason[],
): boolean {
  for (const reason of on) {
    if (reason === "writeConflict" && error.code === "WriteConflict")
      return true;
    if (
      reason === "serializationFailure" &&
      error.code === "SerializationFailure"
    )
      return true;
    if (reason === "connectionError" && isConnectionError(error)) return true;
  }
  return false;
}

/** Delay before the next attempt (`delayMs` may be a function; `jitter` spreads contention). */
function retryDelay(
  retries: ResolvedOptions["retries"],
  attempt: number,
  error: Error,
): number {
  const base =
    typeof retries.delayMs === "function"
      ? retries.delayMs(attempt, error)
      : retries.delayMs;
  if (!Number.isFinite(base) || base < 0) return 0;
  const factor = retries.jitter ? 0.5 + Math.random() : 1;
  return Math.round(base * factor);
}

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

/** Convert the attempt failure into the error the caller sees. */
function attemptError(
  e: unknown,
  resolved: ResolvedOptions,
): BetterSchemicError {
  const meta = resolved.meta;
  if (e instanceof RollbackSignal)
    return new BetterSchemicError(
      "TransactionRollback",
      `transaction: rolled back${e.reason === undefined ? "" : ` (${typeof e.reason === "string" ? e.reason : JSON.stringify(e.reason)})`}.`,
      {
        operation: "transaction",
        details: {
          reason: e.reason,
          ...(meta ? { meta } : {}),
        },
      },
    );
  if (isBetterSchemicError(e)) return e;
  return normalizeError(e, { operation: "transaction" });
}

/** Run `afterCommit` side effects — their failures never undo the commit (reported, not thrown). */
async function runAfterCommit(state: TransactionState): Promise<void> {
  for (const callback of state.afterCommit) {
    try {
      await callback();
    } catch (e) {
      console.error(
        "[better-schemic] transaction: an afterCommit callback failed (the commit stands).",
        e,
      );
    }
  }
}

/** Run `afterRollback` side effects — their failures never mask the rollback error. */
async function runAfterRollback(
  state: TransactionState,
  reason: unknown,
): Promise<void> {
  for (const callback of state.afterRollback) {
    try {
      await callback(reason);
    } catch (e) {
      console.error(
        "[better-schemic] transaction: an afterRollback callback failed.",
        e,
      );
    }
  }
}

/**
 * Run `fn` inside a managed transaction (see the module docs for the guarantees). Called by
 * `ClientRuntime.transaction`; `host` is the client the call came from.
 */
export async function runTransaction<T, S extends SchemaInput = SchemaInput>(
  host: TransactionHost,
  fn: (tx: TransactionClient<S>) => T | Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  if (typeof fn !== "function")
    throw new BetterSchemicError(
      "ValidationError",
      "transaction: pass a callback — `client.transaction(async (tx) => { … })`.",
      { operation: "transaction" },
    );
  const resolved = resolveOptions(host.$transactionDefaults(), options);

  // Inside a transaction: the callback is the SAME transaction (no savepoints in SurrealDB).
  const bound = host.$txState();
  if (bound) {
    if (!bound.active)
      throw new BetterSchemicError(
        "ValidationError",
        "transaction: this transaction already settled — start a new one from the root client.",
        { operation: "transaction" },
      );
    return await fn(host as unknown as TransactionClient<S>);
  }
  if (host.$rootScope()?.active)
    throw new BetterSchemicError(
      "TransactionAlreadyActive",
      "transaction: this client already has an active transaction — use the `tx` client passed to the callback (or `tx.transaction` to nest in the same transaction).",
      { operation: "transaction" },
    );

  const timeoutError = (): BetterSchemicError =>
    new BetterSchemicError(
      "DatabaseError",
      `transaction: timed out after ${resolved.timeoutMs}ms — the transaction was cancelled.`,
      {
        operation: "transaction",
        details: {
          timedOut: true,
          timeoutMs: resolved.timeoutMs,
          ...(resolved.meta ? { meta: resolved.meta } : {}),
        },
      },
    );

  let timedOut = false;
  let current: TransactionConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    resolved.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            void current?.cancel().catch(() => {});
            reject(timeoutError());
          }, resolved.timeoutMs as number);
          timer.unref?.();
        });

  const attemptLoop = (async (): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= resolved.retries.attempts; attempt++) {
      const state = new TransactionState();
      host.$setRootScope(state);
      let txConn: TransactionConnection | undefined;
      try {
        txConn = await begin(host.conn, "transaction");
        current = txConn;
        if (timedOut) throw timeoutError();
        const txHost = host.buildTransactionClient(txConn, state);
        const value = await fn(txHost as unknown as TransactionClient<S>);
        // A swallowed rollback signal still aborts: the state is the source of truth.
        if (state.rolledBack) throw new RollbackSignal(state.rollbackReason);
        await txConn.commit();
        state.active = false;
        current = undefined;
        await runAfterCommit(state);
        return value;
      } catch (e) {
        state.active = false;
        current = undefined;
        if (txConn) await txConn.cancel().catch(() => {});
        await runAfterRollback(state, e);
        if (timedOut) throw timeoutError();
        const normalized = attemptError(e, resolved);
        lastError = normalized;
        if (
          attempt < resolved.retries.attempts &&
          isRetryable(normalized, resolved.retries.on)
        ) {
          await sleep(retryDelay(resolved.retries, attempt, normalized));
          continue;
        }
        throw normalized;
      } finally {
        host.$setRootScope(undefined);
      }
    }
    throw normalizeError(lastError, { operation: "transaction" });
  })();

  try {
    return await (deadline
      ? Promise.race([attemptLoop, deadline])
      : attemptLoop);
  } finally {
    if (timer) clearTimeout(timer);
    host.$setRootScope(undefined);
  }
}
