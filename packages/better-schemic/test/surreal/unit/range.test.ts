import { describe, expect, test } from "bun:test"

import { isRange, Range, range, surql } from "../../../src/surreal"
import { block } from "../../../src/surreal/query"
import { lowerExpr, mkRef } from "../../../src/surreal/surql/predicate"
import type { Ctx } from "../../../src/surreal/surql/render"

const MAGIC_2 = 2
const MAGIC_2020 = 2020
const MAGIC_42 = 42
// SurrealQL RANGES (`1..=10`) as a first-class VALUE: the `range()` builder's bound spelling, its
// lowering (bounds BIND as params), and its uses — `IN` membership and `FOR` iteration.
// Grammar verified on live 3.1.4: `>` after the start excludes it, `=` before the end includes it.
//
// (M0.5: the fluent `select()` builder retirs it; these tests lower the same predicates through
// the ref/Expr layer directly.)

/** The lowered `WHERE` of a range predicate — the interesting half. */
const whereOf = (
  r: ReturnType<typeof range<number>>,
): { sql: string; vars: Record<string, unknown> } => {
  const ctx: Ctx = { vars: {} }
  const ref = mkRef({ kind: "number", root: { col: "age" } })
  return { sql: lowerExpr(ref.in(r), ctx), vars: ctx.vars }
}

describe("range() — bound spelling", () => {
  test("from/to INCLUDE their bound; after/until EXCLUDE it", () => {
    // The four combinations SurrealQL spells `a..b` / `a..=b` / `a>..b` / `a>..=b`.
    expect(whereOf(range({ from: 1, to: 10 })).sql).toContain("IN $b0..=$b1")
    expect(whereOf(range({ from: 1, until: 10 })).sql).toContain("IN $b0..$b1")
    expect(whereOf(range({ after: 0, to: 10 })).sql).toContain("IN $b0>..=$b1")
    expect(whereOf(range({ after: 0, until: 11 })).sql).toContain("IN $b0>..$b1")
  })

  test("either end may be OPEN", () => {
    expect(whereOf(range({ from: 18 })).sql).toContain("IN $b0..")
    expect(whereOf(range({ to: 65 })).sql).toContain("IN ..=$b0")
    expect(whereOf(range({ until: 65 })).sql).toContain("IN ..$b0")
  })

  test("bounds BIND as params (they are values, not SQL text)", () => {
    const { sql, vars } = whereOf(range({ from: 18, to: 65 }))
    expect(sql).toBe("age IN $b0..=$b1")
    expect(vars).toEqual({ b0: 18, b1: 65 })
  })

  test("mixing the two spellings of one end is a runtime error too (untyped callers)", () => {
    expect(() => range({ after: 2, from: 1 } as never)).toThrow(
      /`from` \(start included\) OR `after` \(start excluded\)/u,
    )
    expect(() => range({ to: 1, until: 2 } as never)).toThrow(
      /`to` \(end included\) OR `until` \(end excluded\)/u,
    )
  })

  test("a range with NO bound is meaningless", () => {
    expect(() => range({})).toThrow(/needs at least one bound/u)
  })

  test("isRange() brands cross-realm; range() builds a Range", () => {
    expect(isRange(range({ from: 1, to: 2 }))).toBe(true)
    expect(range({ from: 1, to: 2 })).toBeInstanceOf(Range)
    expect(isRange(MAGIC_42)).toBe(false)
    expect(isRange([1, MAGIC_2])).toBe(false)
    expect(isRange(null)).toBe(false)
  })
})

describe("range() — uses", () => {
  test("IN / NOT IN test membership, alongside the list form", () => {
    const ctx: Ctx = { vars: {} }
    const ref = mkRef({ kind: "number", root: { col: "age" } })
    expect(lowerExpr(ref.notIn(range({ from: 18, to: 65 })), ctx)).toBe("age NOT IN $b0..=$b1")
    // the list form untouchs it
    expect(lowerExpr(ref.in([1, MAGIC_2]), ctx)).toMatch(/^age IN \$b\d+$/u)
  })

  test("string bounds range over strings ('g' IN 'a'..'z')", () => {
    const ctx: Ctx = { vars: {} }
    const ref = mkRef({ kind: "string", root: { col: "name" } })
    const sql = lowerExpr(ref.in(range({ from: "a", until: "z" })), ctx)
    expect(sql).toBe("name IN $b0..$b1")
    expect(ctx.vars).toEqual({ b0: "a", b1: "z" })
  })

  test("FOR iterates a range; the loop var carries the bound's type", () => {
    const { query } = block()
      .for({ y: range({ from: 2020, to: 2022 }) }, () => surql`CREATE ev SET year = $y`)
      .toQuery()
    expect(query).toMatch(/FOR \$y IN \$\w+\.\.=\$\w+ \{ CREATE ev SET year = \$y \}/u)
  })

  test("a range DENOTES its span, so the loop var is number (not the literal bounds)", () => {
    // Guards the `const T` trap: `Range<2020 | 2022>` would type `$y` as `2020 | 2022` and
    // omit 2021 — the loop does yield it.
    block().for({ y: range({ from: 2020, to: 2022 }) }, (v) => {
      const _numeric: unknown = v.y.gt(MAGIC_2020) // number stdlib is reachable
      const _probe_99 = _numeric
      return surql`RETURN 1`
    })
    expect(true).toBe(true)
  })
})
