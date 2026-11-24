import { describe, expect, test } from "bun:test"
import { Decimal, RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { adjustmentOf, stripAdjustments } from "../../../src/surreal/orm/arithmetic"
import {
  type ArithmeticStep,
  extractArithmetic,
  setBody,
} from "../../../src/surreal/orm/compiler/adjustment"
import { createBinds } from "../../../src/surreal/orm/compiler/shared"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { required } from "../../required"
const body2 = (data: unknown): string => {
  const { clean, steps } = extractArithmetic(meta, data, "update", true)
  return setBody(clean, steps, createBinds(), false)
}

const MAGIC_1n = 1n
const MAGIC_10 = 10
const MAGIC_7 = 7
// The CHANGE layer's decision tables — one exhaustive case list per guard, so a marker, an
// operand, a target column or a payload shape that falls on the wrong side of a rule fails here
// rather than in production. Offline; the compiler drivs it directly.

const Holder = table("adj", {
  blob: s.bytes(),
  flag: s.boolean(),
  meta: s.object({ a: s.string() }),
  name: s.string(),
  numbers: s.array(s.int()),
  owner: s.recordId("other"),
  price: s.decimal(),
  ratio: s.float(),
  score: s.int(),
  seats: s.set(s.string()),
  tags: s.array(s.string()),
  when: s.datetime(),
})

const meta = required(buildSchemaIndex({ t: Holder }).tables.get("t"))

/** Compile one write payload; `error` is the teaching message when refused. */
function split(
  data: unknown,
  allow = true,
): { clean: unknown; error: string; steps: readonly ArithmeticStep[] } {
  try {
    return { ...extractArithmetic(meta, data, "update", allow), error: "" }
  } catch (error) {
    return {
      clean: undefined,
      error: (error as Error).message,
      steps: [] as readonly never[],
    }
  }
}

describe("adjustment — payload shape", () => {
  test("a payload with no marker passes through untouched, with NO steps", () => {
    const out = split({ name: "a", score: 1 })
    expect(out.error).toBe("")
    expect(out.clean).toEqual({ name: "a", score: 1 })
    expect(out.steps).toEqual([])
  })

  test("a NON-object payload is returned as-is (nothing to inspect)", () => {
    ;[undefined, null, MAGIC_7, "x", true].forEach((payload) => {
      const out = split(payload)
      expect(out.error).toBe("")
      expect(out.clean).toBe(payload)
      expect(out.steps).toEqual([])
    })
  })

  test("an object with an UNKNOWN marker key is a plain value", () => {
    const out = split({ name: "a", score: { nope: "x" } })
    expect(out.error).toBe("")
    expect(out.clean).toEqual({ name: "a", score: { nope: "x" } })
    expect(out.steps).toEqual([])
  })

  test("`allow: false` (a create-shaped write) refuses every marker", () => {
    expect(split({ score: { increment: 1 } }, false).error).toMatch(/EXISTING value/u)
    expect(split({ tags: { append: "x" } }, false).error).toMatch(/EXISTING value/u)
  })
})

describe("adjustment — the target field", () => {
  test("`id` is refused: it is the record identity", () => {
    expect(split({ id: { increment: 1 } }).error).toMatch(/"id" can't be adjusted/u)
  })

  test("an unknown field names the ones that exist", () => {
    const out = split({ nope: { increment: 1 } })
    expect(out.error).toContain('"nope" is not a field of "adj"')
    expect(out.error).toContain("score")
  })

  test("a schemaless entry adjusts anything (no columns to judge)", () => {
    const loose = buildSchemaIndex({ t: "t" }).schemaless.get("t") as never
    const { steps } = extractArithmetic(loose, { anything: { increment: 1 } }, "update", true)
    expect(steps).toHaveLength(1)
  })

  test("the numeric markers accept every numeric family and refuse the rest", () => {
    ;["score", "price", "ratio"].forEach((field) => {
      const out = split({ [field]: { increment: 1 } })
      expect(out.error).toBe("")
      expect(out.steps[0]?.op).toBe("+=")
    })
    ;["name", "tags", "when", "blob", "flag", "meta", "owner"].forEach((field) => {
      expect(split({ [field]: { increment: 1 } }).error).toMatch(/needs a numeric field/u)
    })
  })

  test("the array markers accept array AND set, and refuse the rest", () => {
    ;["tags", "numbers", "seats"].forEach((field) => {
      ;[
        { append: "x" },
        { remove: "x" },
        { union: ["x"] },
        { at: { index: 0, value: "x" } },
      ].forEach((marker) => {
        const out = split({ [field]: marker })
        expect(out.error).toBe("")
      })
    })
    ;["score", "name"].forEach((field) => {
      expect(split({ [field]: { append: "x" } }).error).toMatch(/adjusts an array field/u)
    })
  })

  test("a bare record link is not an array either", () => {
    expect(split({ owner: { append: "x" } }).error).toMatch(/adjusts an array field/u)
  })
})

describe("adjustment — the operand", () => {
  test("numeric: number, bigint, Decimal and a fragment pass", () => {
    ;[1, MAGIC_1n, new Decimal(1), surql`1`].forEach((operand) => {
      expect(split({ score: { increment: operand } }).error).toBe("")
    })
  })

  test("numeric: a string, bool, null and a function are refused", () => {
    ;["1", true, null, (): number => 1, [1]].forEach((operand) => {
      expect(split({ score: { increment: operand } }).error).toMatch(
        /needs a number, bigint, Decimal or expression/u,
      )
    })
  })

  test("array: a scalar, an array, a record and a date all pass", () => {
    ;["x", ["x"], { a: 1 }, new Date(), new RecordId("other", "1"), null].forEach((operand) => {
      expect(split({ tags: { append: operand } }).error).toBe("")
    })
  })

  test("array: only a FUNCTION is refused — the element type is the schema's business", () => {
    expect(split({ tags: { append: () => 1 } }).error).toMatch(/needs a value or an array operand/u)
  })

  test("`at` needs a non-negative integer index and a value", () => {
    expect(split({ tags: { at: { index: 0, value: "x" } } }).error).toBe("")
    ;[{ index: -1, value: "x" }, { index: 1.5, value: "x" }, { index: 0 }, "x", 0].forEach((at) => {
      expect(split({ tags: { at } }).error).not.toBe("")
    })
  })
})

describe("adjustment — the SET clause", () => {
  test("each lowering renders its own operator", () => {
    expect(body2({ score: { increment: 1 } })).toContain("score += $p0")
    expect(body2({ score: { decrement: 1 } })).toContain("score -= $p0")
    expect(body2({ tags: { append: "x" } })).toContain("tags += $p0")
    expect(body2({ tags: { remove: "x" } })).toContain("tags -= $p0")
    expect(body2({ tags: { union: ["x"] } })).toContain("tags = array::union(tags, $p0)")
    expect(body2({ tags: { at: { index: 2, value: "x" } } })).toContain("tags[2] = $p0")
  })

  test("a non-object payload still renders an empty SET (the guard, not a crash)", () => {
    expect(setBody(undefined, [], createBinds(), false)).toBe("SET ")
  })

  test("a DEEP merge flattens a nested object into leaf assignments", () => {
    const { steps } = extractArithmetic(meta, { score: { increment: 1 } }, "update", true)
    const binds = createBinds()
    const body = setBody({ a: { b: 1, c: 2 }, d: 3 }, steps, binds, true)
    expect(body).toContain("a.b = ")
    expect(body).toContain("a.c = ")
    expect(body).toContain("d = ")
    // a deep merge does NOT re-assign the change as a leaf
    expect(body).toContain("score += ")
  })

  test("a SHALLOW `set` keeps the object as one assignment", () => {
    const binds = createBinds()
    const body = setBody({ a: { b: 1 } }, [], binds, false)
    expect(body).toContain("a = ")
    expect(body).not.toContain("a.b = ")
  })

  test("an empty nested object contributes no assignment", () => {
    const binds = createBinds()
    expect(setBody({ a: {} }, [], binds, true)).toBe("SET ")
  })

  test("an undefined value contributes no assignment", () => {
    const binds = createBinds()
    expect(setBody({ a: undefined }, [], binds, false)).toBe("SET ")
  })

  test("no steps at all renders an empty SET rather than a dangling comma", () => {
    expect(setBody({}, [], createBinds(), false)).toBe("SET ")
  })
})
describe("adjustment — the literal-operand type test", () => {
  test("an ARRAY operand is a value; a class instance the server cannot bind is not", () => {
    // Every arm of the type test in turn: array, plain object, Date, RecordId, Decimal…
    expect(split({ tags: { append: ["a"] } }).error).toBe("")
    expect(split({ tags: { append: { a: 1 } } }).error).toBe("")
    expect(split({ tags: { append: new Date() } }).error).toBe("")
    expect(split({ tags: { append: new RecordId("other", "1") } }).error).toBe("")
    expect(split({ tags: { append: new Decimal(1) } }).error).toBe("")
    // …and the arm that IS a rejection: an instance of an unknown class.
    class Opaque {
      constructor(readonly x = 1) {}
    }
    expect(split({ tags: { append: new Opaque() } }).error).toMatch(
      /needs a value or an array operand/u,
    )
  })

  test("a Set (the field family) takes the same operand set as an array", () => {
    ;["a", ["a"], { a: 1 }, new Date()].forEach((operand) => {
      expect(split({ seats: { union: operand } }).error).toBe("")
    })
  })
})

describe("adjustment — the modifiers (when/else/coalesce)", () => {
  test("`when` must be a Surql fragment and is refused on `at`", () => {
    expect(split({ score: { increment: 1, when: surql`score < 10` } }).error).toBe("")
    ;["score < 10", MAGIC_10, true, (): boolean => true].forEach((when) => {
      expect(split({ score: { increment: 1, when } }).error).toMatch(/surql/u)
    })

    expect(split({ tags: { at: { index: 0, value: "x" }, when: surql`true` } }).error).toMatch(
      /can't guard \{ at/u,
    )
  })

  test("`else` requires `when` and a keep/throw/renderable value", () => {
    expect(split({ score: { else: "throw", increment: 1 } }).error).toMatch(/fallback of "when"/u)
    expect(split({ score: { else: () => 1, increment: 1, when: surql`true` } }).error).toMatch(
      /must be "keep", "throw"/u,
    )
    ;["keep", "throw", 0, surql`score`].forEach((else_) => {
      expect(split({ score: { else: else_, increment: 1, when: surql`true` } }).error).toBe("")
    })
  })

  test("`coalesce` is refused on numeric, remove and at", () => {
    expect(split({ score: { coalesce: [], increment: 1 } }).error).toMatch(/NONE \+ n = n/u)
    expect(split({ score: { coalesce: [], decrement: 1 } }).error).toMatch(/NONE \+ n = n/u)
    expect(split({ tags: { coalesce: [], remove: "x" } }).error).toMatch(
      /only \{ union \}\/\{ append \}/u,
    )
    expect(split({ tags: { at: { index: 0, value: "x" }, coalesce: [] } }).error).toMatch(
      /only \{ union \}\/\{ append \}/u,
    )
    expect(split({ tags: { append: "x", coalesce: [] } }).error).toBe("")
    expect(split({ tags: { coalesce: "x", union: ["a"] } }).error).toMatch(/must be an array/u)
    expect(split({ tags: { append: "x", coalesce: () => 1 } }).error).toMatch(/must be a value/u)
    expect(split({ tags: { coalesce: surql`[]`, union: ["a"] } }).error).toBe("")
  })

  test("the complete modifier set compiles", () => {
    expect(
      split({
        tags: {
          coalesce: [],
          else: "throw",
          union: ["a"],
          when: surql`score > 0`,
        },
      }).error,
    ).toBe("")
  })

  test("no modifiers keeps the historical SET text; modifiers are one guarded assignment", () => {
    expect(body2({ tags: { union: ["a"] } })).toBe("SET tags = array::union(tags, $p0)")
    expect(body2({ tags: { coalesce: [], union: ["a"] } })).toBe(
      "SET tags = array::union(tags ?? $p0, $p1)",
    )
    expect(body2({ tags: { append: "x", coalesce: [] } })).toBe("SET tags = (tags ?? $p0) + [$p1]")
    expect(body2({ score: { increment: 1, when: surql`score < 10` } })).toBe(
      "SET score = IF score < 10 THEN score + $p0 ELSE score END",
    )
    expect(body2({ score: { decrement: 1, else: 0, when: surql`score > 0` } })).toBe(
      "SET score = IF score > 0 THEN score - $p0 ELSE $p1 END",
    )
    expect(
      body2({
        tags: {
          coalesce: [],
          else: "throw",
          union: ["a"],
          when: surql`score > 0`,
        },
      }),
    ).toBe(
      'SET tags = IF score > 0 THEN array::union(tags ?? $p0, $p1) ELSE THROW s"adjustment guard failed on tags" END',
    )
  })

  test("the parser recognises modifiers but leaves two markers / modifiers alone as literals", () => {
    const guard = surql`true`
    expect(adjustmentOf({ coalesce: [], else: "keep", increment: 1, when: guard })).toMatchObject({
      kind: "increment",
      value: 1,
      when: guard,
    })
    expect(adjustmentOf({ when: guard })).toBeUndefined()
    expect(adjustmentOf({ decrement: 2, increment: 1, when: guard })).toBeUndefined()
    expect(adjustmentOf({ increment: 1, other: 2 })).toBeUndefined()
    expect(
      stripAdjustments({
        tags: { append: "x", coalesce: [], else: "throw", when: guard },
      }),
    ).toEqual({ tags: "x" })
  })
})
