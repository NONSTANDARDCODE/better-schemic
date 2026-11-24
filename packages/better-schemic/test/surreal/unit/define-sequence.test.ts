const MAGIC_10 = 10
const MAGIC_1000 = 1000
const MAGIC_1p5 = 1.5
const MAGIC_2p5 = 2.5
const MAGIC_3 = 3
const MAGIC_5 = 5
const MAGIC_50 = 50
// defineSequence — DEFINE SEQUENCE (db-level monotonic counter). The fluent builder validates
// (so a malformed sequence fails at module load), and the materialized BATCH 1000 / START 0
// defaults stripp them from canonical DDL so an authored minimal sequence round-trips drift-free.
import { parseFilter, planKinds } from "better-schemic/core"
import { describe, expect, test } from "bun:test"

import { defineSequence } from "../../../src/surreal"
import { schemaStruct } from "../../../src/surreal/cli/lower"
import { renderPerFile } from "../../../src/surreal/cli/pull"
import { normalizeSequence } from "../../../src/surreal/cli/struct"
import { structuredSnapshot } from "../../../src/surreal/cli/structure"
import { filterStructured, included } from "../../../src/surreal/cli/surreal-filter"
import { emitDefStatement, removeStatement } from "../../../src/surreal/ddl"
import { explodeSchema, toStructured } from "../../../src/surreal/kinds/explode"
import { lowerAll, surrealKinds } from "../../../src/surreal/kinds/registry"

describe("authoring", () => {
  test("a non-identifier name is rejected", () => {
    expect(() => defineSequence("not ok")).toThrow(/plain identifier/u)
    expect(() => defineSequence("1abc")).toThrow(/plain identifier/u)
  })

  test("batch must be a positive integer, start an integer, timeout a duration", () => {
    expect(() => defineSequence("s").batch(0)).toThrow(/positive integer/u)
    expect(() => defineSequence("s").batch(MAGIC_2p5)).toThrow(/positive integer/u)
    expect(() => defineSequence("s").start(MAGIC_1p5)).toThrow(/integer/u)
    expect(() => defineSequence("s").timeout("soon")).toThrow(/duration/u)
    expect(defineSequence("s").timeout("1h30m").config.timeout).toBe("1h30m")
  })

  test("the builder is immutable (each call returns a new def)", () => {
    const base = defineSequence("s")
    expect(base.config).toEqual({})
    expect(base.batch(MAGIC_10).config).toEqual({ batch: 10 })
    expect(base.config).toEqual({})
    expect(defineSequence("s").batch(MAGIC_50).start(MAGIC_1000).timeout("5s").config).toEqual({
      batch: 50,
      start: 1000,
      timeout: "5s",
    })
  })
})

describe("DDL", () => {
  test("defaults (BATCH 1000 / START 0) are omitted", () => {
    const { ddl, kind } = emitDefStatement(defineSequence("invoice"))
    expect(kind).toBe("sequence")
    expect(ddl).toBe("DEFINE SEQUENCE invoice;")
    // explicit defaults collapse to the same minimal form
    expect(emitDefStatement(defineSequence("s").batch(MAGIC_1000).start(0)).ddl).toBe(
      "DEFINE SEQUENCE s;",
    )
  })

  test("non-default tunables are emitted in grammar order (BATCH, START, TIMEOUT)", () => {
    expect(
      emitDefStatement(defineSequence("ticket").batch(MAGIC_50).start(MAGIC_1000).timeout("5s"))
        .ddl,
    ).toBe("DEFINE SEQUENCE ticket BATCH 50 START 1000 TIMEOUT 5s;")
    expect(emitDefStatement(defineSequence("s"), { exists: "overwrite" }).ddl).toBe(
      "DEFINE SEQUENCE OVERWRITE s;",
    )
  })

  test("REMOVE SEQUENCE is the inverse", () => {
    expect(removeStatement({ kind: "sequence", name: "invoice" })).toBe(
      "REMOVE SEQUENCE IF EXISTS invoice;",
    )
  })
})

describe("normalize", () => {
  test("materialized defaults are stripped so authored == introspected", () => {
    // INFO … STRUCTURE reports BATCH 1000 / START 0 explicitly.
    expect(normalizeSequence({ batch: 1000, name: "s", start: 0 })).toEqual({
      name: "s",
    })
    expect(normalizeSequence({ batch: 10, name: "s", start: 5, timeout: "2s" })).toEqual({
      batch: 10,
      name: "s",
      start: 5,
      timeout: "2s",
    })
  })

  test("sequences flow through schemaStruct's normalized Struct IR", () => {
    const db = schemaStruct(
      [],
      [defineSequence("bare"), defineSequence("tuned").batch(MAGIC_10).timeout("2s")],
    )
    expect(db.sequences).toEqual([{ name: "bare" }, { batch: 10, name: "tuned", timeout: "2s" }])
  })
})

describe("canonical DDL (every clause variant)", () => {
  test("structuredSnapshot emits BATCH/START/TIMEOUT in grammar order", () => {
    const db = schemaStruct(
      [],
      [
        defineSequence("bare"),
        defineSequence("b").batch(MAGIC_10),
        defineSequence("s").start(MAGIC_5),
        defineSequence("t").timeout("2s"),
        defineSequence("all").batch(MAGIC_10).start(MAGIC_5).timeout("2s"),
      ],
    )
    const ddls = Object.values(structuredSnapshot(db).statements)
      .map((s) => s.ddl)
      .sort()
    expect(ddls).toEqual([
      "DEFINE SEQUENCE all BATCH 10 START 5 TIMEOUT 2s;",
      "DEFINE SEQUENCE b BATCH 10;",
      "DEFINE SEQUENCE bare;",
      "DEFINE SEQUENCE s START 5;",
      "DEFINE SEQUENCE t TIMEOUT 2s;",
    ])
  })

  test("an introspected sequence with materialized defaults canonicalizes to bare", () => {
    const snap = structuredSnapshot({
      accesses: [],
      analyzers: [],
      functions: [],
      params: [],
      sequences: [{ batch: 1000, name: "d", start: 0 }],
      tables: [],
    })
    expect(Object.values(snap.statements)[0]?.ddl).toBe("DEFINE SEQUENCE d;")
  })
})

describe("kind registry: diff (emit / overwrite / remove) + explode round-trip", () => {
  test("planKinds adds, overwrites and removes a sequence", () => {
    const Bare = lowerAll([], [defineSequence("k")])
    const Tuned = lowerAll([], [defineSequence("k").batch(MAGIC_10)])
    expect(planKinds(surrealKinds, [], Bare).up.join("\n")).toContain("DEFINE SEQUENCE k;")
    expect(planKinds(surrealKinds, Bare, Tuned).up.join("\n")).toContain("OVERWRITE k BATCH 10")
    expect(planKinds(surrealKinds, Tuned, []).up.join("\n")).toContain(
      "REMOVE SEQUENCE IF EXISTS k;",
    )
    expect(planKinds(surrealKinds, Bare, lowerAll([], [defineSequence("k")])).up).toEqual([])
  })

  test("explode -> toStructured round-trips the sequence native", () => {
    const objs = explodeSchema([], [defineSequence("x").batch(MAGIC_3)])
    const seq = objs.find((o) => o.kind === "sequence")
    expect(seq?.name).toBe("x")
    expect(toStructured(objs).sequences).toEqual([{ batch: 3, name: "x" }])
  })
})

describe("filter + pull", () => {
  test("sequences pass the object filter and render one file each", () => {
    const db = schemaStruct([], [defineSequence("x")])
    expect(filterStructured(db, parseFilter({})).sequences).toEqual([{ name: "x" }])
    // A legacy DbStructured without `sequences` defaults to [] (the `?? []` fallback).
    expect(
      filterStructured(
        { accesses: [], analyzers: [], functions: [], params: [], tables: [] },
        parseFilter({}),
      ).sequences,
    ).toEqual([])
    expect([...renderPerFile(db, (_k, n) => `${n}.ts`).values()].join("\n")).toContain(
      'defineSequence("x")',
    )
    expect(
      included(parseFilter({}), {
        ddl: "DEFINE SEQUENCE x;",
        kind: "sequence",
        name: "x",
      }),
    ).toBe(true)
  })
})
