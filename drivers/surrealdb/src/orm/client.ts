/**
 * The bound ORM client — `betterSchemic(conn, { schema })` wraps an EXISTING SurrealDB connection
 * (BYO; its `close()` is a no-op) with one delegate per schema entry, while
 * `createBetterSchemic({ url, … })` opens (and owns) the connection for you.
 *
 * Landing in later milestones on the same client object: operation methods on the delegates
 * (M1 reads, M2 writes), `$raw`, transactions, live, hooks/plugins. M0.5 ships the lifecycle,
 * delegate resolution and the type-level key -> delegate mapping.
 */
import {
  asyncDisposable,
  type OrmClientBase,
  type ResolvedConfig,
} from "@better-schemic/core";
import { escapeIdent, Surreal, type SurrealSession } from "surrealdb";
import { surrealDriver } from "../driver";
import { createDelegate, type Delegate } from "./delegate";
import { BetterSchemicError, normalizeError } from "./errors";
import type { Queryable } from "./execute";
import { buildSchemaIndex, type SchemaIndex } from "./schema";
import type { ModelKeys, SchemaDef, SchemaInput } from "./types/schema";

/** Options accepted by `betterSchemic(...)` — grows per milestone (plugins/hooks/raw/...). */
export interface BetterSchemicOptions {
  /** Attach statement `vars` to thrown errors (off by default — vars can hold user data). */
  readonly debug?: boolean;
}

/** A `defineSchema` artifact or the plain `{ key: def }` literal. */
export type SchemaArg<S extends SchemaInput> = SchemaDef<S> | S;

/** Client members a schema key may not shadow (checked at bootstrap, fail-fast). */
const RESERVED = new Set([
  "conn",
  "$index",
  "tables",
  "repository",
  "extends",
  "forkSession",
  "close",
  "$sdk",
  "then",
]);

/**
 * The public client type: lifecycle members + one {@link Delegate} per schema key
 * (`client.users`, `client.likes`, …). `C` is the wrapped connection type (`Surreal` for a
 * root client, `SurrealSession` for a forked one).
 */
export type Client<S = SchemaInput, C extends Queryable = Queryable> = Omit<
  ClientRuntime<C>,
  "extends" | "forkSession"
> & {
  readonly [K in ModelKeys<S>]: Delegate;
} & {
  /**
   * Attach project helpers to the client (object or factory receiving the client). A name
   * colliding with an existing member fails fast.
   */
  extends<T extends object>(
    extension: T | ((client: Client<S, C>) => T),
  ): Client<S, C> & T;
  /** A client over a scoped, disposable SDK session (its own auth/session context). */
  forkSession(): Promise<Client<S>>;
};

/** The runtime behind every {@link Client} — the class members plus the per-key delegates. */
export class ClientRuntime<C extends Queryable = Queryable>
  implements OrmClientBase
{
  /** `[Symbol.asyncDispose]` = `close()`, installed on the prototype by {@link asyncDisposable}. */
  declare [Symbol.asyncDispose]: () => Promise<void>;

  /** Delegates by schema key (shared by `client.<key>` and `repository`). */
  private readonly delegates = new Map<string, Delegate>();

  constructor(
    /** The wrapped connection — the SDK `Surreal` (or a `SurrealSession` when forked). */
    readonly conn: C,
    /** The validated schema metadata pass. */
    readonly $index: SchemaIndex,
    private readonly managed: boolean,
    private readonly debug: boolean,
  ) {
    for (const [key, meta] of [
      ...$index.tables,
      ...$index.schemaless,
    ] as const) {
      if (RESERVED.has(key) || key.startsWith("$") || key in this)
        throw new BetterSchemicError(
          "SchemaInvalid",
          `schema key "${key}" collides with a client member — rename it (reserved: ${[...RESERVED].join(", ")}, plus every client method).`,
        );
      const delegate = createDelegate(meta);
      this.delegates.set(key, delegate);
      (this as Record<string, unknown>)[key] = delegate;
    }
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
    const meta = this.$index.byName.get(name);
    const byName = meta ? this.delegates.get(meta.key) : undefined;
    if (byName) return byName;
    throw new BetterSchemicError(
      "RepositoryNotFound",
      `repository("${name}"): no schema entry has that key or physical name. Known: ${[...this.delegates.keys()].join(", ") || "(none)"}.`,
      { details: { known: [...this.delegates.keys()] } },
    );
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
    const resolved =
      typeof extension === "function"
        ? (extension as (client: this) => T)(this)
        : extension;
    for (const [name, value] of Object.entries(resolved)) {
      if (RESERVED.has(name) || name.startsWith("$") || name in this)
        throw new BetterSchemicError(
          "PluginError",
          `extends: "${name}" collides with an existing client member — pick another name.`,
        );
      (this as Record<string, unknown>)[name] = value;
    }
    return this as this & T;
  }

  /**
   * Fork a scoped, disposable session (its own auth/session context) with the same schema
   * delegates. Project helpers added via {@link extends} are NOT re-applied (M5.3 revisits this).
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
    );
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

function buildClient<S extends SchemaInput, C extends Queryable>(
  conn: C,
  schema: SchemaArg<S>,
  managed: boolean,
  options: BetterSchemicOptions,
): Client<S, C> {
  const index = buildSchemaIndex(schema);
  return new ClientRuntime(
    conn,
    index as SchemaIndex,
    managed,
    options.debug === true,
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
export function betterSchemic<S extends SchemaInput, C extends Queryable>(
  conn: C,
  options: { readonly schema: SchemaArg<S> } & BetterSchemicOptions,
): Client<S, C> {
  return buildClient(conn, options.schema, false, options);
}

/** Authentication for {@link createBetterSchemic}: a system user, or a record-access signin. */
export type BetterSchemicAuth =
  | { readonly username: string; readonly password: string }
  | { readonly access: string; readonly variables: Record<string, unknown> };

/** Options for {@link createBetterSchemic} — the managed (connect + authenticate + use) sugar. */
export interface CreateBetterSchemicOptions<S extends SchemaInput>
  extends BetterSchemicOptions {
  /** The WebSocket/HTTP endpoint, e.g. `wss://localhost:8000/rpc`. */
  readonly url: string;
  readonly namespace?: string;
  readonly database?: string;
  readonly auth?: BetterSchemicAuth;
  /** Give up (and close) if the connection handshake doesn't complete in time. */
  readonly connectTimeoutMs?: number;
  readonly schema: SchemaArg<S>;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Open (and OWN) a SurrealDB connection, authenticate, select the namespace/database and return a
 * bound ORM client — `close()` closes the connection it opened:
 *
 * ```ts
 * const client = await createBetterSchemic({
 *   url: "wss://localhost:8000/rpc", namespace: "app", database: "main",
 *   auth: { username: "root", password: "root" },
 *   schema,
 * });
 * ```
 */
export async function createBetterSchemic<S extends SchemaInput>(
  options: CreateBetterSchemicOptions<S>,
): Promise<Client<S, Surreal>> {
  const conn = new Surreal();
  try {
    const connecting = conn.connect(options.url, { reconnect: false });
    await (options.connectTimeoutMs === undefined
      ? connecting
      : withTimeout(
          connecting,
          options.connectTimeoutMs,
          `createBetterSchemic: connect to ${options.url} timed out after ${options.connectTimeoutMs}ms.`,
        ));
    if (options.auth) {
      if ("access" in options.auth)
        await conn.signin({
          access: options.auth.access,
          variables: options.auth.variables,
        });
      else
        await conn.signin({
          username: options.auth.username,
          password: options.auth.password,
        });
    }
    // Best-effort: create the namespace/database when we likely have the rights, then select them.
    // (A database user can't define either; a namespace user can define databases; root can do both.)
    const { namespace, database } = options;
    try {
      if (namespace) {
        await conn.query(
          `DEFINE NAMESPACE IF NOT EXISTS ${escapeIdent(namespace)};`,
        );
        await conn.use({ namespace });
      }
      if (database) {
        await conn.query(
          `DEFINE DATABASE IF NOT EXISTS ${escapeIdent(database)};`,
        );
      }
    } catch {
      // insufficient privileges — assume the namespace/database already exist
    }
    if (namespace || database) await conn.use({ namespace, database });
  } catch (e) {
    await conn.close().catch(() => {});
    throw normalizeError(e, { operation: "connect" });
  }
  return buildClient(conn, options.schema, true, options);
}

/**
 * Open a MANAGED client from an already-resolved project config — the opener the
 * `surrealConnection` factory embeds so `defineConfig(...).connect(name)` hands back an owned
 * client. Lazy-imported by the connection factory so authoring a config never pulls the engine.
 *
 * The config carries no schema (the schema modules live with the app), so this client exposes the
 * lifecycle + `repository()` over an EMPTY index; use `betterSchemic(conn, { schema })` for the
 * typed delegates.
 */
export async function clientFromConfig(
  config: ResolvedConfig,
): Promise<Client<SchemaInput, Surreal>> {
  const conn = await surrealDriver.connect(config);
  return buildClient(conn, {} as SchemaInput, true, {});
}
