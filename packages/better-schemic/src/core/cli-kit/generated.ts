// Directives shared by generated artifacts: the banner, idempotent in-place application, and the
// ignore-pattern merge used by the codegen commands (knip / tsconfig / bunfig / .gitignore).
// Command-line helper: every operation is synchronous and uses `node:fs` directly.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"

/** Default stable marker. Doubles as the `@ts-nocheck` directive in the default header. */
const DEFAULT_MARKER = "// @ts-nocheck — generated"
/** Marker used when you disable `@ts-nocheck` without providing a custom marker. */
const PLAIN_MARKER = "// generated"
const ESLINT_DISABLE = "/* eslint-disable */"
const DOT_SLASH = "./"
/** JSON ignore files are always written with a two-space indent. */
const JSON_INDENT = 2
const BASE_IGNORE_PATTERNS = [".better-schemic/**", "src/db/generated/**"] as const

export type GeneratedOpts = {
  /** Prepend `/* eslint-disable *\/`. Default true. */
  readonly eslintDisable?: boolean
  /** Whether generated paths belong in knip ignores. Default 'ignore'. */
  readonly knip?: "ignore" | "off"
  /** When true, `writeIgnores` actually edits knip.json / tsconfig.json / bunfig.toml / .gitignore. Default false. */
  readonly knipAutoWrite?: boolean
  /** Stable marker line used for idempotence. Default `// @ts-nocheck — generated`. */
  readonly marker?: string
  /** Prepend `// @ts-nocheck — generated`. Default true. */
  readonly tsNocheck?: boolean
}

type ResolvedOpts = {
  readonly eslintDisable: boolean
  readonly knip: "ignore" | "off"
  readonly knipAutoWrite: boolean
  readonly marker: string
}

/** The marker is always the first header line; `applyDirectives` looks for it. */
function markerOf(opts: GeneratedOpts | undefined): string {
  if (opts?.marker !== undefined) return opts.marker

  return opts?.tsNocheck === false ? PLAIN_MARKER : DEFAULT_MARKER
}

function resolveOpts(opts: GeneratedOpts | undefined): ResolvedOpts {
  return {
    eslintDisable: opts?.eslintDisable !== false,
    knip: opts?.knip ?? "ignore",
    knipAutoWrite: opts?.knipAutoWrite === true,
    marker: markerOf(opts),
  }
}

function directiveLines(
  opts: GeneratedOpts | undefined,
  extraLines: readonly string[] | undefined,
): string[] {
  const settings = resolveOpts(opts)
  return [
    settings.marker,
    ...(settings.eslintDisable ? [ESLINT_DISABLE] : []),
    ...(extraLines ?? []),
    "",
  ]
}

/** Build the banner: marker, eslint disable, caller-supplied lines, then a blank line. */
export function header(opts?: GeneratedOpts, extraLines?: readonly string[]): string {
  return `${directiveLines(opts, extraLines).join("\n")}\n`
}

/**
 * Add the directive banner to an existing file IN PLACE, keeping a leading shebang on line one.
 * Returns false (without touching the file) when the marker is already present or the file is
 * absent.
 */
export function applyDirectives(
  file: string,
  opts?: GeneratedOpts,
  extraLines?: readonly string[],
): boolean {
  if (!existsSync(file)) return false

  const content = readFileSync(file, "utf8")
  if (content.includes(markerOf(opts))) return false

  const lines = content.split("\n")
  const first = lines[0] ?? ""
  const hasShebang = first.startsWith("#!")
  const shebang = hasShebang ? `${first}\n` : ""
  const body = hasShebang ? lines.slice(1).join("\n") : content
  writeFileSync(file, `${shebang}${header(opts, extraLines)}${body}`)
  return true
}

/** Normalize a supplied file path to a POSIX-style, project-relative glob pattern. */
function toPattern(path: string, base: string): string {
  const rel = isAbsolute(path) ? relative(base, path) : path
  const posix = rel.split(sep).join("/")
  return posix.startsWith(DOT_SLASH) ? posix.slice(DOT_SLASH.length) : posix
}

/** Base patterns plus the supplied paths, de-duplicated and made project-relative. */
export function ignorePatterns(paths: readonly string[], root?: string): string[] {
  const base = root ?? process.cwd()
  return [
    ...new Set([
      ...BASE_IGNORE_PATTERNS,
      ...paths.map((path) => toPattern(path, base)).filter((pattern) => pattern.length > 0),
    ]),
  ]
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined

  return parsed as Record<string, unknown>
}

/** Merge into an existing JSON file's string-array field. Returns a status line or undefined. */
function mergeJsonArray(
  root: string,
  name: string,
  key: string,
  patterns: readonly string[],
): string | undefined {
  const path = join(root, name)
  if (!existsSync(path)) return undefined

  const obj = readJsonObject(path)
  if (obj === undefined) return `${name} (skipped: not a JSON object)`

  const existing = obj[key]
  let current: readonly string[] = []
  if (existing !== undefined) {
    if (!Array.isArray(existing)) return `${name} (skipped: ${key} is not an array)`

    const items = existing as unknown[]
    if (!items.every((item): item is string => typeof item === "string"))
      return `${name} (skipped: ${key} is not a string array)`

    current = items
  }
  const merged = [...new Set([...current, ...patterns])]
  if (merged.length === current.length) return undefined

  writeFileSync(path, `${JSON.stringify({ ...obj, [key]: merged }, null, JSON_INDENT)}\n`)
  return name
}

type TomlArrayLocation = {
  /** Index after the closing `]`. */
  readonly end: number
  /** Text between the brackets. */
  readonly inner: string
  /** The full `[...]` literal. */
  readonly literal: string
  /** Index of the opening `[`. */
  readonly start: number
}

/** Locate the single `ignorePatterns = [...]` assignment inside the `[lint]` TOML section. */
function locateTomlArray(text: string): TomlArrayLocation | undefined {
  const header = /^[ \t]*\[lint\][ \t]*(?:#[^\n]*)?$/mu.exec(text)
  if (header === null) return undefined

  const offset = header.index + header[0].length
  const tail = text.slice(offset)
  const nextSection = /^[ \t]*\[/mu.exec(tail)
  const section = nextSection === null ? tail : tail.slice(0, nextSection.index)
  const assignments = section
    .split("\n")
    .filter((line) => /^[ \t]*ignorePatterns[ \t]*=/u.test(line))
  if (assignments.length !== 1) return undefined

  const match =
    /^([ \t]*ignorePatterns[ \t]*=[ \t]*\[)([\s\S]*?)(\][ \t]*(?:#[^\n]*)?)(?=\n|$)/mu.exec(section)
  if (match === null) return undefined

  const prefix = match[1]
  const inner = match[2]
  const close = offset + match.index + prefix.length + inner.length
  const start = close - inner.length - 1
  const end = close + 1
  return { end, inner, literal: text.slice(start, end), start }
}

/** Narrow an unknown parsed-TOML value to a string array. */
function tomlStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const items = value as unknown[]
  return items.every((item): item is string => typeof item === "string") ? items : undefined
}

/** Parse a TOML array literal into a string array, or undefined when unsafe. */
function tomlArrayOf(literal: string): readonly string[] | undefined {
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(`ignorePatterns = ${literal}`)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined

  return tomlStringArray((parsed as { ignorePatterns?: unknown }).ignorePatterns)
}

/** Re-render a validated array literal with the merged items, preserving its layout style. */
function renderTomlArray(literal: string, items: readonly string[]): string {
  if (!literal.includes("\n")) return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`

  const lines = literal.split("\n")
  const closing = lines.at(-1) ?? "]"
  const closeIndent = /^[ \t]*/u.exec(closing)?.[0] ?? ""
  const itemIndent =
    lines
      .slice(0, -1)
      .map((line) => /^[ \t]*/u.exec(line)?.[0] ?? "")
      .find((indent) => indent.length > 0) ?? `${closeIndent}  `
  const body = items.map((item) => `${itemIndent}${JSON.stringify(item)},`).join("\n")
  return `[\n${body}\n${closeIndent}]`
}

/** Merge into `bunfig.toml`'s `[lint].ignorePatterns` when doing so proves safe. */
function mergeToml(root: string, name: string, patterns: readonly string[]): string | undefined {
  const path = join(root, name)
  if (!existsSync(path)) return undefined

  const text = readFileSync(path, "utf8")
  let doc: unknown
  try {
    doc = Bun.TOML.parse(text)
  } catch {
    return `${name} (skipped: invalid TOML)`
  }
  const lint =
    typeof doc === "object" && doc !== null ? (doc as { lint?: unknown }).lint : undefined
  const configured =
    typeof lint === "object" && lint !== null
      ? tomlStringArray((lint as { ignorePatterns?: unknown }).ignorePatterns)
      : undefined
  if (configured === undefined)
    return `${name} (skipped: missing [lint].ignorePatterns string array)`

  const location = locateTomlArray(text)
  if (location === undefined) return `${name} (skipped: could not locate [lint].ignorePatterns)`

  const literalItems = tomlArrayOf(location.literal)
  if (literalItems === undefined || JSON.stringify(literalItems) !== JSON.stringify(configured))
    return `${name} (skipped: ignorePatterns has unsupported formatting)`

  if (location.inner.includes("#")) return `${name} (skipped: ignorePatterns contains comments)`

  const merged = [...new Set([...configured, ...patterns])]
  if (merged.length === configured.length) return undefined

  const replacement = renderTomlArray(location.literal, merged)
  writeFileSync(path, `${text.slice(0, location.start)}${replacement}${text.slice(location.end)}`)
  return name
}

/** Append new ignore lines to an existing `.gitignore`, without duplicates. */
function mergeGitignore(root: string, patterns: readonly string[]): string | undefined {
  const path = join(root, ".gitignore")
  if (!existsSync(path)) return undefined

  const text = readFileSync(path, "utf8")
  const existing = new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )
  const additions = patterns.filter((pattern) => !existing.has(pattern))
  if (additions.length === 0) return undefined

  const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
  writeFileSync(path, `${text}${separator}${additions.join("\n")}\n`)
  return ".gitignore"
}

/**
 * Compute the suggested ignore patterns and, when `knipAutoWrite` is true, merge them into the
 * ignore files that actually exist. `knip: 'off'` skips knip.json but still maintains the others.
 * `written` lists edited filenames; unsafe/absent files are either omitted or reported with a
 * `(skipped: …)` reason. Every call is idempotent.
 */
export function writeIgnores(
  root: string,
  paths: readonly string[],
  opts?: GeneratedOpts,
): { suggested: string[]; written: string[] } {
  const suggested = ignorePatterns(paths, root)
  const settings = resolveOpts(opts)
  if (!settings.knipAutoWrite) return { suggested, written: [] }

  const outcomes = [
    settings.knip === "ignore" ? mergeJsonArray(root, "knip.json", "ignore", suggested) : undefined,
    mergeJsonArray(root, "tsconfig.json", "exclude", suggested),
    mergeToml(root, "bunfig.toml", suggested),
    mergeGitignore(root, suggested),
  ]
  return {
    suggested,
    written: outcomes.filter((item): item is string => item !== undefined),
  }
}
