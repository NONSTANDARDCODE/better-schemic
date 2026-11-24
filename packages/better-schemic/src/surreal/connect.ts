// SurrealDB connection runtime — the DRIVER's `connect` implementation (connect + authenticate +
// best-effort DEFINE/select NS/DB), shared by the engine (`driver/surreal.ts`) and the app-facing
// `/orm` client (`orm/client.ts`). free of CLI/engine imports so `/orm` stays lean.

import { escapeIdent, Surreal } from "surrealdb"

import type { ConnectionOverrides, ResolvedConfig } from "../core"

import type { AuthLevel, SurrealParams } from "./config"

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Strip credentials from a URL before it reaches a message/log (`wss://user:pass@host`). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = u.username ? "***" : ""
      u.password = u.password ? "***" : ""
    }
    return u.toString()
  } catch {
    return url.replace(/\/\/[^/@]*@/u, "//***@")
  }
}

const envMs = (name: string, fallback: number): number => {
  // Legacy `SCHEMIC_*` spellings still work; the `BETTER_SCHEMIC_*` spelling wins when both sets them.
  const raw = process.env[name] ?? process.env[name.replace("BETTER_SCHEMIC_", "SCHEMIC_")]
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// eslint-disable-next-line write-good-comments/write-good-comments -- termo do domínio da API
/**
 * Ceiling on the SDK's websocket connect. Generous ON PURPOSE: a busy machine can take
 * seconds to complete the handshake against a healthy server, and a tight ceiling turns
 * that into a spurious "is the server running?" — under a loaded parallel test gate `sc migrate`
 * aborted at the old 5s while the server was up and answering.
 *
 * A DOWN server is not what this bounds; {@link assertReachable} catches that in ~a second. (The
 * SDK does not reject quickly on a refused port even with `reconnect: false` — measured: a closed
 * port burned the whole ceiling — so this alone cannot distinguish "down" from "slow".)
 */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
const CONNECT_TIMEOUT_MS = envMs("BETTER_SCHEMIC_CONNECT_TIMEOUT_MS", 30_000)

/** How long the pre-flight TCP probe waits before declaring the host unreachable. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
const PROBE_TIMEOUT_MS = envMs("BETTER_SCHEMIC_PROBE_TIMEOUT_MS", 2000)

/**
 * Pre-flight: can we even open a TCP socket to the endpoint? This is what makes a DOWN server fail
 * fast (~instantly on a refused port) while leaving the slow-but-alive case a generous
 * {@link CONNECT_TIMEOUT_MS} to finish its handshake. Non-TCP endpoints (`mem://`, `indxdb://`, a
 * URL we can't parse) are not probed — they skip to the SDK connect.
 */
async function assertReachable(url: string): Promise<void> {
  let host: string
  let port: number
  try {
    const u = new URL(url)
    if (!/^(wss?|https?):$/u.test(u.protocol)) return
    // not a TCP endpoint — nothing to probe
    host = u.hostname
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
    port = Number(u.port) || (/^(wss|https):$/u.test(u.protocol) ? 443 : 80)
  } catch {
    return // unparseable — let the SDK produce the error
  }
  const { Socket } = await import("node:net")
  await new Promise<void>((resolve, reject) => {
    const sock = new Socket()
    const done = (err?: Error) => {
      sock.destroy()
      err ? reject(err) : resolve()
    }
    sock.setTimeout(PROBE_TIMEOUT_MS, () => {
      done(new Error(`no response from ${host}:${port} within ${PROBE_TIMEOUT_MS}ms`))
    })
    sock.once("error", (e) => {
      done(e)
    })
    sock.connect(port, host, () => {
      done()
    })
  })
}

/** Reject if `promise` doesn't settle within `ms` — guards against a hung connect. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
    void (async () => {
      try {
        const value = await promise
        clearTimeout(timer)
        resolve(value)
      } catch (error: unknown) {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

/** Connect + authenticate + select the namespace/database. Caller closes the handle. */
export async function connect(
  config: ResolvedConfig,
  over: ConnectionOverrides = {},
): Promise<Surreal> {
  const params = config.params as unknown as SurrealParams
  const url = over.url ?? params.url
  const namespace = over.namespace ?? params.namespace
  const database = over.database ?? params.database
  const username = over.username ?? params.username
  const password = over.password ?? params.password
  const level: AuthLevel = (over.authLevel ?? params.authLevel ?? "root") as AuthLevel

  const db = new Surreal()
  // On ANY failure, close the handle before throwing — otherwise the SDK's reconnect timer
  // keeps the event loop alive and the command hangs instead of exiting.
  try {
    try {
      // A DOWN host fails here, fast — the SDK's connect does NOT reject on a refused
      // port (even with `reconnect: false`), so without this probe "server is down" and "server is
      // slow" are indistinguishable and both cost the full ceiling.
      await assertReachable(url)
      // `reconnect: false` so a failed connect doesn't enter a retry loop; `withTimeout` bounds a
      // host that accepts the socket but never finishes the handshake.
      await withTimeout(
        db.connect(url, { reconnect: false }),
        CONNECT_TIMEOUT_MS,
        `connection timed out after ${CONNECT_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      throw new Error(
        `Can't reach SurrealDB at ${redactUrl(url)} — is the server running? (${errMsg(error)})`,
        { cause: error },
      )
    }
    if (username && password) {
      // Scope the signin to the requested level (mirrors `surreal sql --auth-level`).
      const auth =
        level === "root"
          ? { password, username }
          : // eslint-disable-next-line unicorn/no-nested-ternary -- Prettier remove os parênteses exigidos pela regra; a expressão encadeada é mais legível que if/else aqui
            level === "namespace"
            ? { namespace, password, username }
            : { database, namespace, password, username }
      try {
        await db.signin(auth)
      } catch (error) {
        throw new Error(
          `Authentication failed (auth level "${level}") — check SURREAL_USER / SURREAL_PASS. (${errMsg(error)})`,
          { cause: error },
        )
      }
    }
    // Best-effort: create the namespace/database when we have the rights. A `database`
    // user can't define either; a `namespace` user can define databases; `root` can do both.
    try {
      if (level === "root")
        await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${escapeIdent(namespace)};`)

      if (level !== "database") {
        await db.use({ namespace })
        await db.query(`DEFINE DATABASE IF NOT EXISTS ${escapeIdent(database)};`)
      }
    } catch {
      // insufficient privileges — assume the namespace/database already exist
    }
    try {
      await db.use({ database, namespace })
    } catch (error) {
      throw new Error(
        `Couldn't select ${namespace}/${database} — does it exist and do you have access? (${errMsg(error)})`,
        { cause: error },
      )
    }
    return db
  } catch (error) {
    // Fire-and-forget: closing a half-open socket can be slow; don't block the error path.
    void db.close().catch(() => {
      /* ignore close errors */
    })
    throw error
  }
}
