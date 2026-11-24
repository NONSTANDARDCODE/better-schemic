/**
 * SurrealQL lexical highlighting + clause alignment for the pretty logger.
 *
 * `tokenizeSurql` is a small hand-written scanner (strings, `$binds`, record ids, `fn::` paths,
 * numbers/durations, comments, operators) that carries the paren/bracket depth per token. The
 * painter colours each token and — when `pretty` is on — breaks top-level clauses onto their own
 * aligned lines. It never validates: the executor  hands it SurrealQL the compiler already
 * proved, so the scanner is total (it can always produce a token stream).
 */
import type { Palette } from "./colors"

/** The lexical classes the painter colours. */
export type TokenKind =
  | "bind"
  | "comment"
  | "datetime"
  | "duration"
  | "function"
  | "ident"
  | "keyword"
  | "number"
  | "operator"
  | "plain"
  | "punctuation"
  | "record"
  | "regex"
  | "string"
  | "uuid"

/** One scanned token with its bracket depth (for top-level clause detection). */
export type SurqlToken = {
  readonly depth: number
  readonly kind: TokenKind
  readonly text: string
}

/** Uppercase statement verbs, clauses, literals and type names that read as SurrealQL keywords. */
const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "SPLIT",
  "GROUP",
  "BY",
  "ALL",
  "ORDER",
  "LIMIT",
  "START",
  "FETCH",
  "OMIT",
  "WITH",
  "INDEX",
  "NOINDEX",
  "TIMEOUT",
  "PARALLEL",
  "VERSION",
  "TEMPFILES",
  "EXPLAIN",
  "FULL",
  "ANALYZE",
  "FORMAT",
  "TEXT",
  "JSON",
  "CREATE",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "INSERT",
  "RELATE",
  "CONTENT",
  "MERGE",
  "REPLACE",
  "PATCH",
  "SET",
  "UNSET",
  "RETURN",
  "BEFORE",
  "AFTER",
  "DIFF",
  "NONE",
  "NULL",
  "ONLY",
  "INTO",
  "IN",
  "ON",
  "DUPLICATE",
  "KEY",
  "IGNORE",
  "VALUES",
  "IS",
  "IS NOT",
  "NOT",
  "AND",
  "OR",
  "NAND",
  "NOR",
  "TRUE",
  "FALSE",
  "NONE",
  "LET",
  "BEGIN",
  "COMMIT",
  "CANCEL",
  "TRANSACTION",
  "USE",
  "NS",
  "DB",
  "INFO",
  "FOR",
  "ROOT",
  "TABLE",
  "SHOW",
  "CHANGES",
  "SINCE",
  "DEFINE",
  "REMOVE",
  "ALTER",
  "REBUILD",
  "KILL",
  "LIVE",
  "DIFF",
  "SLEEP",
  "IF",
  "ELSE",
  "THEN",
  "END",
  "CONTINUE",
  "BREAK",
  "THROW",
  "TYPE",
  "OPTION",
  "VALUE",
  "AS",
  "ASC",
  "DESC",
  "COLLATE",
  "NUMERIC",
  "RAND",
  "RECORD",
  "RANGE",
  "DISTINCT",
  "COUNT",
  "NORMAL",
  "REFERENCE",
  "DEFAULT",
  "ASSERT",
  "READONLY",
  "FLEXIBLE",
  "COMMENT",
  "PERMISSIONS",
  "FULL",
  "NOT",
  "EMPTY",
])

/** Top-level clause keywords that start a new (indented) line when `prettySql` is on. */
const BREAK_BEFORE = new Set([
  "WHERE",
  "SPLIT",
  "GROUP",
  "ORDER",
  "LIMIT",
  "START",
  "FETCH",
  "OMIT",
  "WITH",
  "TIMEOUT",
  "RETURN",
  "SET",
  "CONTENT",
  "MERGE",
  "REPLACE",
  "PATCH",
  "UNSET",
  "ON",
  "VALUES",
  "FOR",
])

const MULTI_OPERATORS = [
  "<->",
  "->",
  "<-",
  "..=",
  "..",
  ">=",
  "<=",
  "!=",
  "==",
  "&&",
  "||",
  "+=",
  "-=",
  "*=",
  "/=",
  "!~",
  "?~",
  "=>",
  "::",
  "@@",
  "<|",
  "|>",
]

const BIND_PART = /[A-Za-z0-9_]/u
const IDENT_START = /[A-Za-z_]/u
const IDENT_PART = /[A-Za-z0-9_]/u
const OPERATOR_CHARS = new Set(["+", "-", "*", "/", "%", "=", "<", ">", "!", "&", "|"])

/** A duration unit must follow the number and end at a word boundary (`5s`, `100ms`, `1h30m`). */
const DURATION_UNIT = /^(ns|us|µs|ms|s|m|h|d|w|y)(?![A-Za-z0-9_])/u

/** Two-character spans recognized by the scanner: module paths, block closers and escapes. */
const TWO = 2

const isDigit = (c: string): boolean => c >= "0" && c <= "9"
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r"

/** Scan SurrealQL into coloured-able tokens (total — no validation, no throw). */
/** First index from `start` where `predicate` fails (or `text.length`). */
function scanWhile(text: string, start: number, predicate: (ch: string) => boolean): number {
  const firstFail = text
    .slice(start)
    .split("")
    .findIndex((ch) => !predicate(ch))
  return firstFail === -1 ? text.length : start + firstFail
}

/** Scan a `::`-separated module path (`fn::name::part`) from its first colon. */
function scanModulePath(text: string, start: number): number {
  if (text[start] !== ":" || text[start + 1] !== ":") return start
  const afterColons = start + TWO
  return scanModulePath(
    text,
    scanWhile(text, afterColons, (ch) => IDENT_PART.test(ch)),
  )
}

export function tokenizeSurql(text: string): SurqlToken[] {
  const tokens: SurqlToken[] = []
  let depth = 0
  let i = 0
  const push = (kind: TokenKind, sliceStart: number, end: number): void => {
    tokens.push({ depth, kind, text: text.slice(sliceStart, end) })
    i = end
  }

  text.split("").forEach((_char, start) => {
    if (start < i) return
    i = start
    const c = text[i]
    const next = text[i + 1]

    if (isSpace(c)) {
      const j = scanWhile(text, i, isSpace)
      push("plain", i, j)
      return
    }
    // Line comments (`--`, `//`) and block comments (`/* … */`).
    if ((c === "-" && next === "-") || (c === "/" && next === "/")) {
      const j = scanWhile(text, i, (ch) => ch !== "\n")
      push("comment", i, j)
      return
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + TWO)
      push("comment", i, close === -1 ? text.length : close + TWO)
      return
    }
    // Prefixed literals: d'…' datetime, r'…' regex, u'…' uuid.
    if ((c === "d" || c === "r" || c === "u") && (next === "'" || next === '"')) {
      let kind: TokenKind = "uuid"
      if (c === "d") kind = "datetime"
      else if (c === "r") kind = "regex"
      push(kind, i, scanString(text, i + 1))
      return
    }
    if (c === "'" || c === '"' || c === "`") {
      push("string", i, scanString(text, i))
      return
    }
    if (c === "$") {
      const j = scanWhile(text, i + 1, (ch) => BIND_PART.test(ch))
      push("bind", i, j > i + 1 ? j : i + 1)
      return
    }
    if (isDigit(c)) {
      const end = scanNumber(text, i)
      const kind = DURATION_UNIT.test(text.slice(end)) ? "duration" : "number"
      push(kind, i, end)
      return
    }
    if (IDENT_START.test(c)) {
      const j = scanWhile(text, i, (ch) => IDENT_PART.test(ch))
      const word = text.slice(i, j)
      if (text.slice(j, j + TWO) === "::") {
        // A module path (`fn::name`, `math::sum`, `time::now`).
        push("function", i, scanModulePath(text, j))
        return
      }
      const idEnd = text[j] === ":" ? scanRecordId(text, j + 1) : j + 1
      if (idEnd > j + 1) {
        push("record", i, idEnd)
        return
      }
      push(KEYWORDS.has(word.toUpperCase()) ? "keyword" : "ident", i, j)
      return
    }
    // Brackets track depth (for top-level clause breaks).
    if (c === "(" || c === "[" || c === "{") {
      const kind: TokenKind = "punctuation"
      push(kind, i, i + 1)
      depth++
      return
    }
    if (c === ")" || c === "]" || c === "}") {
      push("punctuation", i, i + 1)
      depth = Math.max(0, depth - 1)
      return
    }
    const multi = MULTI_OPERATORS.find((op) => text.startsWith(op, i))
    if (multi) {
      push("operator", i, i + multi.length)
      return
    }
    if (OPERATOR_CHARS.has(c)) {
      push("operator", i, i + 1)
      return
    }
    // Everything else (`,`, `.`, `;`, `:`, `?`, `@`, `~`, …) is punctuation.
    push("punctuation", i, i + 1)
  })
  return tokens
}

/** Advance past a quoted literal starting at `start` (the opening quote), honouring `\` escapes. */
function scanString(text: string, start: number): number {
  const quote = text[start]
  const scan = (index: number): number => {
    if (index >= text.length) return index
    if (text[index] === "\\") return scan(index + TWO)
    if (text[index] === quote) return index + 1
    return scan(index + 1)
  }
  return scan(start + 1)
}

/** Advance past a number literal (`123`, `1.5`) starting at `start`. */
function scanNumber(text: string, start: number): number {
  let i = scanWhile(text, start, isDigit)
  if (text[i] === "." && text[i + 1] !== "." && isDigit(text[i + 1]))
    i = scanWhile(text, i + 1, isDigit)
  return i
}

/** Advance past a record-id suffix (`tobie`, `123`, `⟨a b⟩`) starting at `start`, or return `start`. */
function scanRecordId(text: string, start: number): number {
  const i = start
  if (text[i] === "⟨") {
    const close = text.indexOf("⟩", i + 1)
    return close === -1 ? text.length : close + 1
  }
  if (text[i] === "`") return scanString(text, i)

  return scanWhile(text, i, (ch) => /[A-Za-z0-9_\-@]/u.test(ch))
}

/** The SGR code a token kind paints with (`undefined` = leave plain). */

function codeOf(kind: TokenKind): string | undefined {
  switch (kind) {
    case "keyword":
      return "\u001B[1;94m"
    case "string":
      return "\u001B[32m"
    case "number":
      return "\u001B[36m"
    case "duration":
    case "datetime":
    case "uuid":
      return "\u001B[96m"
    case "regex":
      return "\u001B[35m"
    case "bind":
      return "\u001B[1;93m"
    case "record":
      return "\u001B[33m"
    case "function":
      return "\u001B[95m"
    case "comment":
      return "\u001B[90m"
    case "operator":
      return "\u001B[35m"
    case "punctuation":
      return "\u001B[90m"
    case "ident":
    case "plain":
      return undefined
    default:
      return undefined
  }
}

const paintToken = (token: SurqlToken, palette: Palette): string => {
  const code = codeOf(token.kind)
  return code ? palette.paint(code, token.text) : token.text
}

/**
 * Paint a token stream. With `pretty`, a top-level clause keyword starts a new 2-space-indented line
 * (bracketed sub-queries stay inline), so a compiled statement reads clause-per-line.
 */
export function paintSurql(
  tokens: readonly SurqlToken[],
  palette: Palette,
  pretty: boolean,
): string {
  const lines: string[] = []
  let current = ""

  tokens.forEach((token) => {
    const isBreak =
      pretty &&
      token.depth === 0 &&
      token.kind === "keyword" &&
      BREAK_BEFORE.has(token.text.toUpperCase()) &&
      current.trim() !== ""
    if (isBreak) {
      lines.push(current.replace(/\s+$/u, ""))
      current = "  "
    }
    current += paintToken(token, palette)
  })
  if (current.trim() !== "") lines.push(current)

  return lines.join("\n")
}

/** Highlight one SurrealQL string, returning its painted (optionally multi-line) form. */
export function highlightSurql(sql: string, palette: Palette, pretty = true): string {
  return paintSurql(tokenizeSurql(sql), palette, pretty)
}

/** Highlight a statement and split it into display lines. */
export function sqlLines(sql: string, palette: Palette, pretty: boolean): string[] {
  return highlightSurql(sql.replace(/\s+$/u, ""), palette, pretty).split("\n")
}
