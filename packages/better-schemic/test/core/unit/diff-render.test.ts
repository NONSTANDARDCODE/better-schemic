import { describe, expect, test } from "bun:test"

import type { Diff, DiffItem } from "../../../src/core/cli-kit/diff"

const MAGIC_3 = 3
// Multi-line DDL rendering: since drivers pretty-print display statements, every LINE of a
// statement must carry its diff indicator (a bare continuation line reads as context), unified-patch
// hunk counts must count LINES, and the inline token view collapses onto one line. Runs with color
// disabled (NO_COLOR) so the markers are assertable.

process.env.NO_COLOR = "1"

const { formatDiff, formatItems, formatPatch } = await import("../../../src/core/cli-kit/diff")

const MULTI = "DEFINE FUNCTION fn::hello() {\n  RETURN 1;\n}"
const MULTI_AFTER = "DEFINE FUNCTION fn::hello() {\n  RETURN 2;\n}"

function item(op: DiffItem["op"]): DiffItem {
  const base = {
    file: "fns.ts",
    key: "fn:hello",
    kind: "function",
    table: "hello",
  }
  if (op === "add") return { ...base, ddl: MULTI, op }
  if (op === "remove") return { ...base, ddl: "REMOVE FUNCTION fn::hello", old: MULTI, op }
  return { ...base, after: MULTI_AFTER, before: MULTI, op }
}

describe("multi-line diff rendering", () => {
  test("add: every line carries the + indicator", () => {
    const out = formatItems([item("add")])
    const lines = out.split("\n").slice(1) // drop the file header
    expect(lines).toHaveLength(MAGIC_3)
    lines.forEach((l) => {
      expect(l).toStartWith("  + ")
    })
  })

  test("change: every before line gets -, every after line gets +", () => {
    const out = formatItems([item("change")])
    const lines = out.split("\n").slice(1)
    expect(lines.filter((l) => l.startsWith("  - "))).toHaveLength(MAGIC_3)
    expect(lines.filter((l) => l.startsWith("  + "))).toHaveLength(MAGIC_3)
  })

  test("inline change collapses to a single word-diff line", () => {
    const out = formatItems([item("change")], true)
    const lines = out.split("\n").slice(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("[-1;-]")
    expect(lines[0]).toContain("{+2;+}")
  })

  test("patch: per-line signs and line-accurate hunk counts", () => {
    const patch = formatPatch({ down: [], items: [item("change")], up: ["x"] })
    expect(patch).toContain("@@ -1,3 +1,3 @@")
    const body = patch.split("\n")
    expect(body.filter((l) => l.startsWith("-".repeat(1)) && !l.startsWith("---"))).toHaveLength(
      MAGIC_3,
    )
    expect(body.filter((l) => l.startsWith("+") && !l.startsWith("+++"))).toHaveLength(MAGIC_3)
  })

  test("patch: removal counts the dropped object's prior lines", () => {
    const patch = formatPatch({ down: [], items: [item("remove")], up: ["x"] })
    expect(patch).toContain("@@ -1,3 +0,0 @@")
  })

  test("down block indents every line of a multi-line statement", () => {
    const diff: Diff = { down: [MULTI], items: [item("add")], up: ["x"] }
    const out = formatDiff(diff, { down: true })
    const tail = out.split("rollback (down):")[1].split("\n").filter(Boolean)
    expect(tail).toHaveLength(MAGIC_3)
    tail.forEach((l) => {
      expect(l).toStartWith("  ")
    })
  })
})
