/**
 * The raw escape hatches — `$raw` (one statement), `$query` () and `$unsafe` (unparameterized
 * string). Everything here parameterizs it BY DEFAULT: a `${…}` in the tagged template (or a value
 * in a `BoundQuery`) becomes a `$p<n>` bind, never inlined text.
 */
import type { BoundQuery } from "surrealdb"

import type { StatementResult } from "../results"

/** Audit metadata for a raw call (`requireComment` enforces `comment` on write scripts). */
export type RawMeta = {
  /** Hook/plugin metadata (consumed in M6). */
  [key: string]: unknown
  /** Human-readable reason for the raw statement (required by `raw.requireComment`). */
  comment?: string
  /** A label for logs/telemetry. */
  name?: string
}

/** Per-call raw options. */
export type RawOptions = {
  meta?: RawMeta
  /** Server-side `TIMEOUT` for a single capable statement (number = ms, string = duration). */
  timeout?: number | string
}

/** A raw query source: a plain string, or a `BoundQuery` (`surql`/SDK tag) carrying its binds. */
export type RawSource = BoundQuery | string

/** Client-level raw defaults (`orm(conn, { schema, raw: { … } })`). */
export type RawDefaults = {
  /** Require `meta.comment` on raw WRITE scripts (read-scripts are exempt). */
  requireComment?: boolean
  /** Default server-side `TIMEOUT` (ms) for a single statement whose verb accepts it. */
  timeoutMs?: number
  /** Allow `$unsafe` (default `false` — the parameterized hatches are always available). */
  unsafe?: boolean
}

/** The result of `$query` with `throwOnError: false` — one entry per user statement. */
export type RawStatements = readonly StatementResult[]
