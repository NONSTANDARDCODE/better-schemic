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
import type { ChangeRow, ChangeSet, ChangesArgs } from "./changes";
import type { ContextAuth, ContextScope, OperationContext } from "./context";
import type { FnSurface } from "./fn";
import type { Hooks } from "./hooks";
import type {
  LiveArgs,
  LiveDefaults,
  LiveHandler,
  LiveId,
  LiveResult,
  LiveRow,
  LiveSubscription,
} from "./live";
import type { Plugin, PluginClientExtras, PluginList } from "./plugins";
import type { RawDefaults } from "./raw";
import type {
  AnyTableDef,
  EntriesOf,
  ModelKeys,
  SchemaDef,
  SchemaInput,
  TableAt,
} from "./schema";
import type {
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
} from "./transaction";

/** Options accepted by `betterSchemic(...)` — grows per milestone (plugins/hooks/raw/...). */
export interface BetterSchemicOptions {
  /** Attach statement `vars` to thrown errors (off by default — vars can hold user data). */
  readonly debug?: boolean;
  /** Defaults for `client.transaction(...)` (mode/retries/timeout/isolation policy). */
  readonly transaction?: TransactionDefaults;
  /** Defaults for live queries (`reconnect`/`checkFeature`). */
  readonly live?: LiveDefaults;
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
}

/** A `defineSchema` artifact or the plain `{ key: def }` literal. */
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
  | "live"
  | "liveOf"
  | "kill"
  | "changes"
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
     * Subscribe to server-pushed changes of `table` (a schema key — use `repository(name).live`
     * for a physical name). Same lowering as the delegate `live`:
     * `LIVE SELECT [DIFF] <projeção> FROM t [WHERE …] [FETCH …]`.
     */
    live<
      const K extends ModelKeys<S> & string,
      const A extends LiveArgs<TableAt<S, K>, S>,
    >(
      table: K,
      args?: A,
      handler?: LiveHandler<LiveRow<TableAt<S, K>, A>>,
    ): LiveResult<TableAt<S, K>, A>;
    /**
     * Reattach to an existing live query (`UnmanagedLiveSubscription`): iterate or pass a handler.
     * Values are NOT decoded (there is no table meta to decode with) — `recordId` and raw rows.
     */
    liveOf(
      uuid: LiveId,
      handler?: LiveHandler<Record<string, unknown>>,
    ): Promise<LiveSubscription<Record<string, unknown>>>;
    /** End a live query on the server by uuid (idempotent; validated + bound). */
    kill(uuid: LiveId): Promise<void>;
    /**
     * Read the schema changefeed (`SHOW CHANGES`) — `table` (schema key or physical name; omit for
     * DATABASE-level), `since` (versionstamp/Date/ISO, inclusive) and `limit`. Paginate with
     * `last.versionstamp + 1`. Rows decode through the model codec.
     */
    changes<const A extends ChangesArgs<S>>(
      args?: A,
    ): Promise<ChangeSet<ChangeRow<S, A>>[]>;
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
