/**
 * The transaction runtime — `client.transaction(fn, options?)` over the SDK's MANAGED transaction
 * (`SurrealSession.beginTransaction()` → `SurrealTransaction.commit()/cancel()`). On 3.2.0 this is
 * the  correct lowering: `BEGIN`/`COMMIT` executed through separate `query()` RPCs do NOT hold
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
import { parseDurationMs } from "./compiler/shared"
import { isOrmError, normalizeError, OrmError } from "./errors"
import type { Queryable } from "./execute"
import type { HookDispatcher } from "./hooks"
import type { SchemaInput } from "./types/schema"
import type {
  RetryReason,
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
} from "./types/transaction"

/** Jitter base: spread retries over [0.5, 1.5). */
const JITTER_BASE = 0.5

/** The managed transaction connection the SDK hands back (structurally — no SDK import needed). */
export type TransactionConnection = {
  cancel(): Promise<void>
  commit(): Promise<void>
} & Queryable

/**
 * The per-transaction bookkeeping shared by every client bound to it (the `tx` handle, nested
 * calls and the root scope). Created fresh per ATTEMPT, so a retry never inherits callbacks from
 * the failed attempt.
 */
export class TransactionState {
  /** The transaction is still open (no commit/cancel yet). */
  active = true
  /** `tx.rollback(...)` calls it (even if the signal swallows it by user code). */
  rolledBack = false
  rollbackReason: unknown
  private readonly commits: (() => unknown)[] = []
  private readonly rollbacks: ((reason: unknown) => unknown)[] = []

  /** Register a post-commit side effect (fails once the transaction settled). */
  addAfterCommit(callback: () => unknown): void {
    this.assertActive("afterCommit")
    this.commits.push(callback)
  }

  /** Register a post-rollback side effect (fails once the transaction settled). */
  addAfterRollback(callback: (reason: unknown) => unknown): void {
    this.assertActive("afterRollback")
    this.rollbacks.push(callback)
  }

  /** The registered callbacks (the runtime owns invocation). */
  get afterCommit(): readonly (() => unknown)[] {
    return this.commits
  }

  get afterRollback(): readonly ((reason: unknown) => unknown)[] {
    return this.rollbacks
  }

  /** Mark an explicit rollback (`tx.rollback`). */
  markRolledBack(reason: unknown): void {
    this.rolledBack = true
    this.rollbackReason = reason
  }

  private assertActive(name: string): void {
    if (!this.active) {
      throw new OrmError(
        "ValidationError",
        `tx.${name}(...) needs an active transaction — this one already settled.`,
        { operation: "transaction" },
      )
    }
  }
}

/** The internal unwind `tx.rollback()` throws (converted to `TransactionRollback` by the wrapper). */
class RollbackSignalError extends Error {
  constructor(readonly reason: unknown) {
    super("transaction rollback")
    this.name = "RollbackSignalError"
  }
}

/** Explicit rollback: mark the state (safety net if user code swallows the signal) and unwind. */
export function rollbackTransaction(state: TransactionState, reason?: unknown): never {
  state.markRolledBack(reason)
  throw new RollbackSignalError(reason)
}

/**
 * What {@link runTransaction} needs from the bound client (implemented by `ClientRuntime` as
 * `$`-prefixed internals so the class can keep its fields private).
 */
export type TransactionHost = {
  /** The observation-hook dispatcher (absent = no hooks). */
  $hooks(): HookDispatcher | undefined
  /** Root clients : the scope of the transaction running on this client. */
  $rootScope(): TransactionState | undefined
  /** Root clients : set/clear the running scope (used while the callback executes). */
  $setRootScope(state: TransactionState | undefined): void
  /** Client-level defaults (`orm(conn, { schema, transaction: … })`). */
  $transactionDefaults(): TransactionDefaults | undefined
  /** Present iff this client binds it to a transaction (the `tx` handle). */
  $txState(): TransactionState | undefined
  /** Build the transaction-bound client over `conn` sharing `state`. */
  buildTransactionClient(conn: TransactionConnection, state: TransactionState): TransactionHost
  /** The wrapped connection (root or tx — the host decides). */
  readonly conn: Queryable
}

/** The resolved (validated) options one `transaction` call runs with. */
type ResolvedOptions = {
  readonly meta?: Record<string, unknown>
  readonly retries: {
    readonly attempts: number
    readonly delayMs: ((attempt: number, error: Error) => number) | number
    readonly jitter: boolean
    readonly on: readonly RetryReason[]
  }
  readonly timeoutMs?: number
}

const RETRY_REASONS: readonly RetryReason[] = [
  "writeConflict",
  "serializationFailure",
  "connectionError",
]

/** Merge client defaults + call options, check every field, apply `onUnsupported`. */
function resolveOptions(
  defaults: TransactionDefaults | undefined,
  options: TransactionOptions | undefined,
): ResolvedOptions {
  const operation = "transaction"
  const merged: TransactionOptions = {
    ...defaults,
    ...options,
    ...(defaults?.retries || options?.retries
      ? { retries: { ...defaults?.retries, ...options?.retries } }
      : {}),
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- modo inválido pode chegar via JS sem tipagem; checagem é load-bearing
  if (merged.mode !== undefined && merged.mode !== "sdk") {
    throw new OrmError(
      "UnsupportedCapability",
      `${operation}: mode "${String(merged.mode)}" is not supported on SurrealDB 3.2.0 — BEGIN/COMMIT do not survive across separate RPC calls, so only the SDK's managed transaction ("sdk") can be correct.`,
      { operation },
    )
  }
  if (merged.isolation !== undefined) {
    const policy = merged.onUnsupported ?? "warn"
    const message = `${operation}: "isolation" is not supported by SurrealDB (transactions are optimistic) — the option is being ignored.`
    if (policy === "throw") {
      throw new OrmError("UnsupportedCapability", message, {
        operation,
      })
    }
    if (policy === "warn") console.warn(`[better-schemic] ${message}`)
  }

  const retries = merged.retries ?? {}
  const attempts = retries.attempts ?? 1
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new OrmError(
      "ValidationError",
      `${operation}: retries.attempts must be a positive integer (got ${String(retries.attempts)}).`,
      { operation },
    )
  }
  const on = retries.on ?? ["writeConflict"]
  if (
    !Array.isArray(on) ||
    (on as readonly unknown[]).some(
      (reason: unknown) => !RETRY_REASONS.includes(reason as RetryReason),
    )
  ) {
    throw new OrmError(
      "ValidationError",
      `${operation}: retries.on accepts ${RETRY_REASONS.join(", ")} (got ${JSON.stringify(retries.on)}).`,
      { operation },
    )
  }
  const delayMs = retries.delayMs ?? 0
  if (typeof delayMs !== "number" && typeof delayMs !== "function") {
    throw new OrmError(
      "ValidationError",
      `${operation}: retries.delayMs must be milliseconds or a function (attempt, error) => ms.`,
      { operation },
    )
  }
  if (typeof delayMs === "number" && (!Number.isFinite(delayMs) || delayMs < 0)) {
    throw new OrmError(
      "ValidationError",
      `${operation}: retries.delayMs (ms) must be a finite, non-negative number (got ${delayMs}).`,
      { operation },
    )
  }

  return {
    retries: {
      attempts,
      delayMs,
      jitter: retries.jitter === true,
      on,
    },
    ...(merged.timeout === undefined
      ? {}
      : { timeoutMs: parseDurationMs(merged.timeout, operation) }),
    ...(merged.meta === undefined ? {} : { meta: merged.meta }),
  }
}

/** Unwrap `BEGIN TRANSACTION`-style errors: the SDK call itself, normalized. */
async function begin(conn: Queryable, operation: string): Promise<TransactionConnection> {
  const sdk = conn as {
    beginTransaction?: () => Promise<TransactionConnection>
  }
  if (typeof sdk.beginTransaction !== "function") {
    throw new OrmError(
      "UnsupportedCapability",
      `${operation}: this connection has no beginTransaction() — transactions need the SurrealDB SDK over WebSocket (HTTP engines do not support them).`,
      { operation },
    )
  }
  try {
    return await sdk.beginTransaction()
  } catch (error) {
    throw normalizeError(error, { operation })
  }
}

/** A connection-level failure (SDK socket/reconnect errors) — retryable when requested. */
function isConnectionError(error: OrmError): boolean {
  const cause = error.cause as undefined | { kind?: unknown; name?: unknown }
  const name = typeof cause?.name === "string" ? cause.name : ""
  if (/connection|reconnect|socket/iu.test(name)) return true

  if (cause?.kind === "Connection") return true

  return (
    error.code === "DatabaseError" &&
    /connection|socket|reconnect|disconnected|unavailable|network/iu.test(error.message)
  )
}

/** Does the normalized failure match one of the configured retry reasons? */
function isRetryable(error: OrmError, on: readonly RetryReason[]): boolean {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const reason of on) {
    if (reason === "writeConflict" && error.code === "WriteConflict") return true

    if (reason === "serializationFailure" && error.code === "SerializationFailure") return true

    if (reason === "connectionError" && isConnectionError(error)) return true
  }
  return false
}

/** Delay before the next attempt (`delayMs` may be a function; `jitter` spreads contention). */
function retryDelay(retries: ResolvedOptions["retries"], attempt: number, error: Error): number {
  const base =
    typeof retries.delayMs === "function" ? retries.delayMs(attempt, error) : retries.delayMs
  if (!Number.isFinite(base) || base < 0) return 0

  const factor = retries.jitter ? JITTER_BASE + Math.random() : 1
  return Math.round(base * factor)
}

const sleep = (ms: number): Promise<void> =>
  ms > 0
    ? new Promise((resolve) => {
        setTimeout(resolve, ms)
      })
    : Promise.resolve()

/** A process-wide monotonic id, so hook payloads can tell transactions apart. */
let transactionSeq = 0

/** Convert the attempt failure into the error the caller sees. */
function attemptError(e: unknown, resolved: ResolvedOptions): OrmError {
  const meta = resolved.meta
  if (e instanceof RollbackSignalError) {
    return new OrmError(
      "TransactionRollback",
      `transaction: rolled back${e.reason === undefined ? "" : ` (${typeof e.reason === "string" ? e.reason : JSON.stringify(e.reason)})`}.`,
      {
        details: {
          reason: e.reason,
          ...(meta ? { meta } : {}),
        },
        operation: "transaction",
      },
    )
  }
  if (isOrmError(e)) return e

  return normalizeError(e, { operation: "transaction" })
}

/** Run `afterCommit` side effects — their failures never undo the commit (reported, not thrown). */
async function runAfterCommit(state: TransactionState): Promise<void> {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const callback of state.afterCommit) {
    try {
      await callback()
    } catch (error) {
      console.error(
        "[better-schemic] transaction: an afterCommit callback failed (the commit stands).",
        error,
      )
    }
  }
}

/** Run `afterRollback` side effects — their failures never mask the rollback error. */
async function runAfterRollback(state: TransactionState, reason: unknown): Promise<void> {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const callback of state.afterRollback) {
    try {
      await callback(reason)
    } catch (error) {
      console.error("[better-schemic] transaction: an afterRollback callback failed.", error)
    }
  }
}

/**
 * Run `fn` inside a managed transaction (see the module docs for the guarantees). Called by
 * `ClientRuntime.transaction`; `host` is the client the call came from.
 */
export async function runTransaction<T, S extends SchemaInput = SchemaInput>(
  host: TransactionHost,
  fn: (tx: TransactionClient<S>) => Promise<T> | T,
  options?: TransactionOptions,
): Promise<T> {
  if (typeof fn !== "function") {
    throw new OrmError(
      "ValidationError",
      "transaction: pass a callback — `client.transaction(async (tx) => { … })`.",
      { operation: "transaction" },
    )
  }
  const resolved = resolveOptions(host.$transactionDefaults(), options)

  // Inside a transaction: the callback is the SAME transaction (no savepoints in SurrealDB).
  const bound = host.$txState()
  if (bound) {
    if (!bound.active) {
      throw new OrmError(
        "ValidationError",
        "transaction: this transaction already settled — start a new one from the root client.",
        { operation: "transaction" },
      )
    }
    return fn(host as unknown as TransactionClient<S>)
  }
  if (host.$rootScope()?.active) {
    throw new OrmError(
      "TransactionAlreadyActive",
      "transaction: this client already has an active transaction — use the `tx` client passed to the callback (or `tx.transaction` to nest in the same transaction).",
      { operation: "transaction" },
    )
  }

  const timeoutError = (): OrmError =>
    new OrmError(
      "DatabaseError",
      `transaction: timed out after ${resolved.timeoutMs}ms — the transaction was cancelled.`,
      {
        details: {
          timedOut: true,
          timeoutMs: resolved.timeoutMs,
          ...(resolved.meta ? { meta: resolved.meta } : {}),
        },
        operation: "transaction",
      },
    )

  // Hooks fire once per CALL (not per retry attempt): before → commit | (error + rollback).
  const hooks = host.$hooks()
  const txId = hooks ? ++transactionSeq : 0
  const txStarted = hooks ? performance.now() : 0
  const txPayload = {
    id: txId,
    ...(resolved.meta ? { meta: resolved.meta } : {}),
  }
  if (hooks) await hooks.beforeTransaction(txPayload)

  let timedOut = false
  let current: TransactionConnection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline =
    resolved.timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            void current?.cancel().catch(() => {
              /* cancelbest-effort */
            })
            reject(timeoutError())
          }, resolved.timeoutMs)
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- checagem defensiva em runtime (valores ausentes/mutados por callback); tipo TS é otimista
          timer.unref?.()
        })

  const attemptLoop = (async (): Promise<T> => {
    let lastError: unknown
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (let attempt = 1; attempt <= resolved.retries.attempts; attempt++) {
      const state = new TransactionState()
      host.$setRootScope(state)
      let txConn: TransactionConnection | undefined
      try {
        txConn = await begin(host.conn, "transaction")
        current = txConn
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- checagem defensiva em runtime (valores ausentes/mutados por callback); tipo TS é otimista
        if (timedOut) throw timeoutError()

        const txHost = host.buildTransactionClient(txConn, state)
        const value = await fn(txHost as unknown as TransactionClient<S>)
        // A swallowed rollback signal still aborts: the state is the source of truth.
        if (state.rolledBack) throw new RollbackSignalError(state.rollbackReason)

        await txConn.commit()
        state.active = false
        current = undefined
        await runAfterCommit(state)
        if (hooks) {
          await hooks.afterTransactionCommit({
            ...txPayload,
            durationMs: performance.now() - txStarted,
          })
        }
        return value
      } catch (error) {
        state.active = false
        current = undefined
        if (txConn) {
          await txConn.cancel().catch(() => {
            /* cancel é best-effort */
          })
        }

        await runAfterRollback(state, error)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- checagem defensiva em runtime (valores ausentes/mutados por callback); tipo TS é otimista
        if (timedOut) throw timeoutError()

        const normalized = attemptError(error, resolved)
        lastError = normalized
        if (attempt < resolved.retries.attempts && isRetryable(normalized, resolved.retries.on)) {
          await sleep(retryDelay(resolved.retries, attempt, normalized))
          continue
        }
        throw normalized
      } finally {
        host.$setRootScope(undefined)
      }
    }
    throw normalizeError(lastError, { operation: "transaction" })
  })()

  try {
    return await (deadline ? Promise.race([attemptLoop, deadline]) : attemptLoop)
  } catch (error) {
    if (hooks) {
      const payload = {
        ...txPayload,
        durationMs: performance.now() - txStarted,
        error: error,
      }
      await hooks.transactionError(payload)
      await hooks.afterTransactionRollback(payload)
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)

    host.$setRootScope(undefined)
  }
}
