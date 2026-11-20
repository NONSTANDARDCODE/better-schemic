// SurrealDB-specific config types — relocated out of better-schemic/config, which is now connections-
// and dialect-free. A `surrealConnection({ … })` carries these; the resolution engine strips the neutral
// base (schema/key/migrations) and the rest lands in `ResolvedConfig.params` (read it as {@link SurrealParams}).

/** Which level to authenticate at — mirrors `surreal sql --auth-level`. */
export type AuthLevel = "database" | "namespace" | "root"

/** A SurrealDB connection's params (the surreal-specific half of a `surrealConnection` config). */
export interface SurrealZodConnection {
  /**
   * Level to sign in at: `root` (default), `namespace`, or `database`. Determines the
   * signin payload — `namespace`/`database` scope the credentials to that ns/db.
   */
  authLevel?: AuthLevel
  /** Target database. */
  database: string
  /** Target namespace. */
  namespace: string
  /** Auth password. */
  password?: string
  /** Endpoint, e.g. `ws://localhost:8000` or `http://localhost:8000`. */
  url: string
  /** Auth username. */
  username?: string
}

/** An allow/deny list for a single capability — mirrors `@surrealdb/node`. */
export interface CapabilityList {
  allow?: boolean | string[]
  deny?: boolean | string[]
}

/** Capabilities for the embedded check engine — mirrors `@surrealdb/node`'s `capabilities` option. */
export interface EmbeddedCapabilities {
  experimental?: boolean | CapabilityList | string[]
  functions?: boolean | CapabilityList | string[]
  guest_access?: boolean
  live_query_notifications?: boolean
  network_targets?: boolean | CapabilityList | string[]
  scripting?: boolean
}

/**
 * Run `better-schemic check`'s replay on an EMBEDDED in-process SurrealDB via the optional `@surrealdb/node`
 * package (install it yourself — `npm i -D @surrealdb/node`). Options pass through to
 * `createNodeEngines`; `backend`/`path` choose the storage. No external server, your data untouched.
 */
export interface SurrealZodCheckEmbedded {
  /** Storage backend. `memory` (default) is throwaway in-RAM; the others persist to `path`. */
  backend?: "memory" | "rocksdb" | "surrealkv" | "surrealkv+versioned"
  /** Capabilities for the instance. Default: all allowed, so asserts/defaults/functions work. */
  capabilities?: boolean | EmbeddedCapabilities
  /** Filesystem path for the persistent backends (ignored for `memory`). */
  path?: string
  /** Query timeout. */
  query_timeout?: number
  /** SurrealDB strict mode. */
  strict?: boolean
  /** Transaction timeout. */
  transaction_timeout?: number
}

/** `better-schemic check` options (lives on a SurrealDB connection's config; rides into `params.check`). */
export interface SurrealZodCheck {
  /** Path to the `surreal` CLI for the `auto`/`binary` engines. Default: `surreal` on PATH. */
  binary?: string
  /**
   * Connection used for the `remote` engine, merged field-by-field over the connection's own params.
   * The replay spins up throwaway scratch databases and drops them — it NEVER reads or writes your real
   * database — but it DOES reach the server. Point this at a local/scratch SurrealDB so `better-schemic check`
   * never touches production. Falls back to the connection params for any field you omit.
   */
  db?: Partial<SurrealZodConnection>
  /**
   * Engine for the migration replay:
   *  - `"auto"` (default) — if the `surreal` CLI is on PATH, spin up an ephemeral in-memory instance
   *    (your EXACT SurrealDB version, no external server, your data untouched); otherwise fall back to
   *    the `check.db` server.
   *  - `"binary"` — require the local `surreal` CLI (error if it's missing).
   *  - `"remote"` — always use the `check.db` server (throwaway scratch databases on it).
   *  - an embedded object (`{ backend, capabilities, … }`) — run in-process via the optional
   *    `@surrealdb/node` package. See {@link SurrealZodCheckEmbedded}.
   */
  engine?: "auto" | "binary" | "remote" | SurrealZodCheckEmbedded
}

/**
 * The SurrealDB-specific bag carried in `ResolvedConfig.params`: the connection params plus the optional
 * `check` replay config. `connect`/`introspect`/`checkReplay` read `config.params as SurrealParams`.
 */
export interface SurrealParams extends SurrealZodConnection {
  /** `better-schemic check` overrides — e.g. a dedicated connection for its migration replay. */
  check?: SurrealZodCheck
}
