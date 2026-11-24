const MAGIC_300 = 300
// Fuzzing for the core CLI kind-filter — arbitrary flag values and name lists, asserting it
// never throws and always yields a well-formed `Filter`. (The property suite covers the token/`inCat`
// semantics; this focuses on scale and odd input.)
import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { parseFilter } from "../../../src/core/cli-kit/filter"

const RUNS = Number(process.env.FUZZ_RUNS ?? process.env.PBT_RUNS ?? MAGIC_300)
const SEED = process.env.PBT_SEED ? Number(process.env.PBT_SEED) : undefined
const check = (prop: fc.IProperty<unknown>): void => {
  fc.assert(prop, {
    numRuns: RUNS,
    ...(SEED === undefined ? {} : { seed: SEED }),
  })
}

const flagValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(true),
  fc.constant(false),
  fc.string(),
)

const isCat = (c: unknown): boolean =>
  !!c &&
  typeof (c as { on?: unknown }).on === "boolean" &&
  ((c as { names?: unknown }).names === undefined ||
    (c as { names?: unknown }).names instanceof Set)

describe("fuzz: parseFilter", () => {
  test("never throws and returns a well-formed Filter for arbitrary flags", () => {
    check(
      fc.property(flagValue, flagValue, flagValue, flagValue, (t, f, e, a) => {
        const parsed = parseFilter({
          access: a,
          events: e,
          functions: f,
          tables: t,
        })
        expect(isCat(parsed.tables)).toBe(true)
        expect(isCat(parsed.functions)).toBe(true)
        expect(isCat(parsed.events)).toBe(true)
        expect(isCat(parsed.access)).toBe(true)
      }),
    )
  })

  test("a huge comma list reduces to its exact token set", () => {
    check(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9_]{1,8}$/u), {
          maxLength: 200,
          minLength: 1,
        }),
        (tokens) => {
          const parsed = parseFilter({ tables: tokens.join(",") })
          expect([...(parsed.tables.names ?? [])].sort()).toEqual([...new Set(tokens)].sort())
        },
      ),
    )
  })

  test("arbitrary strings (with quotes/brackets/unicode) don't crash the splitter", () => {
    check(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        const parsed = parseFilter({ events: text })
        expect(isCat(parsed.events)).toBe(true)
      }),
    )
  })
})
