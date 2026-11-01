/**
 * The MANAGED half of the ORM bootstrap: open (and own) the SurrealDB connection, authenticate,
 * select the namespace/database and return a bound client whose `close()` tears the connection down.
 * `clientFromConfig` is the opener the `surrealConnection` factory embeds (lazy-imported, so
 * authoring a config never pulls the ORM).
 *
 * Kept separate from `./client` (the runtime + BYO factory) so the lifecycle code and the
 * connection-boot policies live in one place.
 */

import { Surreal } from "surrealdb";
import type { ResolvedConfig } from "../../core";
import { redactUrl, connect as surrealConnect } from "../connect";
import { escapeIdentSafe as escapeIdent } from "../ident";
import {
  buildClient,
  type Client,
  type OrmOptions,
  type SchemaArg,
} from "./client";
import { normalizeError } from "./errors";
import type { Plugin } from "./types/plugins";
import type { SchemaInput } from "./types/schema";

/** Authentication for {@link createOrm}: a system user, or a record-access signin. */
export type OrmAuth =
  | { readonly username: string; readonly password: string }
  | { readonly access: string; readonly variables: Record<string, unknown> };

/** Options for {@link createOrm} — the managed (connect + authenticate + use) sugar. */
export interface CreateOrmOptions<S extends SchemaInput> extends OrmOptions {
  /** The WebSocket/HTTP endpoint, e.g. `wss://localhost:8000/rpc`. */
  readonly url: string;
  readonly namespace?: string;
  readonly database?: string;
  readonly auth?: OrmAuth;
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
 * const client = await createOrm({
 *   url: "wss://localhost:8000/rpc", namespace: "app", database: "main",
 *   auth: { username: "root", password: "root" },
 *   schema,
 * });
 * ```
 */
export async function createOrm<
  S extends SchemaInput,
  const P extends readonly Plugin[] = readonly [],
>(
  options: CreateOrmOptions<S> & { readonly plugins?: P },
): Promise<Client<S, Surreal, P>> {
  const conn = new Surreal();
  try {
    const connecting = conn.connect(options.url, { reconnect: false });
    await (options.connectTimeoutMs === undefined
      ? connecting
      : withTimeout(
          connecting,
          options.connectTimeoutMs,
          `createOrm: connect to ${redactUrl(options.url)} timed out after ${options.connectTimeoutMs}ms.`,
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
    return buildClient(
      conn,
      options.schema,
      true,
      options,
    ) as unknown as Client<S, Surreal, P>;
  } catch (e) {
    await conn.close().catch(() => {});
    throw normalizeError(e, { operation: "connect" });
  }
}

/**
 * Open a MANAGED client from an already-resolved project config — the opener the
 * `surrealConnection` factory embeds so `defineConfig(...).connect(name)` hands back an owned
 * client. Lazy-imported by the connection factory so authoring a config never pulls the engine.
 *
 * The config carries no schema (the schema modules live with the app), so this client exposes the
 * lifecycle + `repository()` over an EMPTY index; use `orm(conn, { schema })` for the
 * typed delegates.
 */
export async function clientFromConfig(
  config: ResolvedConfig,
): Promise<Client<SchemaInput, Surreal>> {
  const conn = await surrealConnect(config);
  return buildClient(conn, {} as SchemaInput, true, {});
}
