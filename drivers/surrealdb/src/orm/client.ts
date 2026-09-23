/**
 * The bound ORM client — `betterSchemic(conn, { schema })` wraps an EXISTING SurrealDB connection
 * (BYO; its `close()` is a no-op) with one delegate per schema entry. The managed counterpart
 * (`createBetterSchemic` / `clientFromConfig`) lives in `./connect`, which builds on this module.
 *
 * Landing in later milestones on the same client object: operation methods on the delegates
 * (M1 reads, M2 writes), `$raw`, transactions, live, hooks/plugins. Today it ships the lifecycle,
 * delegate resolution and the type-level key -> delegate mapping.
 */
import { asyncDisposable, type OrmClientBase } from "@better-schemic/core";
import type { SurrealSession } from "surrealdb";
import { createAdminOperations } from "./admin";
import { createApiOperations } from "./api";
import { createAuthOperations } from "./auth";
import { type ChangesRuntimeArgs, fetchChanges } from "./changes";
import { assertContextKeys, assertSessionBound } from "./context";
import {
  createDelegate,
  type Delegate,
  type DelegateContext,
} from "./delegate";
import { BetterSchemicError } from "./errors";
import type { Queryable } from "./execute";
import { createFnOperations } from "./fn";
import { createHookDispatcher, type HookDispatcher } from "./hooks";
import { killLive, reattachLive } from "./live";
import { resolveModel, type SchemaIndex } from "./meta";
import { createPluginPipeline, type PluginPipeline } from "./plugins";
import { createRawOperations, type RawOperations } from "./raw";
import { buildSchemaIndex } from "./schema";
import {
  rollbackTransaction,
  runTransaction,
  type TransactionConnection,
  type TransactionHost,
  type TransactionState,
} from "./transaction";
import type { ApiOperations } from "./types/api";
import type { AuthOperations } from "./types/auth";
import type { ChangeSet } from "./types/changes";
import type {
  BetterSchemicOptions,
  Client,
  Extension,
  SchemaArg,
} from "./types/client";
import type {
  ContextAuth,
  ContextScope,
  OperationContext,
} from "./types/context";
import type { FnSurface } from "./types/fn";
import type {
  LiveDefaults,
  LiveHandler,
  LiveId,
  LiveSubscription,
} from "./types/live";
import type { Plugin } from "./types/plugins";
import type { RawDefaults } from "./types/raw";
import type { SchemaInput } from "./types/schema";
import type {
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
} from "./types/transaction";

export type { BetterSchemicOptions, Client, SchemaArg } from "./types/client";

/** The runtime behind every {@link Client} — the class members plus the per-key delegates. */
export class ClientRuntime<C extends Queryable = Queryable>
  implements OrmClientBase
{
  /** `[Symbol.asyncDispose]` = `close()`, installed on the prototype by {@link asyncDisposable}. */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  /** Delegates by schema key (shared by `client.<key>` and `repository`). */
  private readonly delegates = new Map<string, Delegate>();

  /** The runtime services every delegate operation receives. */
  private readonly delegateContext: DelegateContext;

  /** Client-level transaction defaults (`betterSchemic(conn, { schema, transaction: … })`). */
  private readonly transactionDefaults?: TransactionDefaults;

  /** Present iff this client is BOUND to a transaction (the `tx` handle from the callback). */
  private readonly txState?: TransactionState;

  /** Root clients only: the transaction scope currently running on this client. */
  private rootScope?: TransactionState;

  /** Client-level live defaults (`betterSchemic(conn, { schema, live: … })`). */
  private readonly liveDefaults?: LiveDefaults;

  /** Client-level raw defaults (`betterSchemic(conn, { schema, raw: … })`). */
  private readonly rawDefaults?: RawDefaults;

  /** The observation-hook dispatcher (`betterSchemic(conn, { schema, hooks })`); absent = fast path. */
  private readonly hooks?: HookDispatcher;

  /** The plugin pipeline (`betterSchemic(conn, { schema, plugins })`); absent = no plugins. */
  private readonly pipeline?: PluginPipeline;

  /** The clone's default namespace/database scope (`$withContext`); absent on a plain client. */
  private readonly context?: OperationContext;

  /** Helpers attached with `extends`, re-applied to every clone (context/tx/fork). */
  private readonly extensions: Extension[] = [];

  /** The raw escape hatches (`$raw`/`$query`/`$unsafe`) — built from the client context. */
  declare $raw: RawOperations["$raw"];
  declare $query: RawOperations["$query"];
  declare $unsafe: RawOperations["$unsafe"];
  /** Database functions (`fn.call` + the schema shortcuts). */
  declare fn: FnSurface;
  /** `DEFINE API` endpoints. */
  declare api: ApiOperations;
  /** Session authentication. */
  declare auth: AuthOperations;
  declare info: ReturnType<typeof createAdminOperations>["info"];
  declare version: ReturnType<typeof createAdminOperations>["version"];
  declare ping: ReturnType<typeof createAdminOperations>["ping"];
  declare export: ReturnType<typeof createAdminOperations>["export"];
  declare import: ReturnType<typeof createAdminOperations>["import"];

  constructor(
    /** The wrapped connection — the SDK `Surreal` (or a `SurrealSession` when forked). */
    readonly conn: C,
    /** The validated schema metadata pass. */
    readonly $index: SchemaIndex,
    private readonly managed: boolean,
    private readonly debug: boolean,
    scope: {
      readonly transaction?: TransactionDefaults;
      readonly txState?: TransactionState;
      readonly live?: LiveDefaults;
      readonly raw?: RawDefaults;
      readonly context?: OperationContext;
      readonly extensions?: readonly Extension[];
      readonly hooks?: HookDispatcher;
      readonly pipeline?: PluginPipeline;
    } = {},
  ) {
    this.transactionDefaults = scope.transaction;
    this.txState = scope.txState;
    this.liveDefaults = scope.live;
    this.rawDefaults = scope.raw;
    this.hooks = scope.hooks;
    this.pipeline = scope.pipeline;
    this.context = scope.context;
    this.delegateContext = {
      conn,
      index: $index,
      debug,
      ...(scope.txState ? { inTransaction: true } : {}),
      ...(scope.live ? { live: scope.live } : {}),
      ...(scope.context ? { context: scope.context } : {}),
      ...(scope.hooks ? { hooks: scope.hooks } : {}),
      ...(scope.pipeline ? { pipeline: scope.pipeline } : {}),
    };
    // Assign the fixed surfaces BEFORE the schema delegates so `assertMemberAvailable`'s
    // `name in this` check covers them — no hand-maintained reserved-name list to keep in sync.
    Object.assign(this, createRawOperations(this.delegateContext, scope.raw));
    this.fn = createFnOperations(this.delegateContext);
    this.api = createApiOperations(this.delegateContext);
    this.auth = createAuthOperations(this.delegateContext);
    Object.assign(this, createAdminOperations(this.delegateContext));
    for (const [key, meta] of [...$index.tables, ...$index.schemaless]) {
      this.assertMemberAvailable(key, "schema key");
      const delegate = createDelegate(meta, this.delegateContext);
      this.delegates.set(key, delegate);
      (this as Record<string, unknown>)[key] = delegate;
    }
    // Plugins: run `setup` once (fail-fast) and graft `extendClient` methods (collision = error).
    if (scope.pipeline) {
      scope.pipeline.setup($index);
      const methods = scope.pipeline.extendClient({
        index: $index,
        client: this,
      });
      for (const [name, value] of Object.entries(methods)) {
        this.assertMemberAvailable(name, "extends");
        (this as Record<string, unknown>)[name] = value;
      }
    }
    for (const extension of scope.extensions ?? [])
      this.applyExtension(extension);
  }

  /**
   * Fail fast when a schema key or `extends` helper would shadow a client member. Every fixed
   * surface/method is already on `this` (see the constructor order), so `name in this` is the
   * source of truth; `then` is guarded explicitly (a thenable client would break `await`).
   */
  private assertMemberAvailable(
    name: string,
    source: "schema key" | "extends",
  ): void {
    if (name !== "then" && !name.startsWith("$") && !(name in this)) return;
    throw new BetterSchemicError(
      source === "schema key" ? "SchemaInvalid" : "PluginError",
      `${source} "${name}" collides with a client member (or the reserved "then") — pick another name.`,
    );
  }

  /** The underlying SDK connection (the escape hatch for anything the ORM doesn't cover). */
  get $sdk(): C {
    return this.conn;
  }

  /** The schema keys exposed as delegates, in schema order. */
  get tables(): readonly string[] {
    return [...this.delegates.keys()];
  }

  /** Resolve a delegate by schema key OR physical table name. */
  repository(name: string): Delegate {
    const byKey = this.delegates.get(name);
    if (byKey) return byKey;
    const meta = resolveModel(this.$index, name);
    const byName = meta ? this.delegates.get(meta.key) : undefined;
    if (byName) return byName;
    throw new BetterSchemicError(
      "RepositoryNotFound",
      `repository("${name}"): no schema entry has that key or physical name. Known: ${[...this.delegates.keys()].join(", ") || "(none)"}.`,
      { details: { known: [...this.delegates.keys()] } },
    );
  }

  /**
   * Run `fn` inside a managed transaction (the typed surface lives on {@link Client}): the
   * callback receives a full client bound to it, success commits, any exception cancels and
   * propagates. The runtime lives in `./transaction`.
   */
  transaction<T>(
    fn: (tx: unknown) => T | Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return runTransaction(this as TransactionHost, fn, options);
  }

  /** INTERNAL (TransactionHost): client-level transaction defaults. */
  $transactionDefaults(): TransactionDefaults | undefined {
    return this.transactionDefaults;
  }

  /** INTERNAL (TransactionHost): the observation-hook dispatcher (absent = no hooks). */
  $hooks(): HookDispatcher | undefined {
    return this.hooks;
  }

  /** INTERNAL (TransactionHost): the transaction state when bound to one. */
  $txState(): TransactionState | undefined {
    return this.txState;
  }

  /** INTERNAL (TransactionHost): the transaction scope running on this root client. */
  $rootScope(): TransactionState | undefined {
    return this.rootScope;
  }

  /** INTERNAL (TransactionHost): set/clear the running scope. */
  $setRootScope(state: TransactionState | undefined): void {
    this.rootScope = state;
  }

  /**
   * Subscribe to a model's changes by schema key (the typed surface lives on {@link Client}); the
   * delegate owns the compilation/stream runtime.
   */
  live(
    table: string,
    args?: unknown,
    handler?: unknown,
  ): Promise<LiveSubscription<unknown>> {
    const delegate = this.repository(table) as unknown as {
      live(
        args?: unknown,
        handler?: unknown,
      ): Promise<LiveSubscription<unknown>>;
    };
    return delegate.live(args ?? {}, handler);
  }

  /** Reattach to an existing live query by uuid (see {@link Client.liveOf}). */
  liveOf(
    uuid: LiveId,
    handler?: LiveHandler<Record<string, unknown>>,
  ): Promise<LiveSubscription<Record<string, unknown>>> {
    assertSessionBound(this.context, "liveOf");
    return reattachLive(this.conn, uuid, handler);
  }

  /** End a live query on the server by uuid (see {@link Client.kill}). */
  kill(uuid: LiveId): Promise<void> {
    assertSessionBound(this.context, "kill");
    return killLive(this.conn, uuid, this.debug);
  }

  /** Read the changefeed (see {@link Client.changes}); the typed surface lives on `Client`. */
  changes(args?: ChangesRuntimeArgs): Promise<ChangeSet<unknown>[]> {
    const table = args?.table;
    const fallback = table ? resolveModel(this.$index, table) : undefined;
    return fetchChanges(this.delegateContext, this.$index, args, fallback);
  }

  /** Register an `afterCommit` callback on the CURRENT scope (`ValidationError` outside one). */
  afterCommit(callback: () => void | Promise<void>): void {
    this.activeScope("afterCommit").addAfterCommit(callback);
  }

  /** Register an `afterRollback` callback on the CURRENT scope (`ValidationError` outside one). */
  afterRollback(callback: (reason: unknown) => void | Promise<void>): void {
    this.activeScope("afterRollback").addAfterRollback(callback);
  }

  /** The authoritative scope for callback registration: the tx handle, else the root scope. */
  private activeScope(name: string): TransactionState {
    const state = this.txState?.active
      ? this.txState
      : this.rootScope?.active
        ? this.rootScope
        : undefined;
    if (!state)
      throw new BetterSchemicError(
        "ValidationError",
        `client.${name}(...) needs an active transaction — call it inside client.transaction(async (tx) => { … }) (or use tx.${name}).`,
      );
    return state;
  }

  /**
   * Build the transaction-bound client (INTERNAL — consumed by {@link runTransaction}): the same
   * schema and options over the transaction connection, sharing the attempt's state.
   */
  buildTransactionClient(
    conn: TransactionConnection,
    state: TransactionState,
  ): ClientRuntime {
    return new ClientRuntime(
      conn as unknown as C,
      this.$index,
      false,
      this.debug,
      {
        ...this.childScope(),
        txState: state,
      },
    );
  }

  /** The options a child client inherits (defaults, context, extensions). */
  private childScope(keepContext = true): {
    transaction?: TransactionDefaults;
    live?: LiveDefaults;
    raw?: RawDefaults;
    context?: OperationContext;
    extensions: readonly Extension[];
    hooks?: HookDispatcher;
    pipeline?: PluginPipeline;
  } {
    return {
      ...(this.transactionDefaults !== undefined
        ? { transaction: this.transactionDefaults }
        : {}),
      ...(this.liveDefaults !== undefined ? { live: this.liveDefaults } : {}),
      ...(this.rawDefaults !== undefined ? { raw: this.rawDefaults } : {}),
      ...(keepContext && this.context !== undefined
        ? { context: this.context }
        : {}),
      extensions: this.extensions,
      ...(this.hooks !== undefined ? { hooks: this.hooks } : {}),
      ...(this.pipeline !== undefined ? { pipeline: this.pipeline } : {}),
    };
  }

  /**
   * Attach project helpers to the client (object or factory receiving the client). A name
   * colliding with an existing member fails fast — silent shadowing of the ORM surface is a DX
   * trap, not a feature.
   *
   * ```ts
   * const db = betterSchemic(conn, { schema }).extends({
   *   async activeUsers(this: Client<typeof schema>) {
   *     return this.repository("users"); // M1: this.users.findMany({ where: { active: true } })
   *   },
   * });
   * ```
   */
  extends<T extends object>(extension: T | ((client: this) => T)): this & T {
    const entry = extension as Extension;
    this.extensions.push(entry);
    this.applyExtension(entry);
    return this as this & T;
  }

  /** Apply one stored extension to THIS client (called on creation and by `extends`). */
  private applyExtension(extension: Extension): void {
    const resolved =
      typeof extension === "function"
        ? (extension as (client: ClientRuntime) => object)(this)
        : extension;
    for (const [name, value] of Object.entries(resolved)) {
      this.assertMemberAvailable(name, "extends");
      (this as Record<string, unknown>)[name] = value;
    }
  }

  /**
   * Fork a scoped, disposable session (its own auth/session context) with the same schema
   * delegates. Project helpers added via {@link extends} are re-applied to the fork.
   */
  async forkSession(): Promise<ClientRuntime<Queryable>> {
    const sdk = this.conn as unknown as {
      forkSession?: () => Promise<SurrealSession>;
    };
    if (typeof sdk.forkSession !== "function")
      throw new BetterSchemicError(
        "UnsupportedCapability",
        "forkSession() needs the SurrealDB SDK connection — this client wraps an object without `forkSession()`.",
      );
    const session = await sdk.forkSession();
    // A fork never owns the parent: `close()` on the fork disposes the session only.
    return new ClientRuntime(
      session as unknown as Queryable,
      this.$index,
      true,
      this.debug,
      this.childScope(false),
    );
  }

  /**
   * A clone that routes every compiled operation to `namespace`/`database` in the SAME round-trip
   * (`USE NS … DB …;`) without touching the connection's session. With `auth`, the clone owns a
   * FORKED session instead (returned as a Promise) so session-bound operations work scoped too.
   */
  $withContext(
    context: ContextScope = {},
  ): ClientRuntime | Promise<ClientRuntime> {
    const { auth, ...scope } = context;
    assertContextKeys(scope);
    if (auth !== undefined) return this.scopedSession(scope, auth);
    return new ClientRuntime(this.conn, this.$index, false, this.debug, {
      ...this.childScope(false),
      context: scope,
    });
  }

  /** The `auth` overload: fork a session, select the scope on it and authenticate. */
  private async scopedSession(
    scope: OperationContext,
    auth: ContextAuth,
  ): Promise<ClientRuntime> {
    const session = await this.forkSession();
    const sdk = session.conn as unknown as {
      namespace?: string;
      database?: string;
      use?: (what: {
        namespace?: string;
        database?: string;
      }) => Promise<unknown>;
      authenticate?: (token: ContextAuth) => Promise<unknown>;
    };
    const namespace = scope.namespace ?? sdk.namespace;
    const database = scope.database ?? sdk.database;
    if (!namespace || !database)
      throw new BetterSchemicError(
        "ValidationError",
        "$withContext({ auth }): the scoped session needs BOTH namespace and database — pass them, or select them on the parent connection first.",
      );
    if (typeof sdk.use !== "function" || typeof sdk.authenticate !== "function")
      throw new BetterSchemicError(
        "UnsupportedCapability",
        "$withContext({ auth }) needs the SurrealDB SDK connection (a forkable session).",
      );
    await sdk.use({ namespace, database });
    await sdk.authenticate(auth);
    return session;
  }

  /**
   * Abort the transaction this client is bound to (only the `tx` handle has one): cancels it and
   * makes the surrounding `transaction(...)` reject with `TransactionRollback`. Typed `never` on
   * {@link TransactionClient.rollback}.
   */
  rollback(reason?: unknown): never {
    if (!this.txState)
      throw new BetterSchemicError(
        "ValidationError",
        "rollback() is only available on the `tx` client inside client.transaction(...).",
      );
    return rollbackTransaction(this.txState, reason);
  }

  /**
   * Close the connection — MANAGED clients (opened by `createBetterSchemic`/the config) close what
   * they opened; a BYO client is a NO-OP (never close the user's connection).
   */
  async close(): Promise<void> {
    if (!this.managed) return;
    const sdk = this.conn as unknown as {
      close?: () => Promise<void>;
      closeSession?: () => Promise<void>;
    };
    if (typeof sdk.close === "function") await sdk.close();
    else if (typeof sdk.closeSession === "function") await sdk.closeSession();
  }
}
asyncDisposable(ClientRuntime.prototype);

/** INTERNAL (shared with `./connect`): build the bound client over an already-open connection. */
export function buildClient<S extends SchemaInput, C extends Queryable>(
  conn: C,
  schema: SchemaArg<S>,
  managed: boolean,
  options: BetterSchemicOptions,
): Client<S, C> {
  const pipeline = createPluginPipeline(options.plugins);
  const hooks = createHookDispatcher([
    options.hooks,
    ...(pipeline?.hooks ?? []),
  ]);
  return new ClientRuntime(
    conn,
    buildSchemaIndex(schema),
    managed,
    options.debug === true,
    {
      ...(options.transaction !== undefined
        ? { transaction: options.transaction }
        : {}),
      ...(options.live !== undefined ? { live: options.live } : {}),
      ...(options.raw !== undefined ? { raw: options.raw } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(pipeline !== undefined ? { pipeline } : {}),
    },
  ) as unknown as Client<S, C>;
}

/**
 * Get a bound ORM client over an EXISTING connection (BYO — `close()` is a no-op):
 *
 * ```ts
 * const db = new Surreal();
 * await db.connect("wss://localhost:8000/rpc");
 * await db.use({ namespace: "app", database: "main" });
 *
 * const client = betterSchemic(db, { schema });
 * // M1: await client.users.findMany({ where: { active: true } });
 * ```
 */
export function betterSchemic<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(
  conn: C,
  options: {
    readonly schema: SchemaArg<S>;
    readonly plugins?: P;
  } & Omit<BetterSchemicOptions, "plugins">,
): Client<S, C, P> {
  return buildClient(conn, options.schema, false, options) as unknown as Client<
    S,
    C,
    P
  >;
}
