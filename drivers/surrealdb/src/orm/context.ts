/**
 * Context resolution — turns a clone's default {@link OperationContext} plus a call-level override
 * into the {@link ResolvedContext} the executor prefixes as `USE NS … DB …;`.
 *
 * The resolution is LAZY (per operation): a `$withContext({ namespace: "tenant_a" })` clone may be
 * created before the parent session picks a database, and a per-call `context: { database }` must
 * still see the clone's namespace. Only when a context is actually in play does this read the
 * session's `namespace`/`database` as the fallback — the common no-context path never touches it.
 *
 * Session-bound operations (`api`/`auth`/`export`/`live`) cannot be scoped by a prefix, so a context
 * clone rejects them with a teaching {@link assertSessionBound} instead of hitting the wrong DB.
 */
import { escapeIdent } from "surrealdb";
import { compileError } from "./compiler/shared";
import type { DelegateContext } from "./delegate";
import type {
  CallContext,
  OperationContext,
  ResolvedContext,
} from "./types/context";

/** The session getters a `SurrealSession` exposes (absent on a plain queryable). */
interface SessionScope {
  readonly namespace?: unknown;
  readonly database?: unknown;
}

/** Resolve the effective scope of one operation, or `undefined` when no context is in play. */
export function resolveContext(
  ctx: DelegateContext,
  call?: CallContext,
): ResolvedContext | undefined {
  const scope = ctx.context;
  const namespace = call?.namespace ?? scope?.namespace;
  const database = call?.database ?? scope?.database;
  // A meta-only context carries no namespace/database override — it threads hook metadata without
  // prefixing `USE` (or requiring the session to have a scope selected).
  if (namespace === undefined && database === undefined) return undefined;
  const session = ctx.conn as SessionScope;
  const resolvedNamespace = pick("namespace", namespace, session.namespace);
  const resolvedDatabase = pick("database", database, session.database);
  const meta = mergeMeta(scope?.meta, call?.meta);
  return {
    namespace: resolvedNamespace,
    database: resolvedDatabase,
    ...(meta ? { meta } : {}),
  };
}

/** First defined string in the chain; a teaching error when none (or not a string) is available. */
function pick(
  side: "namespace" | "database",
  ...candidates: readonly unknown[]
): string {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length === 0)
      throw compileError(
        "ValidationError",
        `context.${side} must be a non-empty string (got ${JSON.stringify(candidate)}).`,
        { operation: "context" },
      );
    return candidate;
  }
  throw compileError(
    "ValidationError",
    `context: this scope needs a ${side} — pass it to $withContext({ namespace, database }) or a per-call context, or select one on the connection (db.use(...)) so the missing side can be inherited.`,
    { operation: "context" },
  );
}

/** The `USE NS … DB …;` control statement for a resolved scope (`""` when there is none). */
export function contextPrefix(context: ResolvedContext | undefined): string {
  return context
    ? `USE NS ${escapeIdent(context.namespace)} DB ${escapeIdent(context.database)};`
    : "";
}

/** Resolve the scope of one operation and spread it into `execute` options (absent when none). */
export function contextOption(
  ctx: DelegateContext,
  call?: CallContext,
): { context?: ResolvedContext } {
  const context = resolveContext(ctx, call);
  return context ? { context } : {};
}

/** Reject unknown `$withContext` keys (a typo would silently do nothing). */
export function assertContextKeys(scope: OperationContext): void {
  const allowed = new Set(["namespace", "database", "meta"]);
  for (const key of Object.keys(scope))
    if (!allowed.has(key))
      throw compileError(
        "ValidationError",
        `$withContext: unknown option "${key}" — accepted: namespace, database, meta, auth.`,
        { operation: "$withContext" },
      );
}

/** Merge scope metadata → call metadata (the call wins); `undefined` when neither carries any. */
function mergeMeta(
  scope: Record<string, unknown> | undefined,
  call: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!scope && !call) return undefined;
  return { ...scope, ...call };
}

/**
 * The effective hook metadata of one operation: the clone's `$withContext({ meta })` scope, then the
 * per-call `context.meta`, then the per-call `meta` (each level overrides the previous).
 */
export function resolveMeta(
  ctx: DelegateContext,
  call?: CallContext,
  callMeta?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return mergeMeta(mergeMeta(ctx.context?.meta, call?.meta), callMeta);
}

/** Reject a session-bound operation on a prefix-scoped clone (it would target the wrong DB). */
export function assertSessionBound(
  context: OperationContext | undefined,
  operation: string,
): void {
  // A meta-only context carries no namespace/database override, so it does not scope the session.
  if (context?.namespace === undefined && context?.database === undefined)
    return;
  throw compileError(
    "UnsupportedCapability",
    `${operation} is bound to the connection SESSION, not to a namespace/database context — a $withContext clone cannot scope it (it would target the session's current database). Use \`await client.$withContext({ namespace, database, auth: token })\` or \`await client.forkSession()\` and select the namespace/database on that session.`,
    { operation },
  );
}
