import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { connect as netConnect, createServer } from "node:net"

import { escapeIdent, Surreal } from "surrealdb"

import type { SurrealZodCheckEmbedded } from "../config"

/** Default ports for the URL schemes a Surreal endpoint can use. */
const HTTPS_PORT = 443
const HTTP_PORT = 80
/** Raw TCP probe timeout before retrying. */
const TCP_PROBE_TIMEOUT_MS = 250
/** Delay between port probes. */
const PORT_POLL_INTERVAL_MS = 10
/** Delay between connection attempts. */
const CONNECT_POLL_INTERVAL_MS = 100
/** Per-attempt connect timeout. */
const CONNECT_ATTEMPT_TIMEOUT_MS = 2000
/** Boot deadline. */
const READY_TIMEOUT_MS = 30_000
/** Lines of captured stderr shown on failure. */
const STDERR_TAIL_LINES = 3
/** Random password entropy (bytes). */
const PASSWORD_BYTES = 16
/** Grace period before SIGKILL after SIGTERM. */
const KILL_GRACE_MS = 2000

/** The last non-empty line of captured stderr. */
function lastStderrLine(text: string): string {
  return (
    text
      .split("\n")
      .reverse()
      .find((line) => line.length > 0) ?? "no output"
  )
}

/** Pick a free localhost TCP port by binding to :0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = addr && typeof addr === "object" ? addr.port : 0
      srv.close(() => {
        port ? resolve(port) : reject(new Error("no port"))
      })
    })
  })
}

/** Race a promise against a timeout (the loser abandons it — callers close/retry). */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(msg))
    }, ms)
    t.unref()
    void (async (): Promise<void> => {
      try {
        const value = await p
        clearTimeout(t)
        resolve(value)
      } catch (error: unknown) {
        clearTimeout(t)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

/** Whether the local `surreal` CLI is runnable (used to pick the `auto` check engine). */
export function surrealBinaryAvailable(bin = "surreal"): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export type EphemeralServer = {
  password: string
  /** Stop the spawned process (idempotent). */
  stop: () => Promise<void>
  url: string
  username: string
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    setTimeout(r, ms)
  })

/**
 * Poll a raw TCP port until it ACCEPTS. The SDK's WS `connect` to a closed port never settles (it's
 * raced against a timeout below), so connecting after the listener is up removes a full ~2s
 * timeout from every ephemeral boot — TCP accepts ~400ms after spawn, the WS handshake ~100ms more.
 */
async function waitForPort(
  url: string,
  child: ChildProcess,
  deadline: number,
  stderr: () => string,
): Promise<void> {
  const parsed = new URL(url)
  const host = parsed.hostname.replaceAll(/^\[|\]$/gu, "")
  const defaultPort =
    parsed.protocol === "wss:" || parsed.protocol === "https:" ? HTTPS_PORT : HTTP_PORT
  const port = Number(parsed.port || defaultPort)

  const probe = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      const tail = stderr().split("\n").filter(Boolean).slice(-STDERR_TAIL_LINES).join(" | ")
      throw new Error(
        `surreal did not open ${host}:${port} within 30s${tail ? ` — server stderr: ${tail}` : ""}`,
      )
    }
    if (child.exitCode !== null)
      throw new Error(`surreal exited (${child.exitCode}): ${lastStderrLine(stderr())}`)
    const accepted = await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host, port })
      const done = (v: boolean): void => {
        socket.destroy()
        resolve(v)
      }
      socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => {
        done(false)
      })
      socket.once("connect", () => {
        done(true)
      })
      socket.once("error", () => {
        done(false)
      })
    })
    if (accepted) return

    await sleep(PORT_POLL_INTERVAL_MS)
    return probe()
  }
  await probe()
}

/** Poll a Surreal connection until it succeeds, the process dies, or we time out. */
async function waitUntilReady(
  url: string,
  username: string,
  password: string,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  await waitForPort(url, child, deadline, stderr)
  const attempts: string[] = []

  const attempt = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      const tail = stderr().split("\n").filter(Boolean).slice(-STDERR_TAIL_LINES).join(" | ")
      throw new Error(
        `surreal did not become ready within 30s at ${url} — last attempts: ${attempts.slice(-STDERR_TAIL_LINES).join("; ")}${tail ? ` — server stderr: ${tail}` : ""}`,
      )
    }
    if (child.exitCode !== null)
      throw new Error(`surreal exited (${child.exitCode}): ${lastStderrLine(stderr())}`)
    const db = new Surreal()
    try {
      // RACE each attempt against a short timeout: a HANGING connect (seen under the land gate)
      // would otherwise never settle and blow past the deadline loop — the hook then eats
      // its full timeout with zero diagnostics. A timed-out attempt retries.
      await withTimeout(
        (async (): Promise<void> => {
          await db.connect(url, { reconnect: false })
          await db.signin({ password, username })
        })(),
        CONNECT_ATTEMPT_TIMEOUT_MS,
        "connect attempt timed out (2s)",
      )
      await db.close()
      return
    } catch (error) {
      attempts.push((error as Error).message)
      await db.close().catch(() => {
        /* ignore close errors */
      })
      await sleep(CONNECT_POLL_INTERVAL_MS)
      return attempt()
    }
  }
  await attempt()
}

/**
 * Spawn an ephemeral in-memory SurrealDB using the local `surreal` binary — for `better-schemic check`'s
 * migration replay. It runs on the user's EXACT SurrealDB version, needs no external server, and
 * never touches their data. Capabilities are fully allowed (`--allow-all`): it's a throwaway
 * instance running the user's own schema, so asserts/defaults/scripted functions all work. The
 * caller must `stop()` it (a `process.exit` hook is also registered as a backstop).
 */
export async function spawnEphemeralServer(bin = "surreal"): Promise<EphemeralServer> {
  const port = await freePort()
  const username = "root"
  // A RANDOM per-run password: the instance is loopback-bound, but a fixed root/root would let any
  // local process sign in (and `--allow-all` runs scripted functions) while a replay is in flight.
  const password = randomBytes(PASSWORD_BYTES).toString("hex")
  const child = spawn(
    bin,
    [
      "start",
      "--bind",
      `127.0.0.1:${port}`,
      "--username",
      username,
      "--password",
      password,
      "--allow-all",
      "memory",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  let stderr = ""
  child.stderr.on("data", (d) => {
    stderr += String(d)
  })

  let stopped = false
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (stopped || child.exitCode !== null) {
        stopped = true
        resolve()
        return
      }
      stopped = true
      child.once("exit", () => {
        resolve()
      })
      child.kill("SIGTERM")
      // Hard-kill if it doesn't exit .
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref()
    })
  // Backstop: don't leak the process if the CLI exits abnormally.
  const onExit = (): void => {
    if (!stopped) child.kill("SIGKILL")
  }
  process.once("exit", onExit)

  const url = `ws://127.0.0.1:${port}/rpc`
  try {
    await waitUntilReady(url, username, password, child, () => stderr)
  } catch (error) {
    await stop()
    throw error
  }
  return { password, stop, url, username }
}

export type EmbeddedConnection = {
  db: Surreal
  stop: () => Promise<void>
  /** A display label for the engine, e.g. `embedded memory`. */
  url: string
}

/**
 * Connect to an EMBEDDED in-process SurrealDB via the optional `@surrealdb/node` package, selecting
 * the `cfg.backend` storage and passing `cfg` (capabilities, timeouts, …) straight to
 * `createNodeEngines`. Creates/selects the given namespace/database so the replay can run. The
 * package imports it  (a non-literal specifier) so it's never required unless this engine is
 * used; a clear error tells the user to install it otherwise.
 */
export async function connectEmbedded(
  cfg: SurrealZodCheckEmbedded,
  namespace: string,
  database: string,
): Promise<EmbeddedConnection> {
  // Non-literal specifier so tsc/bundlers don't treat `@surrealdb/node` as a hard dependency.
  const pkg = "@surrealdb/node"
  let createNodeEngines: ((options?: unknown) => unknown) | undefined
  try {
    const mod = (await import(pkg)) as {
      createNodeEngines?: (options?: unknown) => unknown
    }
    createNodeEngines = mod.createNodeEngines
  } catch {
    createNodeEngines = undefined
  }
  if (!createNodeEngines) {
    throw new Error(
      'check.engine embedded mode needs `@surrealdb/node` — install it (e.g. `npm i -D @surrealdb/node`), or use a string engine ("auto" / "binary" / "remote").',
    )
  }

  const backend = cfg.backend ?? "memory"
  const scheme = backend === "memory" ? "mem" : backend
  const url = `${scheme}://${cfg.path ?? ""}`
  const engines = createNodeEngines({
    capabilities: cfg.capabilities ?? true,
    query_timeout: cfg.query_timeout,
    strict: cfg.strict,
    transaction_timeout: cfg.transaction_timeout,
  })
  const options = { engines } as ConstructorParameters<typeof Surreal>[0]
  const db = new Surreal(options)
  await db.connect(url)
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${escapeIdent(namespace)}`)
  await db.use({ namespace })
  await db.query(`DEFINE DATABASE IF NOT EXISTS ${escapeIdent(database)}`)
  await db.use({ database, namespace })
  return {
    db,
    stop: async (): Promise<void> => {
      await db.close().catch(() => {
        /* ignore close errors */
      })
    },
    url: `embedded ${backend}`,
  }
}
