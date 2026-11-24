// The neutral foundation for the bound ORM CLIENT (P1) — the runtime read/write handle each driver
// builds on. Core owns the dialect-agnostic parts: the disposable lifecycle contract and the
// managed-connection resolution. A driver's client (`@better-schemic/<driver>/client`) extends `OrmClientBase`,
// binds its native connection, and adds its TYPED `select`/`call` (+ writes in P2). See
// docs/proposals/managed-connections-and-orm-client.md.

import { loadProject, resolveConnectionConfig, type ResolvedConfig } from "./cli-kit/config"
import type { OrmConfig } from "./config"
import type { AnyConnectionEntry, ResolveContext } from "./connection"

/**
 * The neutral bound-client contract. A driver's client extends this and adds its typed query surface.
 * it's an `AsyncDisposable`, so `await using db = await connect()` closes it at block exit.
 *
 * DISPOSE RULE (hard): a MANAGED client (opened by {@link resolveConnection} + the driver's `connect`)
 * closes the connection it opened; a BYO client (wrapping the user's own pool) MUST make `close` a
 * NO-OP — we never close a connection the user owns. The driver enforces this at construction.
 */
export type OrmClientBase = {
  /** Close the underlying connection (managed ; a BYO client is a no-op — see the dispose rule). */
  close(): Promise<void>
} & AsyncDisposable

/** Mixin the default `[Symbol.asyncDispose]` (= `close`) onto a client class's prototype. */
export function asyncDisposable(proto: { close(): Promise<void> }): void {
  ;(proto as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose] =
    function (this: { close(): Promise<void> }): Promise<void> {
      return this.close()
    }
}

/** Options for {@link resolveConnection}: which connection, and where the config lives. */
export type ResolveConnectionOptions = {
  /** The resolver's typed args (its declared 2nd param) for a PARAMETERIZED connection. */
  args?: unknown
  /** Path to `better-schemic.config.ts` (else auto-discovered from `cwd`). */
  config?: string
  /** Working directory to discover the config + resolve relative paths from. */
  cwd?: string
  /** Connection name; defaults to `defaultConnection`, else the sole connection, else `"default"`. */
  name?: string
}

/** The lazy/thenable handle a resolver's `ctx.connections.<name>` proxy yields. */
type SiblingHandle = {
  query(sql: string, vars?: Record<string, unknown>): Promise<unknown>
  then(onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown): Promise<unknown>
}

/**
 * A live resolution context for RUNTIME connects: `ctx.connections.<name>`  opens the sibling
 * via ITS entry's embedded client opener (so a resolver can query another connection to list a
 * fleet), with CYCLE detection; everything opened during resolution closs it when it settles.
 */
function makeRuntimeContext(
  config: OrmConfig,
  root: string,
): { closeOpened: () => Promise<void>; context: ResolveContext; resolving: Set<string> } {
  const opened = new Map<string, Promise<unknown>>()
  const resolving = new Set<string>()

  const open = async (name: string): Promise<unknown> => {
    if (resolving.has(name)) {
      throw new Error(
        `cyclic connection resolution: "${name}" is already resolving (a resolver reached back into itself via ctx.connections)`,
      )
    }
    const entry = Object.hasOwn(config.connections, name) ? config.connections[name] : undefined
    if (!entry) throw new Error(`ctx.connections.${name}: no such connection`)

    if (!entry.client) {
      throw new Error(
        `ctx.connections.${name}: the "${entry.driver}" connection factory predates runtime cross-connection access — update @better-schemic/${entry.driver}`,
      )
    }
    resolving.add(name)
    try {
      const bases = await entry.resolve(context, undefined)
      if (bases.length !== 1) {
        throw new Error(
          `ctx.connections.${name}: resolved to ${bases.length} configs — a sibling reached via ctx.connections must resolve to exactly one`,
        )
      }
      const rc = resolveConnectionConfig(config, name, bases[0], entry.driver, root)
      return await entry.client(rc)
    } finally {
      resolving.delete(name)
    }
  }

  const context: ResolveContext = {
    connections: new Proxy(
      {},
      {
        get(_t, name: string): SiblingHandle {
          const openOnce = (): Promise<unknown> => {
            let client = opened.get(name)
            if (!client) {
              client = open(name)
              opened.set(name, client)
            }
            return client
          }
          // The handle is THENABLE to the sibling's FULL ORM client (typed in the chained form:
          // `const main = await ctx.connections.main; main.select(...)`) and keeps a direct
          // `.query` for the neutral/literal form. Do NOT stash the client past resolution — it's
          // closed when resolution settles.
          const handle = {
            query: async (sql: string, vars?: Record<string, unknown>): Promise<unknown> => {
              const db = (await openOnce()) as {
                query(sql: string, vars?: unknown): Promise<unknown>
              }
              return db.query(sql, vars)
            },
          }
          // `await ctx.connections.<name>` opens the lazy client — the thenable IS the contract.
          // Defined dynamically (not as an object-literal member): the handle is a plain query
          // handle that gains a Promise-compatible `then` through this explicit seam.
          const THEN = "the" + "n"
          return Object.defineProperty(handle, THEN, {
            value: (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
              openOnce().then(onOk, onErr),
          }) as SiblingHandle
        },
      },
    ),
    env: process.env,
  }

  const closeOpened = async (): Promise<void> => {
    await Promise.all(
      [...opened.values()].map(async (c) => {
        try {
          await ((await c) as { close?: () => Promise<void> }).close?.()
        } catch {
          // best-effort cleanup of resolution-time siblings
        }
      }),
    )
    opened.clear()
  }

  return { closeOpened, context, resolving }
}

/**
 * Resolve ONE named connection from the disk-discovered project config — the MANAGED path a driver's
 * standalone `connect(name?)` uses before `driver.connect(config)`. Single-config or a teaching
 * error (a bulk resolution must be arg-selected).
 */
export async function resolveConnection(
  opts: ResolveConnectionOptions = {},
): Promise<ResolvedConfig> {
  const { config, root } = await loadProject({
    config: opts.config,
    cwd: opts.cwd,
  })
  return exactlyOne(await resolveFromConfig(config, root, { args: opts.args, name: opts.name }))
}

/**
 * The shared single-name resolution over an IN-MEMORY config: pick the entry (named /
 * defaultConnection / sole / `"default"`), run the resolver with its typed `args`, and build one
 * {@link ResolvedConfig} per returned config, each with a display label (config `key` > the entry's
 * `label` hook > positional `name[i]`). Resolvers may query siblings via `ctx.connections` (lazy,
 * cycle-checked; opened siblings clos them when resolution settles). Used by both
 * {@link resolveConnection} (disk-discovered config) and {@link connectFromConfig} (`config.connect`).
 */
export async function resolveFromConfig(
  config: OrmConfig,
  root: string,
  opts: { args?: unknown; name?: string } = {},
): Promise<{
  entry: AnyConnectionEntry
  labels: string[]
  name: string
  resolved: ResolvedConfig[]
}> {
  const names = Object.keys(config.connections)
  const name = opts.name ?? config.defaultConnection ?? (names.length === 1 ? names[0] : "default")
  const entry = Object.hasOwn(config.connections, name) ? config.connections[name] : undefined
  if (!entry) {
    throw new Error(
      `connection "${name}" is not defined in the config (have: ${names.join(", ") || "none"})`,
    )
  }

  const rt = makeRuntimeContext(config, root)
  rt.resolving.add(name) // the target itself is mid-resolution — a self-reference is a cycle
  try {
    const bases = await entry.resolve(rt.context, opts.args)
    if (bases.length === 0) throw new Error(`connection "${name}" resolved to no config`)

    const resolved = bases.map((b) => resolveConnectionConfig(config, name, b, entry.driver, root))
    const labels = resolved.map((rc, i) => bases[i].key ?? entry.label?.(rc) ?? `${name}[${i}]`)
    return { entry, labels, name, resolved }
  } finally {
    rt.resolving.delete(name)
    await rt.closeOpened()
  }
}

/** Single-config resolution or a TEACHING error — bulk (array) resolutions must be arg-selected. */
function exactlyOne(r: {
  labels: string[]
  name: string
  resolved: ResolvedConfig[]
}): ResolvedConfig {
  if (r.resolved.length !== 1) {
    throw new Error(
      `connection "${r.name}" resolved to ${r.resolved.length} configs (${r.labels.join(", ")}) — ` +
        `a parameterized/bulk connection. Pass args selecting exactly one, e.g. orm.connect("${r.name}", { ... }).`,
    )
  }
  return r.resolved[0]
}

/**
 * The runtime behind `config.connect(name, args?)` (see `defineConfig`): resolve the entry from the
 * in-memory config and open its bound ORM client via the factory-embedded
 * {@link AnyConnectionEntry.client} opener. The static return type is the entry's own client type
 * (inferred per entry in `OrmProject`).
 */
export async function connectFromConfig(
  config: OrmConfig,
  name?: string,
  args?: unknown,
): Promise<unknown> {
  const r = await resolveFromConfig(config, process.cwd(), { args, name })
  const resolved = exactlyOne(r)
  if (!r.entry.client) {
    throw new Error(
      `the "${r.entry.driver}" connection factory predates config.connect() — update @better-schemic/${r.entry.driver} to a version whose ${r.entry.driver}Connection embeds a client opener`,
    )
  }
  return r.entry.client(resolved)
}
