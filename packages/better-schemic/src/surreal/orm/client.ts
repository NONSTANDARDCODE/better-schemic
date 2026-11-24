/**
 * The bound ORM client — `orm(conn, { schema })` wraps an EXISTING SurrealDB connection
 * (BYO; its `close()` is a no-op) with one delegate per schema entry. The managed counterpart
 * (`createOrm` / `clientFromConfig`) lives in `./connect`, which builds on this module.
 *
 * Landing in later milestones on the same client object: operation methods on the delegates
 * (M1 reads, M2 writes), `$raw`, transactions, hooks/plugins. Today it ships the lifecycle,
 * delegate resolution and the type-level key -> delegate mapping.
 */

import type { SurrealSession } from "surrealdb"

import { asyncDisposable, type OrmClientBase } from "../../core"

import { createAdminOperations } from "./admin"
import { createApiOperations } from "./api"
import { createAuthOperations } from "./auth"
import { assertContextKeys } from "./context"
import { createDelegate, type Delegate, type DelegateContext } from "./delegate"
import { OrmError } from "./errors"
import type { Queryable } from "./execute"
import { createFnOperations } from "./fn"
import { createHookDispatcher, type HookDispatcher } from "./hooks"
import { resolveLogger } from "./logger"
import { type ModelMeta, resolveModel, type SchemaIndex } from "./meta"
import { createPluginPipeline, type PluginPipeline } from "./plugins"
import { createRawOperations, type RawOperations } from "./raw"
import { buildSchemaIndex } from "./schema"
import {
  rollbackTransaction,
  runTransaction,
  type TransactionConnection,
  type TransactionHost,
  type TransactionState,
} from "./transaction"
import type { AdminOperations } from "./types/admin"
import type { ApiOperations } from "./types/api"
import type { AuthOperations } from "./types/auth"
import type { Client, Extension, OrmOptions, SchemaArg } from "./types/client"
import type { ContextAuth, ContextScope, OperationContext } from "./types/context"
import type { FnSurface } from "./types/fn"
import type { QueryLogger } from "./types/logger"
import type { Plugin } from "./types/plugins"
import type { RawDefaults } from "./types/raw"
import type { SchemaInput } from "./types/schema"
import type { TransactionDefaults, TransactionOptions } from "./types/transaction"

export type { Client, OrmOptions, OrmSurface, SchemaArg } from "./types/client"

/** The runtime behind every {@link Client} — the class members plus the per-key delegates. */
export class ClientRuntime<C extends Queryable = Queryable> implements OrmClientBase {
  /** `[Symbol.asyncDispose]` = `close()`, installed on the prototype by {@link asyncDisposable}. */
  declare [Symbol.asyncDispose]: () => Promise<void>

  /** Delegates by schema key (shared by `client.<key>` and `repository`). */
  private readonly delegates = new Map<string, Delegate>()

  /** The runtime services every delegate operation receives. */
  private readonly delegateContext: DelegateContext

  /** Client-level transaction defaults (`orm(conn, { schema, transaction: … })`). */
  private readonly transactionDefaults?: TransactionDefaults

  /** Present iff this client binds it to a transaction (the `tx` handle from the callback). */
  private readonly txState?: TransactionState

  /** Root clients : the transaction scope running on this client. */
  private rootScope?: TransactionState

  /** Client-level raw defaults (`orm(conn, { schema, raw: … })`). */
  private readonly rawDefaults?: RawDefaults

  /** The observation-hook dispatcher (`orm(conn, { schema, hooks })`); absent = fast path. */
  private readonly hooks?: HookDispatcher

  /** The plugin pipeline (`orm(conn, { schema, plugins })`); absent = no plugins. */
  private readonly pipeline?: PluginPipeline

  /** The query logger (`orm(conn, { schema, logger })`); absent = zero-overhead. */
  private readonly logger?: QueryLogger

  /** The clone's default namespace/database scope (`$withContext`); absent on a plain client. */
  private readonly context?: OperationContext

  /** Helpers attached with `extends`, re-applied to every clone (context/tx/fork). */
  private readonly extensions: Extension[] = []

  /** The raw escape hatches (`$raw`/`$query`/`$unsafe`) — built from the client context. */
  declare $raw: RawOperations["$raw"]
  declare $query: RawOperations["$query"]
  declare $unsafe: RawOperations["$unsafe"]
  /** Database functions (`fn.call` + the schema shortcuts). */
  declare fn: FnSurface
  /** `DEFINE API` endpoints. */
  declare api: ApiOperations
  /** Session authentication. */
  declare auth: AuthOperations
  declare info: ReturnType<typeof createAdminOperations>["info"]
  declare version: ReturnType<typeof createAdminOperations>["version"]
  declare ping: ReturnType<typeof createAdminOperations>["ping"]
  declare export: ReturnType<typeof createAdminOperations>["export"]
  declare import: ReturnType<typeof createAdminOperations>["import"]

  constructor(
    /** The wrapped connection — the SDK `Surreal` (or a `SurrealSession` when forked). */
    readonly conn: C,
    /** The validated schema metadata pass. */
    readonly $index: SchemaIndex,
    private readonly managed: boolean,
    private readonly debug: boolean,
    scope: {
      readonly context?: OperationContext
      readonly extensions?: readonly Extension[]
      readonly hooks?: HookDispatcher
      readonly logger?: QueryLogger
      readonly pipeline?: PluginPipeline
      readonly raw?: RawDefaults
      readonly transaction?: TransactionDefaults
      readonly txState?: TransactionState
    } = {},
  ) {
    this.transactionDefaults = scope.transaction
    this.txState = scope.txState
    this.rawDefaults = scope.raw
    this.hooks = scope.hooks
    this.pipeline = scope.pipeline
    this.logger = scope.logger
    this.context = scope.context
    this.delegateContext = {
      conn,
      debug,
      index: $index,
      ...(scope.txState ? { inTransaction: true } : {}),
      ...(scope.context ? { context: scope.context } : {}),
      ...(scope.hooks ? { hooks: scope.hooks } : {}),
      ...(scope.pipeline ? { pipeline: scope.pipeline } : {}),
      logger: scope.logger,
    }
    // Assign the fixed surfaces BEFORE the schema delegates so `assertMemberAvailable`'s
    // `name in this` check covers them — no hand-maintained reserved-name list to keep in sync.
    // Each member declars it ON THE CLASS and assigned HERE: Bun's AOT asks for this
    // ("declare every property in the class and assign them there") instead of `Object.assign`,
    // which mutates the shape after construction and keeps every access on a slow path.
    // Property-signature view (not the source's method signatures): these closures never use
    // `this`, so taking them off the object is safe and unbound-method sees plain properties.
    const raw: {
      $query: RawOperations["$query"]
      $raw: RawOperations["$raw"]
      $unsafe: RawOperations["$unsafe"]
    } = createRawOperations(this.delegateContext, scope.raw)
    this.$raw = raw.$raw
    this.$query = raw.$query
    this.$unsafe = raw.$unsafe
    this.fn = createFnOperations(this.delegateContext)
    this.api = createApiOperations(this.delegateContext)
    this.auth = createAuthOperations(this.delegateContext)
    const admin: {
      export: AdminOperations["export"]
      import: AdminOperations["import"]
      info: AdminOperations["info"]
      ping: AdminOperations["ping"]
      version: AdminOperations["version"]
    } = createAdminOperations(this.delegateContext)
    this.info = admin.info
    this.version = admin.version
    this.ping = admin.ping
    this.export = admin.export
    this.import = admin.import

    ;[...$index.tables, ...$index.schemaless].forEach(([key, meta]) => {
      this.assertMemberAvailable(key, "schema key")
      // Lazy: the delegate (and its ~26 operation closures) builts it on FIRST access, so
      // transaction/fork clients over a large schema don't rebuild every delegate per attempt.
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: true,
        get: () => this.delegateFor(key, meta),
      })
    })
    // Plugins: run `setup` once (fail-fast) and graft `extendClient` methods (collision = error).
    if (scope.pipeline) {
      scope.pipeline.setup($index)
      const methods = scope.pipeline.extendClient({
        client: this,
        index: $index,
      })

      Object.entries(methods).forEach(([name, value]) => {
        this.assertMemberAvailable(name, "extends")
        ;(this as Record<string, unknown>)[name] = value
      })
    }

    ;(scope.extensions ?? []).forEach((extension) => {
      this.applyExtension(extension)
    })
  }

  /**
   * Fail fast when a schema key or `extends` helper would shadow a client member. Every fixed
   * surface/method is already on `this` (see the constructor order), so `name in this` is the
   * source of truth; `then` guards it explicitly (a thenable client would break `await`).
   */
  private assertMemberAvailable(name: string, source: "extends" | "schema key"): void {
    if (name !== "then" && !name.startsWith("$") && !(name in this)) return

    throw new OrmError(
      source === "schema key" ? "SchemaInvalid" : "PluginError",
      `${source} "${name}" collides with a client member (or the reserved "then") — pick another name.`,
    )
  }

  /** The underlying SDK connection (the escape hatch for anything the ORM doesn't cover). */
  get $sdk(): C {
    return this.conn
  }

  /**
   * Run ONE raw statement and return the FIRST statement's rows — the neutral
   * `ctx.connections.<name>.query` handle a sibling connection resolver uses (core's
   * `ResolvedConnectionHandle`). Values bind them through `vars`; for the richer raw surface
   * (`$query`/`$unsafe`, options, multi-statement) use the `$`-prefixed escape hatches.
   */
  query<T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
    return this.conn.query<T[][]>(sql, vars).then((r) => r[0] ?? [])
  }

  /** The schema keys exposed as delegates, in schema order. */
  get tables(): readonly string[] {
    return [...this.$index.tables.keys(), ...this.$index.schemaless.keys()]
  }

  /** Build (once) and cache a delegate for a schema key. */
  private delegateFor(key: string, meta: ModelMeta): Delegate {
    const existing = this.delegates.get(key)
    if (existing) return existing

    const delegate = createDelegate(meta, this.delegateContext)
    this.delegates.set(key, delegate)
    return delegate
  }

  /** Resolve a delegate by schema key OR physical table name. */
  repository(name: string): Delegate {
    const meta = resolveModel(this.$index, name)
    if (meta) return this.delegateFor(meta.key, meta)

    throw new OrmError(
      "RepositoryNotFound",
      `repository("${name}"): no schema entry has that key or physical name. Known: ${this.tables.join(", ") || "(none)"}.`,
      { details: { known: this.tables } },
    )
  }

  /**
   * Run `fn` inside a managed transaction (the typed surface lives on {@link Client}): the
   * callback receives a full client bound to it, success commits, any exception cancels and
   * propagates. The runtime lives in `./transaction`.
   */
  transaction<T>(fn: (tx: unknown) => Promise<T> | T, options?: TransactionOptions): Promise<T> {
    return runTransaction(this as TransactionHost, fn, options)
  }

  /** INTERNAL (TransactionHost): client-level transaction defaults. */
  $transactionDefaults(): TransactionDefaults | undefined {
    return this.transactionDefaults
  }

  /** INTERNAL (TransactionHost): the observation-hook dispatcher (absent = no hooks). */
  $hooks(): HookDispatcher | undefined {
    return this.hooks
  }

  /** INTERNAL (TransactionHost): the transaction state when bound to one. */
  $txState(): TransactionState | undefined {
    return this.txState
  }

  /** INTERNAL (TransactionHost): the transaction scope running on this root client. */
  $rootScope(): TransactionState | undefined {
    return this.rootScope
  }

  /** INTERNAL (TransactionHost): set/clear the running scope. */
  $setRootScope(state: TransactionState | undefined): void {
    this.rootScope = state
  }

  /** Register an `afterCommit` callback on the CURRENT scope (`ValidationError` outside one). */
  afterCommit(callback: () => Promise<void> | void): void {
    this.activeScope("afterCommit").addAfterCommit(callback)
  }

  /** Register an `afterRollback` callback on the CURRENT scope (`ValidationError` outside one). */
  afterRollback(callback: (reason: unknown) => Promise<void> | void): void {
    this.activeScope("afterRollback").addAfterRollback(callback)
  }

  /** The authoritative scope for callback registration: the tx handle, else the root scope. */
  private activeScope(name: string): TransactionState {
    let state = this.txState?.active ? this.txState : undefined
    if (state === undefined && this.rootScope?.active) state = this.rootScope
    if (!state) {
      throw new OrmError(
        "ValidationError",
        `client.${name}(...) needs an active transaction — call it inside client.transaction(async (tx) => { … }) (or use tx.${name}).`,
      )
    }
    return state
  }

  /**
   * Build the transaction-bound client (INTERNAL — consumed by {@link runTransaction}): the same
   * schema and options over the transaction connection, sharing the attempt's state.
   */
  buildTransactionClient(conn: TransactionConnection, state: TransactionState): ClientRuntime {
    return new ClientRuntime(conn as unknown as C, this.$index, false, this.debug, {
      ...this.childScope(),
      txState: state,
    })
  }

  /** The options a child client inherits (defaults, context, extensions). */
  private childScope(keepContext = true): {
    context?: OperationContext
    extensions: readonly Extension[]
    hooks?: HookDispatcher
    logger?: QueryLogger
    pipeline?: PluginPipeline
    raw?: RawDefaults
    transaction?: TransactionDefaults
  } {
    return {
      ...(this.transactionDefaults === undefined ? {} : { transaction: this.transactionDefaults }),
      ...(this.rawDefaults === undefined ? {} : { raw: this.rawDefaults }),
      ...(keepContext && this.context !== undefined ? { context: this.context } : {}),
      extensions: this.extensions,
      ...(this.hooks === undefined ? {} : { hooks: this.hooks }),
      ...(this.pipeline === undefined ? {} : { pipeline: this.pipeline }),
      logger: this.logger,
    }
  }

  /**
   * Attach project helpers to the client (object or factory receiving the client). An existing member name
   * fails fast — silent shadowing of the ORM surface is a DX
   * trap, not a feature.
   *
   * ```ts
   * const db = orm(conn, { schema }).extends({
   *   async activeUsers(this: Client<Schema>) {
   *     return this.repository("users"); // M1: this.users.findMany({ where: { active: true } })
   *   },
   * });
   * ```
   */

  extends<T extends Record<string, unknown>>(extension: ((client: this) => T) | T): this & T {
    const entry = extension as Extension
    this.extensions.push(entry)
    this.applyExtension(entry)
    return this as this & T
  }

  /** Apply one stored extension to THIS client (called on creation and by `extends`). */
  private applyExtension(extension: Extension): void {
    const resolved = typeof extension === "function" ? extension(this) : extension

    Object.entries(resolved).forEach(([name, value]) => {
      this.assertMemberAvailable(name, "extends")
      ;(this as Record<string, unknown>)[name] = value
    })
  }

  /**
   * Fork a scoped, disposable session (its own auth/session context) with the same schema
   * delegates. Project helpers added via {@link extends} are re-applied to the fork.
   */
  async forkSession(): Promise<ClientRuntime> {
    const sdk = this.conn as unknown as {
      forkSession?: () => Promise<SurrealSession>
    }
    if (typeof sdk.forkSession !== "function") {
      throw new OrmError(
        "UnsupportedCapability",
        "forkSession() needs the SurrealDB SDK connection — this client wraps an object without `forkSession()`.",
      )
    }
    const session = await sdk.forkSession()
    // A fork never owns the parent: `close()` on the fork disposes the session .
    return new ClientRuntime(session, this.$index, true, this.debug, this.childScope(false))
  }

  /**
   * A clone that routes every compiled operation to `namespace`/`database` in the SAME round-trip
   * (`USE NS … DB …;`) without touching the connection's session. With `auth`, the clone owns a
   * FORKED session instead (returned as a Promise) so session-bound operations work scoped too.
   */
  $withContext(context: ContextScope = {}): ClientRuntime | Promise<ClientRuntime> {
    const { auth, ...scope } = context
    assertContextKeys(scope)
    if (auth !== undefined) return this.scopedSession(scope, auth)

    return new ClientRuntime(this.conn, this.$index, false, this.debug, {
      ...this.childScope(false),
      context: scope,
    })
  }

  /** The `auth` overload: fork a session, select the scope on it and authenticate. */
  private async scopedSession(scope: OperationContext, auth: ContextAuth): Promise<ClientRuntime> {
    const session = await this.forkSession()
    const sdk = session.conn as unknown as {
      authenticate?: (token: ContextAuth) => Promise<unknown>
      database?: string
      namespace?: string
      use?: (what: { database?: string; namespace?: string }) => Promise<unknown>
    }
    const namespace = scope.namespace ?? sdk.namespace
    const database = scope.database ?? sdk.database
    if (!namespace || !database) {
      throw new OrmError(
        "ValidationError",
        "$withContext({ auth }): the scoped session needs BOTH namespace and database — pass them, or select them on the parent connection first.",
      )
    }
    if (typeof sdk.use !== "function" || typeof sdk.authenticate !== "function") {
      throw new OrmError(
        "UnsupportedCapability",
        "$withContext({ auth }) needs the SurrealDB SDK connection (a forkable session).",
      )
    }
    await sdk.use({ database, namespace })
    await sdk.authenticate(auth)
    return session
  }

  /**
   * Abort the transaction this client binds it to ( the `tx` handle has one): cancels it and
   * makes the surrounding `transaction(...)` reject with `TransactionRollback`. Typed `never` on
   * {@link TransactionClient.rollback}.
   */
  rollback(reason?: unknown): never {
    if (!this.txState) {
      throw new OrmError(
        "ValidationError",
        "rollback() is only available on the `tx` client inside client.transaction(...).",
      )
    }
    return rollbackTransaction(this.txState, reason)
  }

  /**
   * Close the connection — MANAGED clients (opened by `createOrm`/the config) close what
   * they opened; a BYO client is a NO-OP (never close the user's connection).
   */
  async close(): Promise<void> {
    if (!this.managed) return

    const sdk = this.conn as unknown as {
      close?: () => Promise<void>
      closeSession?: () => Promise<void>
    }
    if (typeof sdk.close === "function") await sdk.close()
    else if (typeof sdk.closeSession === "function") await sdk.closeSession()
  }
}
asyncDisposable(ClientRuntime.prototype)

/** INTERNAL (shared with `./connect`): build the bound client over an already-open connection. */
export function buildClient<S extends SchemaInput, C extends Queryable>(
  conn: C,
  schema: SchemaArg<S>,
  managed: boolean,
  options: OrmOptions,
): Client<S, C> {
  const pipeline = createPluginPipeline(options.plugins)
  const hooks = createHookDispatcher([options.hooks, ...(pipeline?.hooks ?? [])])
  const logger = resolveLogger(options.logger)
  return new ClientRuntime(conn, buildSchemaIndex(schema), managed, options.debug === true, {
    ...(options.transaction === undefined ? {} : { transaction: options.transaction }),
    ...(options.raw === undefined ? {} : { raw: options.raw }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(pipeline === undefined ? {} : { pipeline }),
    logger,
  }) as unknown as Client<S, C>
}

/**
 * Get a bound ORM client over an EXISTING connection (BYO — `close()` is a no-op):
 *
 * ```ts
 * const db = new Surreal();
 * await db.connect("wss://localhost:8000/rpc");
 * await db.use({ namespace: "app", database: "main" });
 *
 * const client = orm(db, { schema });
 * // M1: await client.users.findMany({ where: { active: true } });
 * ```
 */
export function orm<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(
  conn: C,
  options: {
    readonly plugins?: P
    readonly schema: SchemaArg<S>
  } & Omit<OrmOptions, "plugins">,
): Client<S, C, P>
/** Lazy connection factory or an existing connection — one signature for both call shapes. */
export function orm<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(
  connOrFactory: (() => C) | C,
  options: {
    readonly plugins?: P
    readonly schema: SchemaArg<S>
  } & Omit<OrmOptions, "plugins">,
): Client<S, C, P> {
  const conn = typeof connOrFactory === "function" ? connOrFactory() : connOrFactory
  return buildClient(conn, options.schema, false, options) as unknown as Client<S, C, P>
}

/** A factory that hands out ORM clients over BYO connections, optionally caching one client per
 *  connection (WeakMap). This is the library-side replacement for an app-level
 *  `WeakMap<object, OrmClient>`: `peek`/`dispose` are explicit, and `Name`/`S` survive the cache. */
export type OrmClientFactory<
  S extends SchemaInput,
  C extends Queryable,
  P extends readonly Plugin[] = readonly [],
> = {
  (conn: C): Client<S, C, P>
  /** Forget the cached client (the connection itself untouchs it). */
  dispose(conn: C): void
  /** The cached client for `conn`, if any — never builds one. */
  peek(conn: C): Client<S, C, P> | undefined
}

export function createOrmClientFactory<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(
  options: {
    readonly cache?: "none" | "weak"
    readonly plugins?: P
    readonly schema: SchemaArg<S>
  } & Omit<OrmOptions, "cache" | "plugins">,
): OrmClientFactory<S, C, P> {
  const cache =
    options.cache === "weak" ? new WeakMap<Record<string, unknown>, Client<S, C, P>>() : undefined
  const build = (conn: C): Client<S, C, P> => {
    const key = conn as unknown as Record<string, unknown>
    const hit = cache?.get(key)
    if (hit) return hit

    const client = orm<S, C, P>(conn, options)
    cache?.set(key, client)
    return client
  }
  return Object.assign(build, {
    dispose: (conn: C) => void cache?.delete(conn as unknown as Record<string, unknown>),

    peek: (conn: C) => cache?.get(conn as unknown as Record<string, unknown>),
  })
}

// A late-bound client resolver: the ORM knows the schema but not the connection that owns it
// (e.g. an ALS `SurrealSession`). `clientRef()` gives schema modules a stable reference with no
// dynamic import. Mirrors `tenantRls({ tenant: () => ctx.tenantId })`'s per-operation late binding.
type ResolvedClient = Client<SchemaInput, Queryable, readonly Plugin[]>
const CLIENT_RESOLVERS = new Map<string, () => ResolvedClient>()
const DEFAULT_RESOLVER = "default"

/** Register (or replace) the lazy resolver behind {@link clientRef}. */
export function setClientResolver<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(resolve: () => Client<S, C, P>, key: string = DEFAULT_RESOLVER): void {
  CLIENT_RESOLVERS.set(key, resolve)
}

/** A stable, typed reference to a client resolved on every operation. */
export function clientRef<
  S extends SchemaInput,
  C extends Queryable,
  const P extends readonly Plugin[] = readonly [],
>(key: string = DEFAULT_RESOLVER): { current(): Client<S, C, P> } {
  return {
    current: (): Client<S, C, P> => {
      const resolve = CLIENT_RESOLVERS.get(key)
      if (!resolve) {
        throw new Error(
          `better-schemic: no ORM client resolver registered for "${key}" — call setClientResolver() first.`,
        )
      }
      return resolve() as Client<S, C, P>
    },
  }
}
