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
export function tokenizeSurql(text: string): SurqlToken[] {
  const tokens: SurqlToken[] = []
  let depth = 0
  let i = 0
  const push = (kind: TokenKind, sliceStart: number, end: number): void => {
    tokens.push({ depth, kind, text: text.slice(sliceStart, end) })
    i = end
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]

    if (isSpace(c)) {
      let j = i
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      while (j < text.length && isSpace(text[j])) j++
      push("plain", i, j)
      continue
    }
    // Line comments (`--`, `//`) and block comments (`/* … */`).
    if ((c === "-" && next === "-") || (c === "/" && next === "/")) {
      let j = i
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      while (j < text.length && text[j] !== "\n") j++
      push("comment", i, j)
      continue
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + TWO)
      push("comment", i, close === -1 ? text.length : close + TWO)
      continue
    }
    // Prefixed literals: d'…' datetime, r'…' regex, u'…' uuid.
    if ((c === "d" || c === "r" || c === "u") && (next === "'" || next === '"')) {
      let kind: TokenKind = "uuid"
      if (c === "d") kind = "datetime"
      else if (c === "r") kind = "regex"
      push(kind, i, scanString(text, i + 1))
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      push("string", i, scanString(text, i))
      continue
    }
    if (c === "$") {
      let j = i + 1
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      while (j < text.length && BIND_PART.test(text[j])) j++
      push("bind", i, j > i + 1 ? j : i + 1)
      continue
    }
    if (isDigit(c)) {
      const end = scanNumber(text, i)
      const kind = DURATION_UNIT.test(text.slice(end)) ? "duration" : "number"
      push(kind, i, end)
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      while (j < text.length && IDENT_PART.test(text[j])) j++
      const word = text.slice(i, j)
      if (text.slice(j, j + TWO) === "::") {
        // A module path (`fn::name`, `math::sum`, `time::now`).
        let k = j
        // eslint-disable-next-line functional/no-loop-statements,max-depth -- scanner aninhado; achatar mudaria precedência
        while (k < text.length) {
          // eslint-disable-next-line max-depth -- parser/compilador com despacho aninhado; achatar mudaria a precedência das cláusulas
          if (text[k] === ":" && text[k + 1] === ":") {
            k += TWO
            // eslint-disable-next-line functional/no-loop-statements,max-depth -- scanner aninhado; achatar mudaria precedência
            while (k < text.length && IDENT_PART.test(text[k])) k++
          } else break
        }
        push("function", i, k)
        continue
      }
      if (text[j] === ":") {
        const idEnd = scanRecordId(text, j + 1)
        // eslint-disable-next-line max-depth -- parser/compilador com despacho aninhado; achatar mudaria a precedência das cláusulas
        if (idEnd > j + 1) {
          push("record", i, idEnd)
          continue
        }
      }
      push(KEYWORDS.has(word.toUpperCase()) ? "keyword" : "ident", i, j)
      continue
    }
    // Brackets track depth (for top-level clause breaks).
    if (c === "(" || c === "[" || c === "{") {
      const kind: TokenKind = "punctuation"
      push(kind, i, i + 1)
      depth++
      continue
    }
    if (c === ")" || c === "]" || c === "}") {
      push("punctuation", i, i + 1)
      depth = Math.max(0, depth - 1)
      continue
    }
    const multi = MULTI_OPERATORS.find((op) => text.startsWith(op, i))
    if (multi) {
      push("operator", i, i + multi.length)
      continue
    }
    if (OPERATOR_CHARS.has(c)) {
      push("operator", i, i + 1)
      continue
    }
    // Everything else (`,`, `.`, `;`, `:`, `?`, `@`, `~`, …) is punctuation.
    push("punctuation", i, i + 1)
  }
  return tokens
}

/** Advance past a quoted literal starting at `start` (the opening quote), honouring `\` escapes. */
function scanString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (i < text.length) {
    if (text[i] === "\\") {
      i += TWO
      continue
    }
    if (text[i] === quote) return i + 1

    i++
  }
  return i
}

/** Advance past a number literal (`123`, `1.5`) starting at `start`. */
function scanNumber(text: string, start: number): number {
  let i = start
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (i < text.length && isDigit(text[i])) i++
  if (text[i] === "." && text[i + 1] !== "." && isDigit(text[i + 1])) {
    i++
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    while (i < text.length && isDigit(text[i])) i++
  }
  return i
}

/** Advance past a record-id suffix (`tobie`, `123`, `⟨a b⟩`) starting at `start`, or return `start`. */
function scanRecordId(text: string, start: number): number {
  let i = start
  if (text[i] === "⟨") {
    const close = text.indexOf("⟩", i + 1)
    return close === -1 ? text.length : close + 1
  }
  if (text[i] === "`") return scanString(text, i)

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (i < text.length && /[A-Za-z0-9_\-@]/u.test(text[i])) i++
  return i
}

/** The SGR code a token kind paints with (`undefined` = leave plain). */
// eslint-disable-next-line @typescript-eslint/consistent-return -- switch cobre todo TokenKind; nenhum caminho cai fora dele
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
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const token of tokens) {
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
  }
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
