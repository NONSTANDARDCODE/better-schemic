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
import {
  createDelegate,
  type Delegate,
  type DelegateContext,
  type ModelDelegate,
} from "./delegate";
import { BetterSchemicError } from "./errors";
import type { Queryable } from "./execute";
import type { SchemaIndex } from "./meta";
import { buildSchemaIndex } from "./schema";
import type {
  AnyTableDef,
  EntriesOf,
  ModelKeys,
  SchemaDef,
  SchemaInput,
} from "./types/schema";

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
 * (`client.users`, `client.likes`, …). A schemaless entry maps to a loosely-typed delegate over
 * `Record<string, unknown>` rows. `C` is the wrapped connection type (`Surreal` for a root client,
 * `SurrealSession` for a forked one).
 */
export type Client<S = SchemaInput, C extends Queryable = Queryable> = Omit<
  ClientRuntime<C>,
  "extends" | "forkSession"
> & {
  readonly [K in ModelKeys<S>]: ModelDelegate<
    EntriesOf<S>[K] extends AnyTableDef ? EntriesOf<S>[K] : AnyTableDef
  >;
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

  /** The runtime services every delegate operation receives. */
  private readonly delegateContext: DelegateContext;

  constructor(
    /** The wrapped connection — the SDK `Surreal` (or a `SurrealSession` when forked). */
    readonly conn: C,
    /** The validated schema metadata pass. */
    readonly $index: SchemaIndex,
    private readonly managed: boolean,
    private readonly debug: boolean,
  ) {
    this.delegateContext = { conn, index: $index, debug };
    for (const [key, meta] of [...$index.tables, ...$index.schemaless]) {
      this.assertMemberAvailable(key, "schema key");
      const delegate = createDelegate(meta, this.delegateContext);
      this.delegates.set(key, delegate);
      (this as Record<string, unknown>)[key] = delegate;
    }
  }

  /** Fail fast when a schema key or `extends` helper would shadow a client member. */
  private assertMemberAvailable(
    name: string,
    source: "schema key" | "extends",
  ): void {
    if (!RESERVED.has(name) && !name.startsWith("$") && !(name in this)) return;
    throw new BetterSchemicError(
      source === "schema key" ? "SchemaInvalid" : "PluginError",
      `${source} "${name}" collides with a client member — pick another name (reserved: ${[...RESERVED].join(", ")}, plus every client method).`,
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
      this.assertMemberAvailable(name, "extends");
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

/** INTERNAL (shared with `./connect`): build the bound client over an already-open connection. */
export function buildClient<S extends SchemaInput, C extends Queryable>(
  conn: C,
  schema: SchemaArg<S>,
  managed: boolean,
  options: BetterSchemicOptions,
): Client<S, C> {
  return new ClientRuntime(
    conn,
    buildSchemaIndex(schema),
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
