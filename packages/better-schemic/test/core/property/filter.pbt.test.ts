const MAGIC_100 = 100
// Property-based tests for the core CLI kind-filter — the pure parser that turns `--tables [names]` /
// `--no-tables` flags into a `Filter`. The invariants: the parse is deterministic, defaults match the
// documented policy (access opt-in), a comma/space list splits into its non-empty tokens, and
// `inCat` matches its decision (`on && (!names || names.has(name))`).
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { inCat, parseFilter } from "../../../src/core/cli-kit/filter"

const RUNS = Number(process.env.PBT_RUNS ?? MAGIC_100)
const SEED = process.env.PBT_SEED ? Number(process.env.PBT_SEED) : undefined
const check = (prop: fc.IProperty<unknown>): void => {
  fc.assert(prop, {
    numRuns: RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
  })
}

/** A `--tables [names]` flag value: `undefined` / booleans (from `--no-*`) / a comma list. */
const flagValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(true),
  fc.constant(false),
  fc.array(fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/u), { maxLength: 4 }).map((xs) => xs.join(",")),
  fc.string(),
)

describe("parseFilter — pure flag parser", () => {
  test("defaults: tables/functions/events on, access OFF (opt-in)", () => {
    const f = parseFilter({})
    ;(["tables", "functions", "events"] as const).forEach((cat) => {
      expect(f[cat].on).toBe(true)
      expect(f[cat].names).toBeUndefined()
    })
    expect(f.access.on).toBe(false)
  })

  test("a comma list yields exactly its non-empty trimmed tokens", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/u)
    check(
      fc.property(fc.array(token, { maxLength: 5, minLength: 1 }), (tokens) => {
        const joined = tokens.join(",")
        const parsed = parseFilter({ tables: joined })
        expect([...(parsed.tables.names ?? [])].sort()).toEqual([...new Set(tokens)].sort())
        expect(parsed.tables.on).toBe(true)
      }),
    )
  })

  test("a names list with blanks/whitespace still splits to its tokens", () => {
    const token = fc.stringMatching(/^[A-Za-z0-9_]{1,6}$/u)
    check(
      fc.property(
        fc.array(fc.oneof(token, fc.constant(""), fc.constant("  ")), {
          maxLength: 6,
          minLength: 1,
        }),
        (tokens) => {
          const parsed = parseFilter({ functions: tokens.join(",") })
          const expected = [
            ...new Set(tokens.map((t) => t.trim()).filter((t) => t.length > 0)),
          ].sort()
          expect([...(parsed.functions.names ?? [])].sort()).toEqual(expected)
        },
      ),
    )
  })

  test("`false` turns a category off; `true`/undefined keeps its default", () => {
    check(
      fc.property(
        flagValue,
        fc.constantFrom("tables", "functions", "events", "access" as const),
        (value, cat) => {
          const parsed = parseFilter({ [cat]: value })
          const defaultOn = cat !== "access"
          if (value === false) expect(parsed[cat].on).toBe(false)
          else if (value === undefined) expect(parsed[cat].on).toBe(defaultOn)
          else expect(parsed[cat].on).toBe(true)
        },
      ),
    )
  })

  test("parsing is deterministic and never throws on arbitrary flag values", () => {
    check(
      fc.property(flagValue, flagValue, flagValue, flagValue, (t, f, e, a) => {
        const once = parseFilter({
          access: a,
          events: e,
          functions: f,
          tables: t,
        })
        const twice = parseFilter({
          access: a,
          events: e,
          functions: f,
          tables: t,
        })
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
      }),
    )
  })
})

describe("inCat — category gate", () => {
  test("matches `on && (!names || names.has(name))`", () => {
    const cat = fc.record({
      names: fc.option(fc.uniqueArray(fc.string(), { maxLength: 4 }), {
        nil: undefined,
      }),
      on: fc.boolean(),
    })
    check(
      fc.property(cat, fc.string(), ({ names, on }, name) => {
        const expected = on && (!names || names.includes(name))
        // Build the Set form the API expects.
        const c = { on, ...(names ? { names: new Set(names) } : {}) }
        // `inCat` types it on the internal `Cat`; the shape is `{ on, names? }`.
        expect(inCat(c as never, name)).toBe(expected)
      }),
    )
  })
})
