/**
 * The raw escape hatches — `$raw` (one statement), `$query` (many) and `$unsafe` (unparameterized
 * string). Everything here is PARAMETERIZED BY DEFAULT: a `${…}` in the tagged template (or a value
 * in a `BoundQuery`) becomes a `$p<n>` bind, never inlined text.
 */
import type { BoundQuery } from "surrealdb";
import type { StatementResult } from "../results";

/** Audit metadata for a raw call (`requireComment` enforces `comment` on write scripts). */
export interface RawMeta {
  /** Human-readable reason for the raw statement (required by `raw.requireComment`). */
  comment?: string;
  /** A label for logs/telemetry. */
  name?: string;
  /** Hook/plugin metadata (consumed in M6). */
  [key: string]: unknown;
}

/** Per-call raw options. */
export interface RawOptions {
  /** Server-side `TIMEOUT` for a single capable statement (number = ms, string = duration). */
  timeout?: number | string;
  meta?: RawMeta;
}

/** A raw query source: a plain string, or a `BoundQuery` (`surql`/SDK tag) carrying its binds. */
export type RawSource = string | BoundQuery;

/** Client-level raw defaults (`betterSchemic(conn, { schema, raw: { … } })`). */
export interface RawDefaults {
  /** Allow `$unsafe` (default `false` — the parameterized hatches are always available). */
  unsafe?: boolean;
  /** Require `meta.comment` on raw WRITE scripts (read-only scripts are exempt). */
  requireComment?: boolean;
  /** Default server-side `TIMEOUT` (ms) for a single statement whose verb accepts it. */
  timeoutMs?: number;
}

/** The result of `$query` with `throwOnError: false` — one entry per user statement. */
export type RawStatements = readonly StatementResult<unknown>[];
