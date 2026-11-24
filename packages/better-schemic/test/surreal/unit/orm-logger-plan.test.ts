const MAGIC_1000000 = 1_000_000
const MAGIC_1500000000 = 1_500_000_000

const MAGIC_1500 = 1500
const MAGIC_2 = 2
const MAGIC_42 = 42
const MAGIC_500 = 500
const MAGIC_9787 = 9787
// The EXPLAIN plan renderer: the three live-probed plan shapes (structured object, indented string,
// legacy array), the operator badges and the nanosecond humanizer. Offline (pure).
import { describe, expect, test } from "bun:test"

import { createPalette } from "../../../src/surreal/orm/logger/colors"
import { humanizeNs, planToNodes, renderPlan } from "../../../src/surreal/orm/logger/plan"

const plain = createPalette(false)
const lines = (plan: unknown): string[] => renderPlan(plan, plain)
const text = (plan: unknown): string => lines(plan).join("\n")

describe("humanizeNs", () => {
  test("scales ns → µs → ms → s", () => {
    expect(humanizeNs(MAGIC_500)).toBe("500ns")
    expect(humanizeNs(MAGIC_1500)).toBe("1.5µs")
    expect(humanizeNs(MAGIC_1000000)).toBe("1ms")
    expect(humanizeNs(MAGIC_9787)).toBe("9.79µs")
    expect(humanizeNs(MAGIC_1500000000)).toBe("1.5s")
    expect(humanizeNs(Number.POSITIVE_INFINITY)).toBe("Infinity")
  })
})

describe("planToNodes — structured object", () => {
  const plan = {
    attributes: { projections: "*" },
    children: [
      {
        attributes: { direction: "Forward", table: "person" },
        context: "Db",
        metrics: { elapsed_ns: 64_069, output_batches: 1, output_rows: 1 },
        operator: "TableScan",
      },
    ],
    context: "Db",
    metrics: { elapsed_ns: 9787, output_batches: 1, output_rows: 1 },
    operator: "SelectProject",
    total_rows: 1,
  }

  test("builds the operator tree with attrs, metrics and a scan badge", () => {
    const nodes = planToNodes(plan)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.label).toBe("SelectProject")
    expect(nodes[0]?.attrs).toBe("ctx: Db, projections: *")
    expect(nodes[0]?.metrics).toBe("rows 1 · batches 1 · elapsed 9.79µs · total rows 1")
    expect(nodes[0]?.badge).toBeUndefined()
    const child = nodes[0]?.children[0]
    expect(child.label).toBe("TableScan")
    expect(child.badge).toBe("⚠ full scan")
    expect(child.metrics).toContain("elapsed 64.07µs")
  })

  test("renders with box connectors and the badge", () => {
    const out = text(plan)
    expect(out).toContain("SelectProject [ctx: Db, projections: *]")
    expect(out).toContain("└─ TableScan")
    expect(out).toContain("⚠ full scan")
  })

  test("multiple children use ├─ / └─ and indent grandchildren", () => {
    const out = lines({
      children: [{ children: [{ operator: "A1" }], operator: "A" }, { operator: "B" }],
      operator: "Root",
    })
    expect(out).toEqual(["Root", "├─ A", "│  └─ A1", "└─ B"])
  })

  test("index operators get the ✓ badge", () => {
    ;["IndexScan", "IndexCountScan", "KnnScan", "FullTextScan", "IterateIndex"].forEach((op) => {
      expect(planToNodes({ operator: op })[0]?.badge).toBe("✓ index")
    })
  })

  test("an object without an operator falls back to JSON", () => {
    expect(planToNodes({ foo: 1 })[0]?.label).toBe('{"foo":1}')
  })

  test("a child that is not an operator object is dropped", () => {
    const nodes = planToNodes({
      children: [1, { operator: "Y" }],
      operator: "X",
    })
    expect(nodes[0]?.children.map((c) => c.label)).toEqual(["Y"])
  })
})

describe("planToNodes — indented string", () => {
  const textPlan = [
    "SelectProject [ctx: Db] [projections: *]",
    "    TableScan [ctx: Db] [table: person, direction: Forward, predicate: email = 'x']",
    "",
    "Total rows: 1",
  ].join("\n")

  test("parses the tree and attaches the trailing total to the root", () => {
    const nodes = planToNodes(textPlan)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.label).toBe("SelectProject")
    expect(nodes[0]?.attrs).toBe("ctx: Db, projections: *")
    expect(nodes[0]?.metrics).toBe("total rows 1")
    const child = nodes[0]?.children[0]
    expect(child.label).toBe("TableScan")
    expect(child.attrs).toContain("table: person")
    expect(child.badge).toBe("⚠ full scan")
  })

  test("parses embedded metrics `{rows: 1, batches: 1, elapsed: x}`", () => {
    const nodes = planToNodes("SelectProject [ctx: Db] {rows: 1, batches: 1, elapsed: 7.83µs}")
    expect(nodes[0]?.metrics).toBe("rows: 1, batches: 1, elapsed: 7.83µs")
  })

  test("a single line with no indentation is one node", () => {
    expect(planToNodes("OnlyOp [ctx: Db]").map((n) => n.label)).toEqual(["OnlyOp"])
  })

  test("an all-blank string renders a single label row", () => {
    const nodes = planToNodes("\n   \n")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.label).toBe("")
  })
})

describe("planToNodes — legacy array + fallbacks", () => {
  test("legacy `{ operation, detail }` rows carry their detail as attrs", () => {
    const nodes = planToNodes([
      { detail: { table: "person" }, operation: "Iterate Table" },
      { detail: { type: "Memory" }, operation: "Collector" },
    ])
    expect(nodes.map((n) => n.label)).toEqual(["Iterate Table", "Collector"])
    expect(nodes[0]?.attrs).toBe("table: person")
  })

  test("an array mixing operator objects is normalized", () => {
    const nodes = planToNodes([{ operator: "A" }, { nope: true }])
    expect(nodes.map((n) => n.label)).toEqual(["A"])
  })

  test("scalar / non-object plans stringify", () => {
    expect(planToNodes(MAGIC_42)[0]?.label).toBe("42")
    expect(planToNodes([1, MAGIC_2])[0]?.label).toBe("[1,2]")
  })

  test("null/undefined render a placeholder", () => {
    expect(lines(null)).toEqual(["(no plan)"])
    expect(lines(undefined)).toEqual(["(no plan)"])
  })

  test("an unserializable value does not throw", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => renderPlan(circular, plain)).not.toThrow()
  })
})

describe("planToNodes — string-tree edge cases", () => {
  test("a shallower sibling pops the deeper stack", () => {
    const nodes = planToNodes(["Root", "    A", "        A1", "    B", "        B1"].join("\n"))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.children.map((c) => c.label)).toEqual(["A", "B"])
    expect(nodes[0]?.children[0]?.children.map((c) => c.label)).toEqual(["A1"])
    expect(nodes[0]?.children[1]?.children.map((c) => c.label)).toEqual(["B1"])
  })

  test("a `Total rows` line with no root is ignored", () => {
    expect(planToNodes("Total rows: 3")).toEqual([{ children: [], label: "Total rows: 3" }])
  })

  test("a line that starts with a bracket keeps the whole text as the label", () => {
    expect(planToNodes("[weird]")[0]?.label).toBe("[weird]")
  })

  test("a legacy entry with no detail has no attrs", () => {
    const nodes = planToNodes([{ operation: "Collector" }])
    expect(nodes[0]?.label).toBe("Collector")
    expect(nodes[0]?.attrs).toBeUndefined()
  })

  test("objects with bad metrics/attrs degrade quietly", () => {
    const nodes = planToNodes({
      attributes: null,
      children: [null],
      context: "",
      metrics: "nope",
      operator: "X",
    })
    expect(nodes[0]?.label).toBe("X")
    expect(nodes[0]?.attrs).toBeUndefined()
    expect(nodes[0]?.metrics).toBeUndefined()
    expect(nodes[0]?.children).toEqual([])
  })

  test("attaches trailing metrics when the root already has metrics", () => {
    const nodes = planToNodes("SelectProject [ctx: Db] {rows: 1}\nTotal rows: 1")
    expect(nodes[0]?.metrics).toBe("rows: 1 · total rows 1")
  })

  test("scalar attribute values and empty bracket groups are rendered", () => {
    const nodes = planToNodes("Op [] [n: 3]")
    expect(nodes[0]?.label).toBe("Op")
    // `[]` contributes an empty (filtered) group; `[n: 3]` the attrs.
    expect(nodes[0]?.attrs).toContain("n:")
  })

  test("a legacy array entry without a detail object has no attrs", () => {
    expect(planToNodes([{ detail: 7, operation: "Op" }])[0]?.attrs).toBeUndefined()
  })

  test("scalar attribute values, non-object attributes and function plans", () => {
    expect(planToNodes({ attributes: { n: 3 }, operator: "X" })[0]?.attrs).toBe("n: 3")
    expect(
      planToNodes({ attributes: "nope", context: "", operator: "Y" })[0]?.attrs,
    ).toBeUndefined()
    expect(
      planToNodes(() => {
        /* empty */
      })[0]?.label,
    ).toContain("=>")
  })
})
