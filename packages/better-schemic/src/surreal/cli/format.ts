/**
 * The SurrealQL FORMATTER for generated code — `sc pull` receives bodies from INFO collapsed to a
 * single line; this pretty-prints them (statement-per-line, indented nested blocks, wide object
 * literals one-entry-per-line) so pulled schema files read like hand-written ones. Purely
 * whitespace: `normalize` canonicalizes formatting on both sides of every compare, so formatted
 * output can never phantom-diff. Exported from `better-schemic/driver` (display panes,
 * tooling) as {@link formatSurql}.
 */

/** Statement openers — a brace region starting with one (or containing a top-level `;`) is a
 * STATEMENT BLOCK (multi-line); anything else in braces is an object literal. */
const STMT_KW =
  /^(?:LET|IF|FOR|RETURN|THROW|SELECT|CREATE|UPDATE|UPSERT|DELETE|RELATE|INSERT|DEFINE|REMOVE|BREAK|CONTINUE|SLEEP|BEGIN|COMMIT|CANCEL)\b/iu

type Opts = {
  /** One indentation step (default two spaces). */
  indent?: string
  /** Wrap object/array literals longer than this rendered width (default 72). */
  width?: number
}

/** Characters consumed by a backslash escape inside a string literal. */
const ESCAPE_STEP = 2

/** Scan past a string literal starting at `i` (quote char at `text[i]`); returns the index AFTER
 * the closing quote. */
function skipString(text: string, i: number): number {
  const quote = text[i]
  const scan = (j: number): number => {
    if (j >= text.length) return text.length
    if (text[j] === "\\") return scan(j + ESCAPE_STEP)
    if (text[j] === quote) return j + 1
    return scan(j + 1)
  }
  return scan(i + 1)
}

/** The index of the bracket matching `text[open]` (quote-aware), or -1. */
function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
  const close = pairs[text[open]]
  const scan = (i: number, depth: number): number => {
    if (i >= text.length) return -1
    const c = text[i]
    if (c === '"' || c === "'") return scan(skipString(text, i), depth)
    if (c === text[open]) return scan(i + 1, depth + 1)
    if (c === close) {
      const next = depth - 1
      return next === 0 ? i : scan(i + 1, next)
    }
    return scan(i + 1, depth)
  }
  return scan(open, 0)
}

/** Split on a top-level separator (outside strings/brackets). */
function topSplit(text: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  const scan = (i: number): void => {
    if (i >= text.length) return
    const c = text[i]
    if (c === '"' || c === "'") {
      scan(skipString(text, i))
      return
    }
    if (c === "{" || c === "[" || c === "(") depth++
    else if (c === "}" || c === "]" || c === ")") depth--
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
    scan(i + 1)
  }
  scan(0)
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Collapse whitespace runs outside strings (the formatter's canonical input form). */
function collapse(text: string): string {
  let out = ""
  let pending = false
  const scan = (i: number): void => {
    if (i >= text.length) return
    const c = text[i]
    if (c === '"' || c === "'") {
      const j = skipString(text, i)
      if (pending && out.length > 0) out += " "

      pending = false
      out += text.slice(i, j)
      scan(j)
      return
    }
    if (/\s/u.test(c)) {
      pending = out.length > 0
      scan(i + 1)
      return
    }
    if (pending) out += " "

    pending = false
    out += c
    scan(i + 1)
  }
  scan(0)
  return out
}

/** Is this brace-INTERIOR a statement block (vs an object literal)? */
function isBlockBody(inner: string): boolean {
  const t = inner.trim()
  if (t === "") return false

  if (STMT_KW.test(t)) return true

  return topSplit(t, ";").length > 1 || /;\s*$/u.test(t) || t.includes(";")
}

/** Render one STATEMENT: nested statement blocks always expand (brace on the same line, body
 * indented); when the line is too wide, the LAST top-level CALL's arguments break one per line
 *  (prettier-style, trailing comma), and wide object/array literals wrap one entry per line.
 * Recursion applies the same rules inside broken arguments. */
function fmtStatement(stmt: string, level: number, indent: string, width: number): string {
  const fits = indent.repeat(level).length + stmt.length <= width
  // The break target: the LAST top-level call group with 2+ args, chosen when too wide.
  // A `DEFINE …` head never breaks — its parens are a SIGNATURE (`fn::f($a: string, $b: int)`),
  // not a call; the body block inside still formats via the block recursion.
  let breakAt = -1
  if (!fits && !/^DEFINE\b/iu.test(stmt.trim())) {
    const MIN_BREAK_ARGS = 2
    const scan = (i: number): void => {
      if (i >= stmt.length) return
      const c = stmt[i]
      if (c === '"' || c === "'") {
        scan(skipString(stmt, i))
        return
      }
      if (c === "(" && /[A-Za-z0-9_:]/u.test(stmt[i - 1] ?? "")) {
        const end = matchBracket(stmt, i)
        if (end === -1) {
          scan(i + 1)
          return
        }
        if (topSplit(stmt.slice(i + 1, end), ",").length >= MIN_BREAK_ARGS) breakAt = i
        scan(end + 1)
        return
      }
      if (c === "(" || c === "[" || c === "{") {
        const end = matchBracket(stmt, i)
        scan(end === -1 ? i + 1 : end + 1)
        return
      }
      scan(i + 1)
    }
    scan(0)
  }
  let out = ""
  const render = (i: number): void => {
    if (i >= stmt.length) return
    const c = stmt[i]
    if (c === '"' || c === "'") {
      const j = skipString(stmt, i)
      out += stmt.slice(i, j)
      render(j)
      return
    }
    if (c === "(" && i === breakAt) {
      const end = matchBracket(stmt, i)
      const args = topSplit(stmt.slice(i + 1, end), ",")
      const pad = indent.repeat(level + 1)
      out += `(\n${args
        .map((a) => `${pad}${fmtStatement(a, level + 1, indent, width)},`)
        .join("\n")}\n${indent.repeat(level)})`
      render(end + 1)
      return
    }
    if (c === "{") {
      const end = matchBracket(stmt, i)
      if (end === -1) {
        out += c
        render(i + 1)
        return
      }
      const inner = stmt.slice(i + 1, end).trim()
      out += isBlockBody(inner)
        ? `{\n${fmtStatements(inner, level + 1, indent, width)}\n${indent.repeat(level)}}`
        : fmtData(stmt.slice(i, end + 1), level, indent, width)

      render(end + 1)
      return
    }
    out += c
    render(i + 1)
  }
  render(0)
  return out
}

/** Render an object/array literal: inline when it fits, one entry per line when wide. */
function fmtData(text: string, level: number, indent: string, width: number): string {
  const open = text[0]
  const close = text.at(-1)
  const inner = text.slice(1, -1).trim()
  if (inner === "") return text

  const entries = topSplit(inner, ",").map((e) =>
    // entry VALUES may nest further data/blocks
    fmtStatement(e, level + 1, indent, width),
  )
  const spaced = open === "{" ? `{ ${entries.join(", ")} }` : `[${entries.join(", ")}]`
  if (indent.repeat(level).length + spaced.length <= width && !spaced.includes("\n")) return spaced

  const pad = indent.repeat(level + 1)
  // Prettier-style trailing comma — normalize strips trailing commas on compare.
  return `${open}\n${entries.map((e) => `${pad}${e},`).join("\n")}\n${indent.repeat(level)}${close}`
}

/** Render a `;`-separated statement list, one per line at `level`. */
function fmtStatements(body: string, level: number, indent: string, width: number): string {
  const pad = indent.repeat(level)
  return topSplit(body, ";")
    .map((s) => `${pad}${fmtStatement(s, level, indent, width)};`)
    .join("\n")
}

/**
 * Pretty-print SurrealQL: a `{ … }` block or `;`-separated statement list becomes
 * statement-per-line with indented nested blocks; wide object/array literals wrap. Single short
 * expressions come back unchanged (safe to apply everywhere). Idempotent — the input is
 * whitespace-collapsed first, so `formatSurql(formatSurql(x)) === formatSurql(x)`.
 */
export function formatSurql(text: string, opts: Opts = {}): string {
  const indent = opts.indent ?? "  "
  const DEFAULT_WIDTH = 72
  const width = opts.width ?? DEFAULT_WIDTH
  const t = collapse(text.trim())
  if (t.startsWith("{") && matchBracket(t, 0) === t.length - 1) {
    const inner = t.slice(1, -1).trim()
    if (isBlockBody(inner)) return `{\n${fmtStatements(inner, 1, indent, width)}\n}`

    return fmtData(t, 0, indent, width)
  }
  if (topSplit(t, ";").length > 1) return fmtStatements(t, 0, indent, width).replace(/^\s+/u, "")

  return fmtStatement(t, 0, indent, width)
}
