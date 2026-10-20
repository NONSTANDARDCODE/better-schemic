/**
 * Admin / introspection — `client.info(level, table?)`, `version`, `ping`, `export`, `import`.
 *
 * `info` is a SurrealQL `INFO FOR …` statement, so it is context-aware; `version`/`ping` are
 * connection-level. `export` uses the SDK's dump endpoint (session-bound), while `import` replays
 * the dump through `query()` — the SDK's `import()` is broken over WebSocket (live-probed on SDK
 * 2.0.3: `JSON Parse error: Unexpected identifier "undefined"`), and the query form is
 * context-aware besides.
 */
import type { SqlExportOptions } from "surrealdb";

/** `INFO FOR ROOT`. */
export interface RootInfo {
  accesses?: Record<string, string>;
  config?: Record<string, string>;
  defaults?: { namespace?: string; database?: string };
  namespaces?: Record<string, string>;
  nodes?: Record<string, string>;
  system?: Record<string, unknown>;
  users?: Record<string, string>;
  [key: string]: unknown;
}

/** `INFO FOR NS`. */
export interface NsInfo {
  accesses?: Record<string, string>;
  databases?: Record<string, string>;
  users?: Record<string, string>;
  [key: string]: unknown;
}

/** `INFO FOR DB`. */
export interface DbInfo {
  accesses?: Record<string, string>;
  analyzers?: Record<string, string>;
  apis?: Record<string, string>;
  buckets?: Record<string, string>;
  configs?: Record<string, string>;
  functions?: Record<string, string>;
  models?: Record<string, string>;
  modules?: Record<string, string>;
  params?: Record<string, string>;
  sequences?: Record<string, string>;
  tables?: Record<string, string>;
  users?: Record<string, string>;
  [key: string]: unknown;
}

/** `INFO FOR TABLE <table>`. */
export interface TableInfo {
  events?: Record<string, string>;
  fields?: Record<string, string>;
  indexes?: Record<string, string>;
  lives?: Record<string, string>;
  tables?: Record<string, string>;
  [key: string]: unknown;
}

/** `client.version()` — the SDK's `VersionInfo`. */
export interface ServerVersion {
  version: string;
}

/** The dump options the SDK accepts (`tables`, `records`, `versions`, …). */
export type ExportOptions = Partial<SqlExportOptions>;

/** The `info` levels, with `table` required only for the table level. */
export interface AdminOperations {
  info(level: "root"): Promise<RootInfo>;
  info(level: "ns"): Promise<NsInfo>;
  info(level: "db"): Promise<DbInfo>;
  info(level: "table", table: string): Promise<TableInfo>;
  /** The server version string (`surrealdb-3.2.0`). */
  version(): Promise<ServerVersion>;
  /** Round-trip liveness check (`true`; throws when the connection is dead). */
  ping(): Promise<boolean>;
  /** Dump the current database as SurrealQL (session-bound). */
  export(options?: ExportOptions): Promise<string>;
  /** Replay a dump (context-aware, transaction-aware). */
  import(dump: string): Promise<void>;
}
