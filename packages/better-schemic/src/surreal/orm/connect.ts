/**
 * The MANAGED half of the ORM bootstrap: open (and own) the SurrealDB connection, authenticate,
 * select the namespace/database and return a bound client whose `close()` tears the connection down.
 * `clientFromConfig` is the opener the `surrealConnection` factory embeds (lazy-imported, so
 * authoring a config never pulls the ORM).
 *
 * Kept separate from `./client` (the runtime + BYO factory) so the lifecycle code and the
 * connection-boot policies live in one place.
 */

import { Surreal } from "surrealdb"

import type { ResolvedConfig } from "../../core"
import { connect as surrealConnect, redactUrl } from "../connect"
import { escapeIdentSafe as escapeIdent } from "../ident"

import { buildClient, type Client, type OrmOptions, type SchemaArg } from "./client"
import { normalizeError } from "./errors"
import type { Plugin } from "./types/plugins"
import type { SchemaInput } from "./types/schema"

/** Authentication for {@link createOrm}: a system user, or a record-access signin. */
export type OrmAuth =
  | { readonly access: string; readonly variables: Record<string, unknown> }
  | { readonly password: string; readonly username: string }

/** Options for {@link createOrm} — the managed (connect + authenticate + use) sugar. */
export type CreateOrmOptions<S extends SchemaInput> = {
  readonly auth?: OrmAuth
  /** Give up (and close) if the connection handshake doesn't complete in time. */
  readonly connectTimeoutMs?: number
  readonly database?: string
  readonly namespace?: string
  readonly schema: SchemaArg<S>
  /** The WebSocket/HTTP endpoint, e.g. `wss://localhost:8000/rpc`. */
  readonly url: string
} & OrmOptions

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)

    ;(timer as { unref?: () => void }).unref?.()
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
        return value
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(normalizeError(error, { operation: "connect" }))
      },
    )
  })
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
>(options: CreateOrmOptions<S> & { readonly plugins?: P }): Promise<Client<S, Surreal, P>> {
  const conn = new Surreal()
  try {
    const connecting = conn.connect(options.url, { reconnect: false })
    await (options.connectTimeoutMs === undefined
      ? connecting
      : withTimeout(
          connecting,
          options.connectTimeoutMs,
          `createOrm: connect to ${redactUrl(options.url)} timed out after ${options.connectTimeoutMs}ms.`,
        ))
    if (options.auth) {
      await conn.signin(
        "access" in options.auth
          ? { access: options.auth.access, variables: options.auth.variables }
          : { password: options.auth.password, username: options.auth.username },
      )
    }
    // Best-effort: create the namespace/database when we have the rights, then select them.
    // (A database user can't define either; a namespace user can define databases; root can do both.)
    const { database, namespace } = options
    try {
      if (namespace) {
        await conn.query(`DEFINE NAMESPACE IF NOT EXISTS ${escapeIdent(namespace)};`)
        await conn.use({ namespace })
      }
      if (database) await conn.query(`DEFINE DATABASE IF NOT EXISTS ${escapeIdent(database)};`)
    } catch {
      // insufficient privileges — assume the namespace/database already exist
    }
    if (namespace || database) await conn.use({ database, namespace })

    return buildClient(conn, options.schema, true, options) as unknown as Client<S, Surreal, P>
  } catch (error) {
    await conn.close().catch(() => {
      /* close é best-effort */
    })
    throw normalizeError(error, { operation: "connect" })
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
  const conn = await surrealConnect(config)
  return buildClient(conn, {}, true, {})
}
