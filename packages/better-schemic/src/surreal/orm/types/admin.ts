/**
 * Admin / introspection — `client.info(level, table?)`, `version`, `ping`, `export`, `import`.
 *
 * `info` is a SurrealQL `INFO FOR …` statement, so it's context-aware; `version`/`ping` are
 * connection-level. `export` uses the SDK's dump endpoint (session-bound), while `import` replays
 * the dump through `query()` — the SDK's `import()` broks it over WebSocket (live-probed on SDK
 * 2.0.3: `JSON Parse error: Unexpected identifier "undefined"`), and the query form is
 * context-aware besides.
 */
import type { SqlExportOptions } from "surrealdb"

/** `INFO FOR ROOT`. */
export type RootInfo = {
  [key: string]: unknown
  accesses?: Record<string, string>
  config?: Record<string, string>
  defaults?: { database?: string; namespace?: string }
  namespaces?: Record<string, string>
  nodes?: Record<string, string>
  system?: Record<string, unknown>
  users?: Record<string, string>
}

/** `INFO FOR NS`. */
export type NsInfo = {
  [key: string]: unknown
  accesses?: Record<string, string>
  databases?: Record<string, string>
  users?: Record<string, string>
}

/** `INFO FOR DB`. */
export type DbInfo = {
  [key: string]: unknown
  accesses?: Record<string, string>
  analyzers?: Record<string, string>
  apis?: Record<string, string>
  buckets?: Record<string, string>
  configs?: Record<string, string>
  functions?: Record<string, string>
  models?: Record<string, string>
  modules?: Record<string, string>
  params?: Record<string, string>
  sequences?: Record<string, string>
  tables?: Record<string, string>
  users?: Record<string, string>
}

/** `INFO FOR TABLE <table>`. */
export type TableInfo = {
  [key: string]: unknown
  events?: Record<string, string>
  fields?: Record<string, string>
  indexes?: Record<string, string>
  lives?: Record<string, string>
  tables?: Record<string, string>
}

/** `client.version()` — the SDK's `VersionInfo`. */
export type ServerVersion = {
  version: string
}

/** The dump options the SDK accepts (`tables`, `records`, `versions`, …). */
export type ExportOptions = Partial<SqlExportOptions>

/** The `info` levels, with `table` required for the table level. */
export type AdminOperations = {
  /** Dump the current database as SurrealQL (session-bound). */
  export(options?: ExportOptions): Promise<string>
  /** Replay a dump (context-aware, transaction-aware). */
  import(dump: string): Promise<void>
  info(level: "root"): Promise<RootInfo>
  info(level: "ns"): Promise<NsInfo>
  info(level: "db"): Promise<DbInfo>
  info(level: "table", table: string): Promise<TableInfo>
  /** Round-trip liveness check (`true`; throws when the connection is dead). */
  ping(): Promise<boolean>
  /** The server version string (`surrealdb-3.2.0`). */
  version(): Promise<ServerVersion>
}
