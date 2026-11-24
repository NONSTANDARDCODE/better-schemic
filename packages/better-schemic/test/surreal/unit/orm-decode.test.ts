import { describe, expect, test } from "bun:test"
import { DateTime, RecordId } from "surrealdb"
import { z } from "zod"

import { surql } from "../../../src/surreal"
import { compileRead, type ReadArgs } from "../../../src/surreal/orm/compiler/select"
import { createBinds } from "../../../src/surreal/orm/compiler/shared"
import { decodeRow, decodeRows } from "../../../src/surreal/orm/decode"
import type { OrmError } from "../../../src/surreal/orm/errors"
import type { ModelMeta } from "../../../src/surreal/orm/meta"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"
import { s, table } from "../../../src/surreal/pure"
import { required } from "../../required"

const MAGIC_1103515245 = 1_103_515_245
const MAGIC_12345 = 12_345
const MAGIC_2147483647 = 2_147_483_647
const MAGIC_0p7 = 0.7

const MAGIC_1p5 = 1.5
const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_31 = 31
const MAGIC_500 = 500
// Decoder unit tests — `decodeRow`/`decodeRows` against the `ProjectionSpec` the compiler emits.
// The delegate tests exercise compile+execute+decode together; this suite pins the decode contract
// itself: codecs, star/omit, explicit paths (nested/implicit-array/index), value, split and failures.

const User = table("user", {
  address: s.object({ city: s.string(), country: s.string() }),
  age: s.int(),
  at: s.datetime(),
  contacts: s.array(s.object({ type: s.string(), value: s.string() })),
  name: s.string(),
  tags: s.array(s.string()),
})
const index = buildSchemaIndex({ users: User })
const meta = required(index.tables.get("users"))

/** Compile the read and decode `rows` through its projection. */
function decode(args: ReadArgs, rows: unknown[], table: ModelMeta = meta): unknown[] {
  const binds = createBinds()
  const compiled = compileRead(table, args, binds, "test")
  return decodeRows(rows, table, compiled.projection)
}

const rawAt = (iso: string): DateTime => new DateTime(new Date(iso))
const fullRow = (
  over: Record<string, unknown> = {},
): {
  address: { city: string; country: string }
  age: number
  at: DateTime
  contacts: { type: string; value: string }[]
  id: RecordId<"user", string>
  name: string
  tags: string[]
} => ({
  address: { city: "SP", country: "BR" },
  age: 30,
  at: rawAt("2025-01-02T03:04:05Z"),
  contacts: [{ type: "email", value: "a@x" }],
  id: new RecordId("user", "u1"),
  name: "Alice",
  tags: ["db"],
  ...over,
})

// A primitives-table (fast primitives + an array of primitives) — the compiled full-row
// decoder's happy path, where Zod skipps it entirely.
const Plain = table("plain", {
  count: s.int(),
  name: s.string(),
  note: s.string().optional(),
  ok: s.boolean(),
  ratio: s.number(),
  strictTags: s.array(s.string()).min(1).optional(),
  tags: s.array(s.string()),
})
const plainMeta = required(buildSchemaIndex({ plain: Plain }).tables.get("plain"))
const plainRow = (
  over: Record<string, unknown> = {},
): {
  count: number
  id: RecordId<"plain", string>
  name: string
  ok: boolean
  ratio: number
  tags: string[]
} => ({
  count: 2,
  id: new RecordId("plain", "p1"),
  name: "n",
  ok: true,
  ratio: 1.5,
  tags: ["a", "b"],
  ...over,
})

describe("decode — compiled fast path (full rows)", () => {
  test("primitives + primitive arrays decode, unknown keys strip (Zod parity)", () => {
    const [row] = decode({}, [plainRow({ extra: "x" })], plainMeta) as Record<string, unknown>[]
    expect(row).toEqual({
      count: 2,
      id: new RecordId("plain", "p1"),
      name: "n",
      ok: true,
      ratio: 1.5,
      tags: ["a", "b"],
    })
    // A fresh array (Zod never aliases the input array).
    expect(row.tags).not.toBe(plainRow().tags)
  })

  test("an absent optional is dropped; an explicit undefined is kept", () => {
    const [absent] = decode({}, [plainRow()], plainMeta) as Record<string, unknown>[]
    expect(Object.hasOwn(absent, "note")).toBe(false)
    const [explicit] = decode({}, [plainRow({ note: undefined })], plainMeta) as Record<
      string,
      unknown
    >[]
    expect(Object.hasOwn(explicit, "note")).toBe(true)
    expect(explicit.note).toBeUndefined()
  })

  test("a mismatch falls back to Zod — same ValidationError with the field path", () => {
    ;[
      { count: "x" },
      { count: 1.5 },
      { ok: 1 },
      { tags: ["a", MAGIC_2] },
      { tags: "not-array" },
      { ratio: Number.POSITIVE_INFINITY },
      { ratio: Number.NaN },
    ].forEach((bad) => {
      const err = ((): OrmError | undefined => {
        try {
          decode({}, [plainRow(bad)], plainMeta)
          return undefined
        } catch (error) {
          return error as OrmError
        }
      })()
      expect(err?.code).toBe("ValidationError")
      expect(err?.message).toMatch(/Validation failed at "/u)
    })
  })

  test("a missing required fast field still throws (Zod parity)", () => {
    const err = ((): OrmError | undefined => {
      try {
        decode({}, [{ id: new RecordId("plain", "p1"), name: "n" }], plainMeta)
        return undefined
      } catch (error) {
        return error as OrmError
      }
    })()
    expect(err?.code).toBe("ValidationError")
  })

  test("array-level checks stay in Zod (an empty min-array still throws)", () => {
    const err = ((): OrmError | undefined => {
      try {
        decode({}, [plainRow({ strictTags: [] })], plainMeta)
        return undefined
      } catch (error) {
        return error as OrmError
      }
    })()
    expect(err?.code).toBe("ValidationError")
  })

  test("projected fast leaves decode without Zod and reject mismatches", () => {
    expect(decode({ select: { count: true, tags: true } }, [plainRow()], plainMeta)).toEqual([
      { count: 2, tags: ["a", "b"] },
    ])
    expect(() =>
      decode({ select: { count: true } }, [plainRow({ count: "x" })], plainMeta),
    ).toThrow(/Validation failed/u)
  })

  test("compiled full-row decode matches pure Zod on random rows (parity fuzz)", () => {
    const values: unknown[] = [
      undefined,
      null,
      "s",
      MAGIC_3,
      MAGIC_1p5,
      true,
      [],
      ["a"],
      ["a", MAGIC_2],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { city: "x" },
    ]
    let seed = 7
    const rnd = (): number => {
      seed = (seed * MAGIC_1103515245 + MAGIC_12345) & MAGIC_2147483647
      return seed / MAGIC_2147483647
    }
    const keys = ["name", "count", "ratio", "ok", "note", "tags", "strictTags", "extra"]
    Array.from({ length: MAGIC_500 }).forEach(() => {
      const row: Record<string, unknown> = { id: new RecordId("plain", "p1") }
      keys.forEach((key) => {
        if (rnd() < MAGIC_0p7) row[key] = values[Math.floor(rnd() * values.length)]
      })
      let expected: unknown
      let actual: unknown
      let expectedError = false
      let actualError = false
      try {
        expected = z.decode(Plain.object, row as never)
      } catch {
        expectedError = true
      }
      try {
        actual = decodeRow(row, plainMeta, {
          fields: [],
          includes: [],
          omit: [],
          star: true,
          value: false,
        })
      } catch {
        actualError = true
      }
      expect(actualError).toBe(expectedError)
      if (!expectedError && !actualError) {
        expect(Object.keys(actual as Record<string, unknown>)).toEqual(
          Object.keys(expected as Record<string, unknown>),
        )
        expect(actual).toEqual(expected)
      }
    })
  })
})

describe("decode — full rows", () => {
  test("decodes through the table codec (datetime -> Date, id -> RecordId)", () => {
    const [row] = decode({}, [fullRow()]) as {
      at: Date
      id: RecordId
      name: string
    }[]
    expect(row.id).toBeInstanceOf(RecordId)
    expect(row.at).toBeInstanceOf(Date)
    expect(row.at.toISOString()).toBe("2025-01-02T03:04:05.000Z")
  })

  test("omit strips the keys even when the raw row carries them", () => {
    const [row] = decode({ omit: ["age", "at"] }, [fullRow()]) as Record<string, unknown>[]
    expect(Object.keys(row)).not.toContain("age")
    expect(Object.keys(row)).not.toContain("at")
    expect(row.name).toBe("Alice")
    expect(row.tags).toEqual(["db"])
  })

  test("star + explicit expression overlays the decoded row", () => {
    const [row] = decode({ select: { "*": true, bump: surql`age + ${1}` } }, [
      fullRow({ bump: 31 }),
    ]) as Record<string, unknown>[]
    expect(row.name).toBe("Alice")
    expect(row.at).toBeInstanceOf(Date)
    expect(row.bump).toBe(MAGIC_31)
  })
})

describe("decode — explicit projections", () => {
  test("paths nest, aliases flatten and arrays decode element-wise", () => {
    expect(
      decode(
        {
          select: {
            "address.city": true,
            city: "address.city",
            "contacts.type": true,
            "contacts[*].type": true,
            "tags[0]": true,
          },
        },
        [
          {
            address: { city: "SP" },
            city: "SP",
            contacts: { type: ["email", "phone"] },
            tags: "db",
          },
        ],
      ),
    ).toEqual([
      {
        address: { city: "SP" },
        city: "SP",
        contacts: { type: ["email", "phone"] },
        tags: "db",
      },
    ])
  })

  test("a projected field missing from the raw row stays undefined", () => {
    expect(decode({ select: { age: true, name: true } }, [{ name: "A" }])).toEqual([
      { age: undefined, name: "A" },
    ])
  })

  test("schemaless models pass values through", () => {
    const schemaless = {
      key: "audit",
      name: "audit_log",
      schemaless: true as const,
    }
    expect(
      decode(
        { select: { "meta.at": true, who: true } },
        [{ meta: { at: 1 }, who: "u1" }],
        schemaless,
      ),
    ).toEqual([{ meta: { at: 1 }, who: "u1" }])
  })
})

describe("decode — value and split", () => {
  test("value returns the leaf directly (decoded)", () => {
    expect(decode({ select: { at: true }, value: true }, [rawAt("2025-03-01T00:00:00Z")])).toEqual([
      new Date("2025-03-01T00:00:00Z"),
    ])
  })

  test("split unfolds the field to its ELEMENT codec", () => {
    const [row] = decode({ split: "tags" }, [fullRow({ tags: "db" })]) as Record<string, unknown>[]
    expect(row.tags).toBe("db")
  })

  test("a nested split needs an explicit select", () => {
    expect(() => decode({ split: "address.city" }, [fullRow()])).toThrow(/nested path/u)
  })
})

describe("decode — failures are teaching errors", () => {
  test("a codec mismatch names the table and field", () => {
    const err = ((): OrmError | undefined => {
      try {
        decode({ select: { at: true } }, [{ at: "not-a-datetime" }])
        return undefined
      } catch (error) {
        return error as OrmError
      }
    })()
    expect(err?.code).toBe("ValidationError")
    expect(err?.table).toBe("user")
    expect(err?.field).toBe("at")
  })

  test("decodeRow is the single-row entry point", () => {
    expect(
      decodeRow(fullRow(), meta, {
        fields: [],
        includes: [],
        omit: [],
        star: true,
        value: false,
      }),
    ).toMatchObject({ name: "Alice" })
  })
})
