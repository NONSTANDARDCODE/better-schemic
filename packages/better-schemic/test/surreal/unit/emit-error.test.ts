import { describe, expect, test } from "bun:test"

import { surql } from "../../../src/surreal"
import { fromStandalone } from "../../../src/surreal/cli/lower"
import { buildSnapshot } from "../../../src/surreal/cli/surreal-diff"
import { emitDefStatement, emitTable } from "../../../src/surreal/driver"
import {
  defineAccess,
  defineAnalyzer,
  defineFunction,
  RecordAccessDef,
  s,
  type StandaloneDef,
  table,
} from "../../../src/surreal/pure"

test("DEFINE ACCESS scope is a type-enforced first step (.onDatabase()/.onNamespace())", () => {
  // The type/clause methods don't exist until a scope picks it — a COMPILE error, which is the whole
  // point (you can't author an unscoped access). Kept in a never-called fn so tsc checks it but it
  // doesn't run (the methods genuinely aren't there at runtime).
  const _typeGate = () => {
    // @ts-expect-error — `.record()` is not on the pre-scope builder
    defineAccess("a").record()
    // @ts-expect-error — `.bearer()` is not on the pre-scope builder either
    defineAccess("a").bearer({ for: "user" })
    // The TYPE is an exclusive choice — once you pick one, the other switchers gone them:
    // @ts-expect-error — can't switch JWT → BEARER (types are mutually exclusive)
    defineAccess("a").onDatabase().jwt({ url: "u" }).bearer({ for: "user" })
    // RECORD-clauses don't leak onto other types:
    defineAccess("a")
      .onDatabase()
      .bearer({ for: "user" })
      // @ts-expect-error — `.signup()` is not on a BEARER access
      .signup(surql`X`)
    // @ts-expect-error — `.withRefresh()` is not on a JWT access
    defineAccess("a").onDatabase().jwt({ url: "u" }).withRefresh()
    // RECORD is database-— `.record()` isn't offered on the namespace stage:
    // @ts-expect-error — no `.record()` on ON NAMESPACE
    defineAccess("a").onNamespace().record()
    // The TYPE is a required, explicit step — no implicit-record shortcut:
    defineAccess("a")
      .onDatabase()
      // @ts-expect-error — must call `.record()` before a RECORD clause
      .signup(surql`X`)
  }
  void _typeGate
  // Scope first, then the type:
  expect(emitDefStatement(defineAccess("a").onDatabase().record()).ddl).toBe(
    "DEFINE ACCESS a ON DATABASE TYPE RECORD;",
  )
})

// --- incomplete defs teach, never crash (and are never dropped) -------------------------
describe("incomplete definitions", () => {
  // The public API type-gates these (see the `_typeGate` above), so a JS schema module or a bad cast
  // is how they reach the pipeline. They used to MIS-DISPATCH: a def with no `kind` fell through
  // `emitDefStatement` into `emitFunction` and died on `undefined is not an object (fn.config.body)`.
  const unscoped = () => defineAccess("account") as unknown as StandaloneDef
  const noType = () => defineAccess("account").onDatabase() as unknown as StandaloneDef
  const noTypeNs = () => defineAccess("account").onNamespace() as unknown as StandaloneDef

  test("an access with no scope + no TYPE names the next call to make", () => {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const go of [() => emitDefStatement(unscoped()), () => fromStandalone(unscoped())]) {
      expect(go).toThrow(/access "account" is incomplete/u)
      expect(go).toThrow(/\.onDatabase\(\) or \.onNamespace\(\)/u)
    }
  })

  test("a scoped access with no TYPE names only that scope's types", () => {
    expect(() => emitDefStatement(noType())).toThrow(
      /access "account" has no TYPE — call \.record\(\), \.jwt\(.+\) or \.bearer\(/u,
    )
    expect(() => fromStandalone(noType())).toThrow(/has no TYPE/u)
    // RECORD is database-, so the namespace stage must not suggest it.
    expect(() => emitDefStatement(noTypeNs())).toThrow(/TYPE RECORD is database-only/u)
    expect(() => emitDefStatement(noTypeNs())).not.toThrow(/\.record\(\)/u)
  })

  test("a bodyless function throws on BOTH lower and emit (never an empty block)", () => {
    // `lowerFunction` used to emit `block: "{}"`, landing an empty function in the snapshot while
    // `emitFunction` threw on the  same def.
    const bodyless = () => defineFunction("greet") as unknown as StandaloneDef
    expect(() => emitDefStatement(bodyless())).toThrow(
      /function fn::greet has no body — call \.body\(/u,
    )
    expect(() => fromStandalone(bodyless())).toThrow(
      /function fn::greet has no body — call \.body\(/u,
    )
  })

  test("an unknown def kind is named, not mis-dispatched into a sibling emitter", () => {
    const bogus = { kind: "widget", name: "w" } as unknown as StandaloneDef
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const go of [() => emitDefStatement(bogus), () => fromStandalone(bogus)]) {
      expect(go).toThrow(/definition "w" has an unknown kind "widget"/u)
      expect(go).toThrow(/event, access, analyzer, param, function/u)
    }
  })

  test("defs that are legitimately clause-free still emit", () => {
    // Guard the guards: a bare analyzer is VALID SurrealQL (verified on 3.1.4), so it must not throw.
    expect(emitDefStatement(defineAnalyzer("english")).ddl).toBe("DEFINE ANALYZER english;")
  })
})

test("a non-Surreal field type error names the field + table", () => {
  const Bad = table("widget", {
    id: s.string(),
    // s.custom() has no SurrealQL mapping — table rejects it at compile time (that's the
    // point); here we assert the RUNTIME error pins the field + table.
    // @ts-expect-error intentional no-DDL field
    blob: s.custom(),
  })
  const tables = [Bad] as unknown as Parameters<typeof buildSnapshot>[0]
  expect(() => buildSnapshot(tables)).toThrow(/field "blob" on table "widget"/u)
})

// --- DEFINE FIELD validation guards (reject combos SurrealDB's parser rejects, at gen not apply) ---
describe("field validation guards", () => {
  const T = (field: s.Field, schemafull = true) => {
    const t = table("t", { x: field })
    return () => emitTable(schemafull ? t.schemafull() : t.schemaless())
  }

  test("$computed is mutually exclusive with $value/$default/$readonly/$assert/$reference", () => {
    expect(
      T(
        s
          .string()
          .$computed(surql`1`)
          .$default(surql`0`),
      ),
    ).toThrow(/\$computed can't be combined with \$default/u)
    expect(
      T(
        s
          .string()
          .$computed(surql`1`)
          .$readonly(),
      ),
    ).toThrow(/\$computed can't be combined with \$readonly/u)
    expect(
      T(
        s
          .string()
          .$computed(surql`1`)
          .$value(surql`$value`, { optional: false }),
      ),
    ).toThrow(/\$computed can't be combined with \$value/u)
    expect(
      T(
        s
          .string()
          .$computed(surql`1`)
          .$assert(surql`true`),
      ),
    ).toThrow(/\$computed can't be combined with \$assert/u)
  })

  test("$reference needs a record-link type, and only on a top-level field", () => {
    expect(T(s.string().$reference())).toThrow(/\$reference needs a record-link type/u)
    // a real record link is fine:
    expect(() =>
      emitTable(table("t", { x: s.recordId("post").$reference() }).schemafull()),
    ).not.toThrow()
  })

  test("FLEXIBLE requires a SCHEMAFULL table", () => {
    expect(T(s.object({ a: s.string() }).flexible(), false)).toThrow(
      /FLEXIBLE is only valid on a SCHEMAFULL table/u,
    )
    expect(() =>
      emitTable(
        table("t", {
          x: s.object({ a: s.string() }).flexible(),
        }).schemafull(),
      ),
    ).not.toThrow()
  })

  test("a valid $computed field (alone) still emits", () => {
    expect(
      emitTable(
        table("t", {
          full: s.string().$computed(surql`a + b`),
        }).schemafull(),
      ),
    ).toContain("COMPUTED a + b")
  })
})
