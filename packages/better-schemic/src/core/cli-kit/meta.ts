import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { KindSnapshot } from "../kind"

/** On-disk snapshot format version. */
const SNAPSHOT_VERSION = 3
/** Pretty-print indent for the stored JSON. */
const JSON_INDENT = 2
/** Width of each numeric part of a migration timestamp prefix. */
const TIMESTAMP_PART_WIDTH = 2
/** Length of the checksum prefix embedded in a migration filename. */
const CHECKSUM_PREFIX_LENGTH = 16

// The legacy STATEMENT snapshot types (Snapshot/SnapshotStatement/EMPTY_SNAPSHOT) now live in
// cli/structure.ts (the SurrealDB module that produces them) — this file is the NEUTRAL stored-
// snapshot + migration-file engine.

/**
 * The STORED snapshot (`_snapshot.json`): the canonical schema is portable objects grouped by kind
 * (a {@link KindSnapshot}); DDL derivs it generically via the kind registry (`buildKindDiff`/
 * `emitKinds`). Diffed against the next `generate`. `files` maps each object's name to its
 * project-root-relative source file (display-; attached to diff items by the CLI). Pre-launch:
 * the format is free to change, so there is no on-disk version migration — an unrecognized snapshot
 * treats it as empty (regenerate via `better-schemic gen --baseline`).
 */
export type StoredSnapshot = {
  /** The driver that authored this snapshot ("surrealdb"). */
  driver: string
  files?: Record<string, string>
  /** Portable objects grouped by kind. */
  schema: KindSnapshot
  version: typeof SNAPSHOT_VERSION
}

/** A migration file on disk. The filename is the source of truth — there's no journal. */
export type Migration = {
  /** Filename, e.g. `20260607153045_add_users.surql`. */
  file: string
  /** Filename without the `.surql` extension, e.g. `20260607153045_add_users`. */
  tag: string
}

const SNAPSHOT_FILE = "_snapshot.json"
/** Fallback migration extension when a caller has no driver to hand (the driver provides the real one). */
const DEFAULT_MIGRATION_EXT = ".surql"

/** A fresh empty STORED snapshot. Fresh each call so callers can't alias shared empty state. */
function emptyStored(): StoredSnapshot {
  return {
    driver: "surrealdb",
    files: {},
    schema: { kinds: {} },
    version: 3,
  }
}

/** The empty STORED snapshot — used as `prev` for a `--baseline` generate (diff against nothing). */
export const EMPTY_STORED: StoredSnapshot = emptyStored()

/**
 * Read the stored snapshot. Pre-launch: any snapshot that isn't the current `version: 3` shape (a
 * pre-portable v1/v2, or absent) treats it as EMPTY — regenerate with `better-schemic gen --baseline`.
 */
export function readSnapshot(metaDir: string): StoredSnapshot {
  const path = join(metaDir, SNAPSHOT_FILE)
  if (!existsSync(path)) return emptyStored()

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(
      `better-schemic: ${SNAPSHOT_FILE} is not valid JSON (${(error as Error).message}). Restore it or regenerate with \`better-schemic gen --baseline\`.`,
      { cause: error },
    )
  }
  if (isValidStoredSnapshot(raw)) return { files: {}, ...raw }

  return emptyStored()
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** Runtime validation of a stored snapshot — a doctored file must not reach the diff/plan walkers. */
function isValidStoredSnapshot(v: unknown): v is StoredSnapshot {
  if (typeof v !== "object" || v === null) return false

  const snap = v as Partial<StoredSnapshot>
  if (snap.version !== SNAPSHOT_VERSION || typeof snap.driver !== "string") return false

  const schema = snap.schema as undefined | { kinds?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `null` passa como objeto: snapshot vem de disco e pode conter null.
  if (typeof schema !== "object" || schema === null) return false

  const kinds = schema.kinds
  if (typeof kinds !== "object" || kinds === null || Array.isArray(kinds)) return false

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [kind, items] of Object.entries(kinds)) {
    if (UNSAFE_KEYS.has(kind) || !Array.isArray(items)) return false

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const item of items) {
      if (typeof item !== "object" || item === null) return false

      const obj = item as { kind?: unknown; name?: unknown }
      if (typeof obj.kind !== "string" || typeof obj.name !== "string") return false
    }
  }
  if (snap.files !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `null` passa como objeto: snapshot vem de disco e pode conter null.
    if (typeof snap.files !== "object" || snap.files === null || Array.isArray(snap.files))
      return false

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const value of Object.values(snap.files)) if (typeof value !== "string") return false
  }
  return true
}

export function writeSnapshot(metaDir: string, snapshot: StoredSnapshot): void {
  mkdirSync(metaDir, { recursive: true })
  writeFileSync(join(metaDir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, JSON_INDENT)}\n`)
}

/**
 * All migration files in `migrationsDir`, in apply order. Filenames are timestamp-prefixed, so
 * a plain ascending sort is chronological (and legacy `0001_` names sort before timestamped
 * ones). The `meta/` directory and any file not ending in `ext` (the driver's migration extension)
 * ignor them.
 */
export function listMigrations(
  migrationsDir: string,
  ext: string = DEFAULT_MIGRATION_EXT,
): Migration[] {
  if (!existsSync(migrationsDir)) return []

  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((file) => ({ file, tag: file.slice(0, -ext.length) }))
}

const twoDigits = (n: number): string => String(n).padStart(TIMESTAMP_PART_WIDTH, "0")

/** A sortable UTC timestamp prefix for a new migration, e.g. `20260607153045`. */
export function timestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}` +
    twoDigits(date.getUTCMonth() + 1) +
    twoDigits(date.getUTCDate()) +
    twoDigits(date.getUTCHours()) +
    twoDigits(date.getUTCMinutes()) +
    twoDigits(date.getUTCSeconds())
  )
}

/** sha256 of a migration file's contents (drift detection / apply-time bookkeeping). */
export function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, CHECKSUM_PREFIX_LENGTH)
}

/** Turn a free-form migration name into a filename-safe slug. */
export function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "_")
      .replaceAll(/^_+|_+$/gu, "") || "migration"
  )
}
