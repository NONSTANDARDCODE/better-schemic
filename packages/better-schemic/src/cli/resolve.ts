// The multi-connection RESOLUTION ENGINE (design: docs/MULTI-CONNECTION.md). A project's
// Config maps names to CONNECTIONS; this layer turns a CLI invocation + addressing flags into the
// Concrete {@link ResolvedConfig}(s) the commands run against:
//   - `--connection <name>`        a single connection (or a whole collection, fanned out)
//   - `--connection <name>:<key>`  one element of a collection
//   - `--all`                      every connection (collections fanned out to all their elements)
//   - default                      `defaultConnection`, or the sole connection, else `"default"`
//   - `--arg k=v` (repeatable)     fed to resolvers via ResolveContext.args
// A resolver may reach SIBLING connections through `ctx.connections.<name>.query(...)`; that proxy
// Connects the sibling on demand (the dependency graph falls out of access; cycles error) and we close
// Anything it opened once resolution settles. The returned configs are connected FRESH by each command.

import {
  driverNames,
  getDriver,
  isConnectionEntry,
  loadProject,
  resolveConnectionConfig,
} from "../core"

import type {
  AnyConnectionEntry,
  ConnectionOverrides,
  Driver,
  ResolveContext,
  ResolvedConfig,
  ResolvedConnectionHandle,
} from "../core"

/**
 * The driver this build ships. Better-schemic is SurrealDB-only: the driver is BUILT IN, so there is
 * no package to install, nothing to resolve at runtime, and no dynamic `import()` by name. The
 * registry stays as the lookup the commands use (`getDriver(name)`), and the SurrealDB driver
 * registers itself on import of `better-schemic/driver` (the CLI entry imports it once).
 *
 * A name that is not registered is a CONFIG error (a hand-written `driver:` in a connection entry),
 * not a missing install — so the message says exactly that.
 */
export function assertDriverAvailable(name: string): void {
  if (driverNames().includes(name)) return
  throw new Error(
    `unknown database driver "${name}". This build of Better-schemic ships SurrealDB only — ` +
      `use the \`surrealConnection\` factory from "better-schemic/connection" in your config.`,
  )
}

/** Addressing + connection overrides every command accepts. */
export interface ResolveOpts extends ConnectionOverrides {
  config?: string
  /** Address a single connection: `<name>` (whole connection/collection) or `<name>:<key>` (one element). */
  connection?: string
  /** Resolve EVERY connection, fanning collections out to all their keyed elements. */
  all?: boolean
  /** `--arg k=v` (repeatable) sugar — merged into the resolver args. */
  arg?: string[]
  /** `--args <json>` — the resolver's typed args as one JSON object (k=v sugar merges over it). */
  args?: string
}

/** A commander `collect` reducer for repeatable `--arg` flags. */
export function collectArg(value: string, prev: string[]): string[] {
  return [...prev, value]
}

/** `--args`/`--arg` keys that must never be written onto the resolver-args object. */
const UNSAFE_ARG_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Parse `["k=v", ...]` into `{ k: v }`; rejects an entry without `=` and reserved keys. */
export function parseArgs(arg: string[] | undefined, argsJson?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (argsJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(argsJson)
    } catch {
      throw new Error(`--args must be a JSON object (got "${argsJson}").`)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(`--args must be a JSON object (got "${argsJson}").`)

    for (const [key, value] of Object.entries(parsed)) {
      if (UNSAFE_ARG_KEYS.has(key)) throw new Error(`--args key "${key}" is reserved.`)

      out[key] = value
    }
  }
  for (const a of arg ?? []) {
    const i = a.indexOf("=")
    if (i === -1) throw new Error(`--arg must be key=value (got "${a}").`)
    const key = a.slice(0, i)
    if (UNSAFE_ARG_KEYS.has(key)) throw new Error(`--arg key "${key}" is reserved.`)

    out[key] = a.slice(i + 1)
  }
  return out
}

/** Split a `<name>` / `<name>:<key>` address on the FIRST colon. */
function splitAddress(address: string): [name: string, key: string | undefined] {
  const i = address.indexOf(":")
  return i === -1 ? [address, undefined] : [address.slice(0, i), address.slice(i + 1)]
}

/**
 * Resolve the addressed connection(s) to {@link ResolvedConfig}s. Builds the lazy cross-connection
 * proxy (a resolver touching `ctx.connections.<other>` connects `<other>` on demand; cycles error),
 * resolves the target entry/entries (one, a fanned-out collection, or all), then closes any sibling the
 * proxy opened during resolution. Each returned connection's driver package is loaded/registered.
 */
export async function resolveTargets(opts: ResolveOpts): Promise<ResolvedConfig[]> {
  const { config, root } = await loadProject({ config: opts.config }),
    args = parseArgs(opts.arg, opts.args),
    names = Object.keys(config.connections),
    // Siblings the lazy proxy connected during resolution — closed before we return.
    opened = new Map<string, { driver: Driver; conn: unknown; driverName: string }>(),
    resolving = new Set<string>(),
    entryOf = (name: string): AnyConnectionEntry => {
      const entry = Object.hasOwn(config.connections, name) ? config.connections[name] : undefined
      if (!isConnectionEntry(entry))
        throw new Error(`No connection named "${name}". Known: ${names.join(", ") || "(none)"}.`)

      return entry
    },
    // Resolve ONE connection to a single config. A bare collection is ambiguous → require a `:key`.
    resolveOneConfig = async (name: string, key?: string): Promise<ResolvedConfig> => {
      const entry = entryOf(name),
        list = await entry.resolve(ctx, args),
        picked =
          key === undefined
            ? list.length === 1
              ? list[0]
              : undefined
            : list.find((c) => c.key === key)
      if (!picked) {
        if (key !== undefined)
          throw new Error(`Connection "${name}" has no element with key "${key}".`)

        throw new Error(
          `Connection "${name}" resolved to ${list.length} connections (a collection); address one with --connection ${name}:<key> or use --all.`,
        )
      }
      return resolveConnectionConfig(config, name, picked, entry.driver, root)
    },
    // Connect a sibling on demand for a resolver's `ctx.connections.<name>.query(...)`. Cached; cyclic
    // Access (A resolves via B resolves via A) throws instead of looping.
    openConnection = async (name: string) => {
      const cached = opened.get(name)
      if (cached) return cached

      if (resolving.has(name))
        throw new Error(`Connection cycle detected while resolving "${name}".`)

      resolving.add(name)
      try {
        const resolved = await resolveOneConfig(name)
        assertDriverAvailable(resolved.driver)
        const driver = getDriver(resolved.driver),
          conn = await driver.connect(resolved, opts),
          handle = { driver, conn, driverName: resolved.driver }
        opened.set(name, handle)
        return handle
      } finally {
        resolving.delete(name)
      }
    },
    connections = new Proxy(
      {},
      {
        get(_t, prop): ResolvedConnectionHandle | undefined {
          if (typeof prop !== "string") return undefined

          return {
            async query(sql, vars) {
              const { driver, conn, driverName } = await openConnection(prop)
              if (!driver.query) {
                throw new Error(
                  `the "${driverName}" driver has no \`query\` capability (needed by a connection resolver).`,
                )
              }
              return driver.query(conn, sql, vars)
            },
          }
        },
      },
    ),
    ctx: ResolveContext = { connections, env: process.env },
    // Fan a whole connection (single or collection) out to its config(s).
    fanOut = async (name: string): Promise<ResolvedConfig[]> => {
      const entry = entryOf(name),
        list = await entry.resolve(ctx, args)
      return list.map((conn) => resolveConnectionConfig(config, name, conn, entry.driver, root))
    }

  try {
    let targets: ResolvedConfig[]
    if (opts.all) {
      targets = []
      for (const name of names) targets.push(...(await fanOut(name)))
    } else if (opts.connection) {
      const [name, key] = splitAddress(opts.connection)
      targets = key === undefined ? await fanOut(name) : [await resolveOneConfig(name, key)]
    } else {
      const name = config.defaultConnection ?? (names.length === 1 ? names[0] : "default")
      if (!config.connections[name]) {
        throw new Error(
          `No default connection. Set "defaultConnection" or pass --connection. Known: ${names.join(", ") || "(none)"}.`,
        )
      }
      targets = [await resolveOneConfig(name)]
    }
    if (targets.length === 0) throw new Error("No connections matched — nothing to do.")

    for (const driver of new Set(targets.map((t) => t.driver))) assertDriverAvailable(driver)

    return targets
  } finally {
    for (const { driver, conn } of opened.values()) {
      try {
        await driver.close(conn)
      } catch {
        // Best-effort: a sibling opened only to compute the connection list
      }
    }
  }
}

/**
 * Resolve to EXACTLY ONE connection — for commands that operate on a single connection (`diff`,
 * `gen`, `check`, `new`, `snapshot`, `doctor`). `--connection <name>` picks it; `--all` and a bare
 * collection are rejected with the command-appropriate guidance.
 */
export async function resolveOne(opts: ResolveOpts): Promise<ResolvedConfig> {
  if (opts.all) {
    throw new Error(
      "--all is not supported here — this command operates on a single connection. Use --connection <name>.",
    )
  }
  const targets = await resolveTargets(opts)
  if (targets.length !== 1) {
    throw new Error(
      `--connection addressed ${targets.length} connections (a collection) — pin one with --connection <name>:<key>.`,
    )
  }
  return targets[0]
}
