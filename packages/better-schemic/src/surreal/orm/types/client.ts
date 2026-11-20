/**
 * The public client contract — the typed {@link Client} facade, its bootstrap options and the
 * `extends` extension shape. Kept OUT of the runtime (`../client`) so the class stays class-sized:
 * every member here is a type-level view over {@link ClientRuntime} (the untyped implementation).
 */

import type { ClientRuntime } from "../client";
import type { ModelDelegate } from "../delegate";
import type { Queryable } from "../execute";
import type { RawOperations } from "../raw";
import type { DbInfo, NsInfo, RootInfo, TableInfo } from "./admin";
import type { ApiOperations } from "./api";
import type { AuthOperations } from "./auth";
import type { ContextAuth, ContextScope, OperationContext } from "./context";
import type { FnSurface } from "./fn";
import type { Hooks } from "./hooks";
import type { LoggerOption } from "./logger";
import type { Plugin, PluginClientExtras, PluginList } from "./plugins";
import type { RawDefaults } from "./raw";
import type {
  AnyTableDef,
  EntriesOf,
  ModelKeys,
  SchemaDef,
  SchemaInput,
} from "./schema";
import type {
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
} from "./transaction";

/** Options accepted by `orm(...)` — grows per milestone (plugins/hooks/raw/...). */
export interface OrmOptions {
  /** Attach statement `vars` to thrown errors (off by default — vars can hold user data). */
  readonly debug?: boolean;
  /** Defaults for `client.transaction(...)` (mode/retries/timeout/isolation policy). */
  readonly transaction?: TransactionDefaults;
  /** Raw escape-hatch defaults (`unsafe`/`requireComment`/`timeoutMs`). */
  readonly raw?: RawDefaults;
  /**
   * Observation hooks — logging/tracing/metrics around every operation. Hooks never change args or
   * results; registering none keeps the client on its zero-overhead fast path.
   */
  readonly hooks?: Hooks;
  /**
   * Plugins — mutate operations (`transform`), contribute hooks, extend the client/delegates and
   * add typed per-operation args. Their `operationArgs`/extension return types are folded into the
   * client type when the tuple is passed as a literal.
   */
  readonly plugins?: readonly Plugin[];
  /**
   * Query logger — `true`, a preset (`"pretty"`/`"json"`/`"compact"`/`"silent"`),
   * {@link LoggerOptions}, or an already-built {@link QueryLogger} (e.g. `createOtelLogger(...)`
   * from `better-schemic/otel`). It observes every executor round-trip (delegate reads/writes,
   * `$raw`, `fn`, admin, changes, live and `.explain()` plans) without changing anything.
   * `undefined` falls back to `BETTER_SCHEMIC_LOG`; `false` disables it. Default output is a framed
   * terminal box.
   */
  readonly logger?: LoggerOption;
  /**
   * Cache clients per connection in the factory returned by {@link createOrmClientFactory}.
   * Default `"none"` (each call builds a fresh client). `"weak"` keeps a WeakMap keyed by the
   * connection; safe for BYO connections because their `close()` is a no-op, so a cached client
   * can never outlive a connection the consumer has closed.
   */
  readonly cache?: "none" | "weak";
}

/** A `schema` artifact or the plain `{ key: def }` literal. */
export type SchemaArg<S extends SchemaInput> = SchemaDef<S> | S;

/** A project helper attached with `extends` (an object, or a factory receiving the client). */
export type Extension = object | ((client: ClientRuntime) => object);

/**
 * The public client type: lifecycle members + one {@link ModelDelegate} per schema key
 * (`client.users`, `client.likes`, …). A schemaless entry maps to a loosely-typed delegate over
 * `Record<string, unknown>` rows. `C` is the wrapped connection type (`Surreal` for a root client,
 * `SurrealSession` for a forked one).
 *
 * The surface members are re-typed here from their runtime module's interface (indexed access), so
 * each signature has exactly ONE source of truth (`RawOperations`, `AdminOperations`, …).
 */
export type Client<
  S = SchemaInput,
  C extends Queryable = Queryable,
  P extends PluginList = readonly [],
> = Omit<
  ClientRuntime<C>,
  | "extends"
  | "forkSession"
  | "transaction"
  | "afterCommit"
  | "afterRollback"
  | "buildTransactionClient"
  | "rollback"
  | "$transactionDefaults"
  | "$txState"
  | "$rootScope"
  | "$setRootScope"
  | "$hooks"
  | "$raw"
  | "$query"
  | "$unsafe"
  | "fn"
  | "info"
  | "$withContext"
> & {
  readonly [K in ModelKeys<S>]: ModelDelegate<
    EntriesOf<S>[K] extends AnyTableDef ? EntriesOf<S>[K] : AnyTableDef,
    S,
    P
  >;
} & PluginClientExtras<P> & {
    /**
     * Attach project helpers to the client (object or factory receiving the client). A name
     * colliding with an existing member fails fast.
     */
    extends<T extends object>(
      extension: T | ((client: Client<S, C, P>) => T),
    ): Client<S, C, P> & T;
    /** A client over a scoped, disposable SDK session (its own auth/session context). */
    forkSession(): Promise<Client<S, Queryable, P>>;
    /**
     * Run `fn` inside a MANAGED transaction: `tx` is a full client bound to it (every operation
     * rides the same transaction). Success commits; any exception cancels and propagates. Nested
     * `tx.transaction(...)` runs in the SAME transaction; opening one from the root client while
     * another is active throws `TransactionAlreadyActive`.
     *
     * ```ts
     * const from = await client.transaction(async (tx) => {
     *   const user = await tx.users.update({ where: { id }, mode: "set", data: { balance: surql`balance - ${100}` }, return: "after" }).throw();
     *   await tx.accounts.update({ where: { id: to }, mode: "set", data: { balance: surql`balance + ${100}` } });
     *   tx.afterCommit(() => mailer.send(user.email)); // outside effects run only after the commit
     *   return user;
     * });
     * ```
     */
    transaction<T>(
      fn: (tx: TransactionClient<S, P>) => T | Promise<T>,
      options?: TransactionOptions,
    ): Promise<T>;
    /** Register a side effect for the CURRENT transaction's commit (`ValidationError` outside one). */
    afterCommit(callback: () => void | Promise<void>): void;
    /** Register a side effect for the CURRENT transaction's rollback (`ValidationError` outside one). */
    afterRollback(callback: (reason: unknown) => void | Promise<void>): void;
    /**
     * Run ONE raw statement, parameterized by the tagged template — each `${…}` becomes a `$p<n>`
     * bind (a `surql` fragment splices). The generic types the first statement's result.
     *
     * ```ts
     * const rows = await client.$raw<User[]>`SELECT * FROM users WHERE email = ${email}`;
     * // With raw options (e.g. `meta.comment` under `raw.requireComment`):
     * const rows = await client.$raw({ meta: { comment: "seed" } })`CREATE …`;
     * ```
     */
    readonly $raw: RawOperations["$raw"];
    /** Run SEVERAL raw statements in one round-trip (`throwOnError: false` widens the result). */
    readonly $query: RawOperations["$query"];
    /**
     * Run a RAW string (no interpolation). Disabled unless `raw: { unsafe: true }`; prefer
     * `$raw`/`$query`, which parameterize every value.
     */
    readonly $unsafe: RawOperations["$unsafe"];
    /** Database functions: dynamic `fn.call(name, args)` + one typed shortcut per schema function. */
    readonly fn: FnSurface<S>;
    /** `DEFINE API` endpoints (session-bound — a context clone rejects them). */
    readonly api: ApiOperations;
    /** Session authentication (session-bound — a context clone rejects them). */
    readonly auth: AuthOperations;
    /** `INFO FOR ROOT` / `NS` / `DB` / `TABLE <t>` (context-aware). */
    info(level: "root"): Promise<RootInfo>;
    info(level: "ns"): Promise<NsInfo>;
    info(level: "db"): Promise<DbInfo>;
    info(level: "table", table: string): Promise<TableInfo>;
    /**
     * A clone that routes every operation to `namespace`/`database` in the SAME round-trip
     * (`USE NS … DB …;`), never touching the connection's session. A per-call `context` overrides it.
     *
     * With `auth` (a token), the clone owns a FORKED session instead — returning a Promise — so
     * session-bound operations (`api`/`auth`/`export`/`live`) work against the scoped database too.
     */
    $withContext(
      context: ContextScope & { auth: ContextAuth },
    ): Promise<Client<S>>;
    $withContext(context?: OperationContext): Client<S, C>;
  };

/**
 * The static façade over a client: one readonly member per schema model plus the fixed escape
 * hatches. `sc generate:orm` emits a source file with STATIC getters satisfying this type — Bun's
 * AOT needs the getters written in the source (a runtime `Object.defineProperty` loop over schema
 * keys is exactly the slow path this replaces). The runtime `Client` still derives every key from
 * the schema; the generated file is only the AOT-friendly view of it.
 */
export type OrmSurface<
  S = SchemaInput,
  C extends Queryable = Queryable,
  P extends PluginList = readonly [],
> = Pick<
  Client<S, C, P>,
  | ModelKeys<S>
  | "$query"
  | "$raw"
  | "$unsafe"
  | "$sdk"
  | "repository"
  | "tables"
  | "transaction"
>;
