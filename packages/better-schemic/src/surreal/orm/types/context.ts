/**
 * Operation context — the namespace/database (+ hook metadata) a client clone or a SINGLE call
 * routes to. A context clone prefixes every compiled operation with `USE NS … DB …;` in the SAME
 * round-trip (live-probed: it scopes the query and never leaks into the connection's session), so
 * multi-tenant routing needs no global `db.use()` and no extra round-trip.
 *
 * Operations that cannot be expressed as SurrealQL (`api`/`auth`/`export`/`live`) are bound to the
 * connection's SESSION, not to a prefix — a prefix clone rejects them with a teaching
 * `UnsupportedCapability` instead of silently targeting the wrong database. Use the `auth` overload
 * of `$withContext` (or `forkSession()`) when a scoped SESSION is what you need.
 */
import type { Token, Tokens } from "surrealdb";

/** A per-scope (or per-call) namespace/database + the hook metadata of the current scope. */
export interface OperationContext {
  /** Target namespace (`USE NS`). Falls back to the clone's, then the session's. */
  namespace?: string;
  /** Target database (`USE DB`). Falls back to the clone's, then the session's. */
  database?: string;
  /**
   * Hook/plugin metadata for the scope. Merged `$withContext.meta` → per-call `meta` wins.
   * Consumed by the hooks pipeline in M6 (accepted and threaded today).
   */
  meta?: Record<string, unknown>;
}

/** A context with BOTH sides known — what the executor needs to emit `USE NS … DB …;`. */
export interface ResolvedContext {
  readonly namespace: string;
  readonly database: string;
  /** The merged scope metadata (M6 hooks consume it). */
  readonly meta?: Record<string, unknown>;
}

/** An existing access token (or access+refresh pair) for an isolated session. */
export type ContextAuth = Token | Tokens;

/** The `$withContext` argument: a partial context plus an optional token for a scoped session. */
export interface ContextScope extends OperationContext {
  /** Authenticate a FORKED session with this token (`$withContext` then returns a Promise). */
  auth?: ContextAuth;
}

/** The call-level context override every read/write accepts (`context: { database }`). */
export type CallContext = OperationContext;
