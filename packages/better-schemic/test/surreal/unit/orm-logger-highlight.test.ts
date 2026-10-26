// The SurrealQL highlighter + palette: tokenizer classes, top-level clause breaks, ANSI painting and
// The width helpers the box renderer relies on. Offline (pure).
import { describe, expect, test } from "bun:test"

import {
  createPalette,
  detectColor,
  padEnd,
  stripAnsi,
  visibleWidth,
} from "../../../src/surreal/orm/logger/colors"
import { highlightSurql, sqlLines, tokenizeSurql } from "../../../src/surreal/orm/logger/highlight"

const kinds = (sql: string): string[] => tokenizeSurql(sql).map((t) => t.kind),
  texts = (sql: string): string[] => tokenizeSurql(sql).map((t) => t.text),
  kindOf = (sql: string, text: string): string | undefined =>
    tokenizeSurql(sql).find((t) => t.text === text)?.kind

describe("tokenizeSurql — lexical classes", () => {
  test("classifies keywords, operators and punctuation", () => {
    const sql = "SELECT * FROM user WHERE age >= $p0 AND active = true"
    expect(kindOf(sql, "SELECT")).toBe("keyword")
    expect(kindOf(sql, "WHERE")).toBe("keyword")
    expect(kindOf(sql, "true")).toBe("keyword")
    expect(kindOf(sql, ">=")).toBe("operator")
    expect(kindOf(sql, "=")).toBe("operator")
    expect(kindOf(sql, "*")).toBe("operator")
    expect(kindOf(sql, ",") ?? "punctuation").toBe("punctuation")
    expect(kindOf(sql, "$p0")).toBe("bind")
  })

  test("identifiers that are not keywords stay plain idents", () => {
    expect(kindOf("SELECT name FROM user", "name")).toBe("ident")
    expect(kindOf("SELECT name FROM user", "user")).toBe("ident")
  })

  test("record ids are one token (table:id, string ids, bracketed ids)", () => {
    expect(kindOf("SELECT * FROM user:tobie", "user:tobie")).toBe("record")
    expect(kindOf("SELECT * FROM user:123", "user:123")).toBe("record")
    expect(kindOf("SELECT * FROM user:⟨a b⟩", "user:⟨a b⟩")).toBe("record")
    // An object key with a SPACE after the colon is not a record id.
    expect(kindOf("CONTENT { name: 'A' }", "name")).toBe("ident")
    expect(kindOf("CONTENT { name: 'A' }", ":")).toBe("punctuation")
  })

  test("module paths are functions (fn::, math::, time::)", () => {
    expect(kindOf("SELECT math::sum(age) FROM user", "math::sum")).toBe("function")
    expect(kindOf("RETURN fn::greet($p0)", "fn::greet")).toBe("function")
    expect(kindOf("SELECT time::now()", "time::now")).toBe("function")
  })

  test("numbers and durations", () => {
    expect(kindOf("SELECT * FROM user WHERE age >= 42", "42")).toBe("number")
    expect(kindOf("SELECT 3.14", "3.14")).toBe("number")
    expect(kindOf("SELECT * FROM user TIMEOUT 50ms", "50")).toBe("duration")
    expect(kindOf("SELECT * FROM user TIMEOUT 5s", "5")).toBe("duration")
    expect(kindOf("SELECT * FROM user WHERE n = 5m", "5")).toBe("duration")
    // A record-id number is part of the record token, not a number.
    expect(kindOf("SELECT * FROM t:1", "t:1")).toBe("record")
  })

  test("prefixed literals, strings and backtick identifiers", () => {
    const sql = `SELECT d'2025-01-01T00:00:00Z', r'[a-z]+', u'8f1', 'plain', "double", \`esc\``
    expect(kindOf(sql, "d'2025-01-01T00:00:00Z'")).toBe("datetime")
    expect(kindOf(sql, "r'[a-z]+'")).toBe("regex")
    expect(kindOf(sql, "u'8f1'")).toBe("uuid")
    expect(kindOf(sql, "'plain'")).toBe("string")
    expect(kindOf(sql, '"double"')).toBe("string")
    expect(kindOf(sql, "`esc`")).toBe("string")
  })

  test("string escapes do not end the literal early", () => {
    const sql = `SELECT * FROM user WHERE name = 'O\\'Brien; DROP'`
    expect(kindOf(sql, String.raw`'O\'Brien; DROP'`)).toBe("string")
  })

  test("line and block comments", () => {
    const sql = "SELECT 1 -- tail\n// full\n/* block */ SELECT 2"
    expect(texts(sql).filter((t) => t.startsWith("--"))).toHaveLength(1)
    expect(kindOf(sql, "// full")).toBe("comment")
    expect(kindOf(sql, "/* block */")).toBe("comment")
  })

  test("operators include graph/multi-char forms and range syntax", () => {
    expect(kindOf("RELATE u:a->likes->u:b", "->")).toBe("operator")
    expect(kindOf("RELATE u:a<->likes<->u:b", "<->")).toBe("operator")
    expect(kindOf("SELECT * FROM t:1..=5", "..=")).toBe("operator")
    expect(kindOf("SELECT * FROM t:1..5", "..")).toBe("operator")
    expect(kindOf("WHERE a != 1 AND b == 2", "!=")).toBe("operator")
    expect(kindOf("WHERE a && b || c", "&&")).toBe("operator")
    expect(kindOf("WHERE a && b || c", "||")).toBe("operator")
  })

  test("bracket depth is tracked per token", () => {
    const sql = "SELECT count() FROM user GROUP ALL",
      open = tokenizeSurql(sql).find((t) => t.text === "("),
      close = tokenizeSurql(sql).find((t) => t.text === ")"),
      group = tokenizeSurql(sql).find((t) => t.text === "GROUP")
    expect(open?.depth).toBe(0)
    expect(close?.depth).toBe(1)
    expect(group?.depth).toBe(0)
  })

  test("unterminated strings/comments and stray chars are total (never throw)", () => {
    expect(() => tokenizeSurql("SELECT 'unterminated")).not.toThrow()
    expect(() => tokenizeSurql("SELECT /* open")).not.toThrow()
    expect(kinds("SELECT @foo ? #")).toContain("punctuation")
    expect(kinds("")).toEqual([])
    expect(kinds("SELECT $")).toEqual(["keyword", "plain", "bind"])
    expect(kinds("SELECT d")).toEqual(["keyword", "plain", "ident"])
  })

  test("covers the remaining scanner arms (tabs, times, ranges, brackets)", () => {
    // Tab/CR whitespace.
    expect(kinds("SELECT\t1\r")).toContain("plain")
    // A line comment terminated by EOF (no newline).
    expect(kindOf("SELECT 1 -- eof", "-- eof")).toBe("comment")
    // Division `/` (not a comment) and bracket punctuation.
    expect(kindOf("SELECT a / b", "/")).toBe("operator")
    expect(kindOf("INSERT INTO t [1, 2]", "[")).toBe("punctuation")
    expect(kindOf("INSERT INTO t [1, 2]", "]")).toBe("punctuation")
    // Double-quoted prefixed literal.
    expect(kindOf(`SELECT d"2025-01-01"`, `d"2025-01-01"`)).toBe("datetime")
    // A function path with a trailing single colon segment.
    expect(kindOf("SELECT a::b:c", "a::b")).toBe("function")
    // A bare `fn::` at end of input (no name).
    expect(kindOf("SELECT fn::", "fn::")).toBe("function")
    // A record id whose id part is a backtick string.
    expect(kindOf("SELECT * FROM t:`x`", "t:`x`")).toBe("record")
    // Numbers: fractional, a range, and a dotted non-digit.
    expect(kindOf("SELECT 1.5", "1.5")).toBe("number")
    expect(kindOf("SELECT 1..5", "1")).toBe("number") // Range, not a float
    expect(kindOf("SELECT * FROM t:1..5", "..")).toBe("operator")
    expect(kindOf("SELECT (1.5)", "1.5")).toBe("number")
    expect(kindOf("SELECT 1.x", "1")).toBe("number")
    // An unterminated bracketed record id.
    expect(kindOf("SELECT t:⟨abc", "t:⟨abc")).toBe("record")
    // A leading clause keyword does not break (line is empty).
    expect(highlightSurql("WHERE x = 1", createPalette(false), true)).toBe("WHERE x = 1")
  })

  test("paints every token class when colors are on", () => {
    const sql =
        "/* c */ SELECT person:tobie, d'2025-01-01', r'[a-z]', u'8f1', 5ms, math::sum(age), $p0 -- tail",
      colored = highlightSurql(sql, createPalette(true), false)
    expect(stripAnsi(colored)).toBe(sql)
    expect(colored).toContain("\u001B[90m") // Comment/punctuation
    expect(colored).toContain("\u001B[95m") // Function
    expect(colored).toContain("\u001B[96m") // Datetime/duration/uuid
    expect(colored).toContain("\u001B[35m") // Regex/operator
    expect(colored).toContain("\u001B[33m") // Record
  })
})

describe("highlightSurql / sqlLines", () => {
  test("colors:false is plain text; colors:true adds ANSI", () => {
    const sql = "SELECT * FROM user WHERE age >= $p0",
      plain = highlightSurql(sql, createPalette(false), false)
    expect(plain).toBe(sql)
    expect(plain).not.toContain("\u001B")
    const colored = highlightSurql(sql, createPalette(true), false)
    expect(colored).toContain("\u001B[")
    expect(stripAnsi(colored)).toBe(sql)
  })

  test("pretty breaks the top-level clauses onto indented lines", () => {
    const pretty = highlightSurql(
      "SELECT * FROM user WHERE age >= $p0 ORDER BY name LIMIT 10 FETCH author",
      createPalette(false),
      true,
    )
    expect(pretty).toBe(
      [
        "SELECT * FROM user",
        "  WHERE age >= $p0",
        "  ORDER BY name",
        "  LIMIT 10",
        "  FETCH author",
      ].join("\n"),
    )
  })

  test("write clauses break too", () => {
    expect(highlightSurql("UPDATE user:1 SET name = 'A'", createPalette(false), true)).toBe(
      "UPDATE user:1\n  SET name = 'A'",
    )
    expect(highlightSurql("CREATE user:1 CONTENT $p0", createPalette(false), true)).toBe(
      "CREATE user:1\n  CONTENT $p0",
    )
  })

  test("sub-query clauses (depth > 0) stay inline", () => {
    const pretty = highlightSurql(
        "SELECT * FROM (SELECT * FROM user WHERE x = 1) WHERE y = 2",
        createPalette(false),
        true,
      ),
      lines = pretty.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("(SELECT * FROM user WHERE x = 1)")
    expect(lines[1]).toBe("  WHERE y = 2")
  })

  test("sqlLines splits and trims a statement", () => {
    expect(sqlLines("SELECT 1;\n", createPalette(false), false)).toEqual(["SELECT 1;"])
    expect(sqlLines("SELECT 1", createPalette(false), true)).toEqual(["SELECT 1"])
  })

  test("highlight prefers color:false identity for an empty string", () => {
    expect(highlightSurql("", createPalette(false), true)).toBe("")
    expect(highlightSurql("   ", createPalette(false), true)).toBe("")
    // The `pretty` default (omitted) is on.
    expect(highlightSurql("SELECT * FROM t WHERE x = 1", createPalette(false))).toBe(
      "SELECT * FROM t\n  WHERE x = 1",
    )
  })
})

describe("palette & width helpers", () => {
  test("detectColor honours the explicit override and the env flags", () => {
    expect(detectColor(true, {})).toBe(true)
    expect(detectColor(false, {})).toBe(false)
    expect(detectColor("auto", { NO_COLOR: "1" })).toBe(false)
    expect(detectColor("auto", { NO_COLOR: "" })).toBe(false)
    expect(detectColor("auto", { FORCE_COLOR: "1" })).toBe(true)
    expect(detectColor("auto", { FORCE_COLOR: "0" })).toBe(false)
    expect(detectColor("auto", { FORCE_COLOR: "" })).toBe(false)
    expect(detectColor("auto", { TERM: "dumb" })).toBe(false)
    // No signals at all: falls through to the (non-TTY here) stdout check.
    expect(detectColor(undefined, {})).toBe(false)
  })

  test("a disabled palette is the identity", () => {
    const p = createPalette(false)
    expect(p.enabled).toBe(false)
    expect(p.paint("\u001B[31m", "x")).toBe("x")
    expect(p.reset).toBe("")
    const on = createPalette(true)
    expect(on.enabled).toBe(true)
    expect(on.paint("\u001B[31m", "x")).toBe("\u001B[31mx\u001B[0m")
    expect(on.reset).toBe("\u001B[0m")
  })

  test("stripAnsi + visibleWidth + padEnd", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red")
    expect(visibleWidth("\u001B[31mred\u001B[0m")).toBe(3)
    expect(visibleWidth("a😀b")).toBe(4) // Emoji are double-width
    expect(visibleWidth("コンニチハ")).toBe(10) // CJK
    expect(visibleWidth("a\u0301")).toBe(1) // Combining accent
    expect(visibleWidth("a\u200Db")).toBe(2) // Zero-width joiner
    expect(visibleWidth("\u0000")).toBe(0) // Control
    expect(visibleWidth("\u2B50")).toBe(2) // Star
    expect(visibleWidth("\u3131")).toBe(2) // Hangul jamo
    expect(padEnd("ab", 4)).toBe("ab  ")
    expect(padEnd("ab", 2)).toBe("ab") // Exactly fits
    expect(padEnd("abcd", 2)).toBe("abcd") // Never truncates
    expect(padEnd("😀", 2)).toBe("😀")
  })

  test("codePointWidth covers every zero/wide range and its boundaries", () => {
    // Zero-width classes.
    expect(visibleWidth("\u0301")).toBe(0) // Combining diacritics
    expect(visibleWidth("\u1AB0")).toBe(0)
    expect(visibleWidth("\u1DC0")).toBe(0)
    expect(visibleWidth("\u20D0")).toBe(0)
    expect(visibleWidth("\uFE0F")).toBe(0) // Variation selector
    expect(visibleWidth("\uFE20")).toBe(0) // Combining half mark
    // Wide classes + one code past each upper bound (falls through to width 1).
    expect(visibleWidth("\u1100")).toBe(2)
    expect(visibleWidth("\u1160")).toBe(1)
    expect(visibleWidth("\u2600")).toBe(2)
    expect(visibleWidth("\u27BF")).toBe(2)
    expect(visibleWidth("\u27C0")).toBe(1)
    expect(visibleWidth("\u2B00")).toBe(2)
    expect(visibleWidth("\u2C00")).toBe(1)
    expect(visibleWidth("\u2E80")).toBe(2)
    expect(visibleWidth("\uA4CF")).toBe(2)
    expect(visibleWidth("\uA4D0")).toBe(1)
    expect(visibleWidth("\u{1F000}")).toBe(2)
    expect(visibleWidth("\u{1FAFF}")).toBe(2)
    expect(visibleWidth("\u{1FB00}")).toBe(1)
    expect(visibleWidth("\u{10FFFF}")).toBe(1)
    expect(visibleWidth("A")).toBe(1)
  })
})
