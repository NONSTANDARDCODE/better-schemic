// Formatting must never phantom-diff: authors write MULTI-LINE surql bodies, INFO prints blocks
// single-line — and INFO itself prints nested multi-statement blocks with NEWLINES. Both sides
// normalize through collapseWs (quote-aware), so real changes diff.
import { describe, expect, test } from "bun:test"

import { normalizeFunction } from "../../../src/surreal/cli/struct"

describe("block whitespace canonicalization", () => {
  test("multi-line function block == single-line (trailing ; dropped)", () => {
    const multi = normalizeFunction({
      args: [],
      block: "{ LET $x = string::concat(\n  'a',\n  'b'\n);\n  RETURN $x;\n}",
      name: "f",
    })
    const single = normalizeFunction({
      args: [],
      block: "{ LET $x = string::concat('a', 'b'); RETURN $x }",
      name: "f",
    })
    expect(multi.block).toBe(single.block)
  })

  test("whitespace INSIDE string literals is preserved", () => {
    const fn = normalizeFunction({
      args: [],
      block: "{ RETURN 'two  spaces\\nand a newline' }",
      name: "f",
    })
    expect(fn.block).toContain("two  spaces\\nand a newline")
  })
})
