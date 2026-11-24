// Kind-registry parity (docs/kind-registry-contract.md §3): the generic kind-registry path must reproduce
// the driver's INTERNAL clause-level engine (`diffSnapshots` over `buildSnapshot`) for the
// `table`/`index`/`event`/`function` kinds (access unmanags it — excludeFromMigrations — and asserted
// separately to emit nothing). We assert the STRONGEST statement — that
// `planKinds(registry, lowerAll(prev), lowerAll(next)).{up,down}` equals the `diffSnapshots` up/down —
// across add/change/remove of every kind, so the kind engines stay byte-exact with the engine they
// delegate to (and the test self-maintains: no hand-written DDL). At the Option-A flip the registry IS
// the production diff path (the old whole-DB `surrealDriver.diff` gones it), so this pins the wrapper.
//
// Each diff scenario touches ONE table, so statement order is unambiguous. Cross-table EMIT ordering is
// asserted separately via `emitKinds` (the registry uses dependency ordering — strictly more correct
// than the legacy insertion order, e.g. a RELATION emits after its endpoints).
import {
  defineAccess,
  defineAnalyzer,
  defineFunction,
  relation,
  s,
  surql,
  table,
} from "better-schemic"
import {
  buildKindDiff,
  emitKinds,
  planKinds,
  snapshotKinds,
  snapshotObjects,
} from "better-schemic/core"
import { surrealDriver } from "better-schemic/driver"
import { describe, expect, test } from "bun:test"
import type { ZodInt, ZodString } from "zod"

import { schemaStruct } from "../../../src/surreal/cli/lower"
import { type Snapshot, structuredSnapshot } from "../../../src/surreal/cli/structure"
import { diffSnapshots } from "../../../src/surreal/cli/surreal-diff"
import { lowerAll, surrealKinds } from "../../../src/surreal/kinds/registry"
import type {
  AnalyzerDef,
  FunctionDef,
  JwtAccessDef,
  RecordAccessDef,
  SField,
  TableDef,
  WithSmartId,
} from "../../../src/surreal/pure"
import { THEN_KEY } from "../../then-key"
const eng = (): AnalyzerDef => defineAnalyzer("eng").tokenizers("blank")

const fnIdx = (up: string[]): number =>
  up.findIndex((l): boolean => l.startsWith("DEFINE FUNCTION fn::fmt"))

const fmt = (): FunctionDef<{ v: SField<ZodString> }, string> =>
  defineFunction("fmt", { v: s.string() })
    .returns(s.string())
    .body(surql`RETURN $v`)

const jwks = (): JwtAccessDef =>
  defineAccess("ext").onDatabase().jwt({ url: "https://x/jwks.json" })

const jwt = (): JwtAccessDef =>
  defineAccess("jwt").onDatabase().jwt({ alg: "HS512", key: "secret" })

const acct = (): RecordAccessDef =>
  defineAccess("acct")
    .onDatabase()
    .record()
    .signin(surql`SELECT 1`)

const add = (): FunctionDef<{ a: SField<ZodInt>; b: SField<ZodInt> }, number> =>
  defineFunction("add", { a: s.int(), b: s.int() })
    .returns(s.int())
    .body(surql`RETURN $a + $b`)

const idx = (ddl: string[], re: RegExp): number => ddl.findIndex((l): boolean => re.test(l))

const headers = (ddl: string[]): string[] =>
  ddl.filter((l): boolean => /^DEFINE (TABLE|INDEX|EVENT)/u.test(l))

const changed = (): TableDef<
  "user",
  WithSmartId<"user", { id: SField<ZodString>; n: SField<ZodInt> }>
> =>
  table("user", { id: s.string(), n: s.int() }).event("on_n", {
    [THEN_KEY]: surql`UPDATE $after.id SET touched = false`,
    when: surql`$before.n != $after.n`,
  })

const evented = (): TableDef<
  "user",
  WithSmartId<"user", { id: SField<ZodString>; n: SField<ZodInt> }>
> =>
  table("user", { id: s.string(), n: s.int() }).event("on_n", {
    [THEN_KEY]: surql`UPDATE $after.id SET touched = true`,
    when: surql`$before.n != $after.n`,
  })

const base = (): TableDef<
  "m",
  WithSmartId<"m", { a: SField<ZodString>; b: SField<ZodString>; id: SField<ZodString> }>
> => table("m", { a: s.string(), b: s.string(), id: s.string() })

const t2 = (): TableDef<"t", WithSmartId<"t", { id: SField<ZodString> }>> =>
  table("t", { id: s.string() })

// Lib-authored tables/defs vs the src-typed signatures: cast at the seam (as buildSnapshot does).
type AnyArr = Parameters<typeof lowerAll>[0] | Parameters<typeof schemaStruct>[1]
// The driver's INTERNAL clause-level engine over the CANONICAL snapshot (`structuredSnapshot` — the
// SAME renderer the registry's `explode` uses, so divergences like DEFAULT quote style match).
const legacy = (
  prevT: AnyArr,
  nextT: AnyArr,
  prevD: AnyArr = [],
  nextD: AnyArr = [],
): { down: string[]; up: string[] } => {
  const snap = (t: AnyArr, d: AnyArr): Snapshot =>
    structuredSnapshot(schemaStruct(t as never, d as never))
  const diff = diffSnapshots(snap(prevT, prevD), snap(nextT, nextD))
  return { down: diff.down, up: diff.up }
}
const registry = (
  prevT: AnyArr,
  nextT: AnyArr,
  prevD: AnyArr = [],
  nextD: AnyArr = [],
): { down: string[]; up: string[] } => {
  const { down, up } = planKinds(
    surrealKinds,
    lowerAll(prevT as never, prevD as never),
    lowerAll(nextT as never, nextD as never),
  )
  return { down, up }
}

/** Assert the registry path == the fixed-slot path for a (prev -> next) schema change. */
const parity = (prevT: AnyArr, nextT: AnyArr, prevD: AnyArr = [], nextD: AnyArr = []): void => {
  expect(registry(prevT, nextT, prevD, nextD)).toEqual(legacy(prevT, nextT, prevD, nextD))
}

const User = (): TableDef<
  "user",
  WithSmartId<"user", { id: SField<ZodString>; name: SField<ZodString> }>
> => table("user", { id: s.string(), name: s.string() })

describe("table/field kind parity with surrealDriver.diff", () => {
  test("add a field", () => {
    parity(
      [User()],
      [
        table("user", {
          email: s.email(),
          id: s.string(),
          name: s.string(),
        }),
      ],
    )
  })

  test("change a field type", () => {
    parity(
      [table("user", { id: s.string(), name: s.string() })],
      [table("user", { id: s.string(), name: s.string().optional() })],
    )
  })

  test("remove a field", () => {
    parity(
      [
        table("user", {
          id: s.string(),
          legacy: s.string(),
          name: s.string(),
        }),
      ],
      [User()],
    )
  })

  test("add a field clause (DEFAULT) -> ALTER FIELD set/drop", () => {
    const prev = [table("user", { id: s.string(), name: s.string() })]
    const next = [
      table("user", {
        id: s.string(),
        name: s.string().$default("anon"),
      }),
    ]
    parity(prev, next)
    parity(next, prev) // the inverse (DROP DEFAULT)
  })

  test("COMPUTED change (OVERWRITE fallback inside the table kind)", () => {
    parity(
      [table("t", { c: s.string(), id: s.string() })],
      [
        table("t", {
          c: s.string().$computed(surql`"x"`),
          id: s.string(),
        }),
      ],
    )
  })

  test("table SCHEMAFULL <-> SCHEMALESS (table-head ALTER)", () => {
    parity([t2()], [t2().schemaless()])
    parity([t2().schemaless()], [t2()])
  })

  test("table COMMENT add/remove (table-head ALTER)", () => {
    parity([t2()], [t2().comment("note")])
    parity([t2().comment("note")], [t2()])
  })

  test("table TYPE change (NORMAL -> RELATION) OVERWRITE fallback", () => {
    parity([table("t", { id: s.string() })], [relation("t", {})])
  })

  test("add a whole table (head + fields)", () => {
    parity([User()], [User(), table("post", { id: s.string(), title: s.string() })])
  })

  test("remove a whole table", () => {
    parity([User(), table("post", { id: s.string(), title: s.string() })], [User()])
  })

  test("mixed field add + change + remove in one table", () => {
    parity(
      [
        table("user", {
          id: s.string(),
          name: s.string(),
          old: s.string(),
        }),
      ],
      [
        table("user", {
          email: s.email(),
          id: s.string(),
          name: s.string().optional(),
        }),
      ],
    )
  })

  test("identical schema -> empty plan", () => {
    expect(registry([User()], [User()])).toEqual({ down: [], up: [] })
  })
})

describe("index kind parity", () => {
  test("add an index (field .$unique())", () => {
    parity(
      [table("t", { code: s.string(), id: s.string() })],
      [table("t", { code: s.string().$unique(), id: s.string() })],
    )
  })

  test("change an index (.$index() -> .$unique()) recreates", () => {
    parity(
      [table("t", { a: s.string().$index(), id: s.string() })],
      [table("t", { a: s.string().$unique(), id: s.string() })],
    )
  })

  test("composite table .index() add", () => {
    parity([base()], [base().index("m_ab", ["a", "b"])])
  })
})

describe("event kind parity", () => {
  test("add an event", () => {
    parity([table("user", { id: s.string(), n: s.int() })], [evented()])
  })

  test("change an event (DEFINE EVENT OVERWRITE)", () => {
    parity([evented()], [changed()])
  })

  test("remove an event", () => {
    parity([evented()], [table("user", { id: s.string(), n: s.int() })])
  })
})

describe("cross-kind dependency ordering (emitKinds)", () => {
  test("an index + event cluster AFTER their table", () => {
    const t = table("user", {
      email: s.email().$unique(),
      id: s.string(),
    }).event("ev", { [THEN_KEY]: surql`UPDATE $after.id SET seen = true` })
    const up = emitKinds(surrealKinds, lowerAll([t]))
    const at = idx(up, /^DEFINE TABLE user/u)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(idx(up, /^DEFINE INDEX/u))
    expect(at).toBeLessThan(idx(up, /^DEFINE EVENT/u))
  })

  test("a RELATION emits AFTER its in/out endpoint tables (deps graph)", () => {
    const user = table("user", { id: s.string() })
    const post = table("post", { id: s.string() })
    const wrote = relation("wrote", {}).from(user).to(post)
    const up = headers(emitKinds(surrealKinds, lowerAll([wrote, user, post])))
    const rel = up.findIndex((l) => l.includes("DEFINE TABLE wrote"))
    expect(up.findIndex((l) => l.includes("DEFINE TABLE user"))).toBeLessThan(rel)
    expect(up.findIndex((l) => l.includes("DEFINE TABLE post"))).toBeLessThan(rel)
  })
})

describe("buildKindDiff + snapshot round-trip", () => {
  test("buildKindDiff reports add/change items + full, matching planKinds up/down", () => {
    const prev = lowerAll([User()])
    const next = lowerAll([
      table("user", {
        email: s.email(),
        id: s.string(),
        name: s.string().optional(),
      }),
      table("post", { id: s.string(), title: s.string() }),
    ])
    const diff = buildKindDiff(surrealKinds, prev, next)
    expect({ down: diff.down, up: diff.up }).toEqual(planKinds(surrealKinds, prev, next))
    // PER-FIELD display (Manuel's call, via the table kind's displayItems): a changed table reports
    // FIELD-level items (not a coarse whole-table item) — name changed, email added.
    const items = diff.items ?? []
    expect(items.find((i) => i.key === "field:user:name")?.op).toBe("change")
    expect(items.find((i) => i.key === "field:user:email")?.op).toBe("add")
    // A freshly-added table still surfaces its head + fields as add items.
    expect(items.find((i) => i.key === "table::post")?.op).toBe("add")
    expect((diff.full ?? []).map((s) => s.key)).toContain("field:post:title")
  })

  test("snapshotKinds -> JSON -> snapshotObjects round-trips to a zero diff", () => {
    const portable = lowerAll([
      table("user", { email: s.email().$unique(), id: s.string() }).event("ev", {
        [THEN_KEY]: surql`UPDATE $after.id SET seen = true`,
      }),
    ])
    const snap = snapshotKinds(portable)
    expect(Object.keys(snap.kinds).sort()).toEqual(["event", "index", "table"])
    const restored = snapshotObjects(JSON.parse(JSON.stringify(snap)))
    expect(planKinds(surrealKinds, restored, portable)).toEqual({
      down: [],
      up: [],
    })
  })
})

describe("function kind parity (opaque)", () => {
  test("add a function", () => {
    parity([], [], [], [add()])
  })

  test("change a function body (DEFINE FUNCTION OVERWRITE)", () => {
    const changed = defineFunction("add", { a: s.int(), b: s.int() })
      .returns(s.int())
      .body(surql`RETURN $a * $b`)
    parity([], [], [add()], [changed])
  })

  test("remove a function", () => {
    parity([], [], [add()], [])
  })
})

describe("access is managed PER OBJECT (key-free rides migrations; key-bearing stays out-of-band)", () => {
  // Key-free access (TYPE RECORD with no authored key) round-trips the canonical DDL, so it's a
  // MANAGED migration kind — byte-parity with the internal `diffSnapshots` engine. A key-bearing
  // TYPE JWT stays unmanaged: the canonical DDL omits the redacted KEY, so re-applying would rotate
  // it (managed out-of-band via `sc access push/diff/rotate`).

  test("adding a key-free access emits DEFINE ACCESS (parity)", () => {
    parity([], [], [], [acct()])
  })

  test("changing a key-free access emits an in-place change (parity)", () => {
    const changed = defineAccess("acct")
      .onDatabase()
      .record()
      .signin(surql`SELECT 2`)
    parity([], [], [acct()], [changed])
  })

  test("removing a key-free access emits REMOVE ACCESS (parity)", () => {
    parity([], [], [acct()], [])
  })

  test("a key-bearing TYPE JWT access stays unmanaged (no migration statements)", () => {
    expect(registry([], [], [], [jwt()])).toEqual({ down: [], up: [] })
  })

  test("a JWKS-URL JWT access is key-free and managed (parity)", () => {
    parity([], [], [], [jwks()])
  })

  test("snapshotKinds keeps key-free access (RECORD/JWKS/BEARER), drops key-bearing JWT", () => {
    const record = defineAccess("acct").onDatabase().record()
    const jwks = defineAccess("ext").onDatabase().jwt({ url: "https://x/jwks.json" })
    const bearer = defineAccess("svc").onDatabase().bearer({ for: "record" })
    const jwt = defineAccess("jwt").onDatabase().jwt({ alg: "HS512", key: "secret" })
    const snap = snapshotKinds(lowerAll([], [record, jwks, bearer, jwt]), surrealKinds)
    expect(
      snapshotObjects(snap)
        .map((o) => `${o.kind}:${o.name}`)
        .sort(),
    ).toEqual(["access:acct", "access:ext", "access:svc"])
  })
})

describe("fn:: dependency ordering (function emits before its caller)", () => {
  test("before a table whose field COMPUTED calls it", () => {
    const t = table("doc", {
      id: s.string(),
      slug: s.string().$computed(surql`fn::fmt(id)`),
    })
    const up = emitKinds(surrealKinds, lowerAll([t], [fmt()]))
    expect(fnIdx(up)).toBeGreaterThanOrEqual(0)
    expect(fnIdx(up)).toBeLessThan(up.findIndex((l) => l.startsWith("DEFINE TABLE doc")))
  })

  test("before an event whose THEN calls it", () => {
    const t = table("user", { id: s.string(), n: s.int() }).event("ev", {
      [THEN_KEY]: surql`UPDATE $after.id SET x = fn::fmt("y")`,
    })
    const up = emitKinds(surrealKinds, lowerAll([t], [fmt()]))
    expect(fnIdx(up)).toBeGreaterThanOrEqual(0)
    expect(fnIdx(up)).toBeLessThan(up.findIndex((l) => l.startsWith("DEFINE EVENT ev")))
  })

  test("before an access whose SIGNIN calls it", () => {
    const access = defineAccess("acct")
      .onDatabase()
      .record()
      .signin(surql`SELECT * FROM user WHERE fn::fmt(email)`)
    const up = emitKinds(surrealKinds, lowerAll([], [fmt(), access]))
    expect(fnIdx(up)).toBeGreaterThanOrEqual(0)
    expect(fnIdx(up)).toBeLessThan(up.findIndex((l) => l.includes("DEFINE ACCESS")))
  })
})

describe("analyzer dependency ordering (analyzer emits before its FULLTEXT index)", () => {
  // Regression: a minimal `… FULLTEXT ANALYZER eng;` (default BM25 stripped) put the `;` flush against
  // the name, so the dep parss it as `eng;` ≠ the `eng` analyzer — the edge dropps it and the index
  // could emit before its analyzer (apply error). The dep must resolve so the analyzer comes first.

  test("table-level .index(fulltext) — analyzer before index", () => {
    const t = table("doc", { body: s.string(), id: s.string() }).index("ft", ["body"], {
      fulltext: { analyzer: "eng" },
    })
    const up = emitKinds(surrealKinds, lowerAll([t], [eng()]))
    const ai = up.findIndex((l) => l.startsWith("DEFINE ANALYZER eng"))
    const ii = up.findIndex((l) => l.startsWith("DEFINE INDEX ft"))
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(ii).toBeGreaterThanOrEqual(0)
    expect(ai).toBeLessThan(ii)
  })

  test("field-level .$fulltext() — analyzer before index", () => {
    const t = table("doc2", {
      body: s.string().$fulltext("eng"),
      id: s.string(),
    })
    const up = emitKinds(surrealKinds, lowerAll([t], [eng()]))
    expect(up.findIndex((l) => l.startsWith("DEFINE ANALYZER eng"))).toBeLessThan(
      up.findIndex((l) => l.startsWith("DEFINE INDEX doc2_body_idx")),
    )
  })
})

// The flipped Driver shape: the production surreal driver IS the kind registry now — the whole-DB
// `lower`/`emit`/`diff`/`introspect`/`normalize`/`equal` methods gone them, replaced by
// `registry`/`explode`/`introspectAll`. Smoke-test the new surface.
describe("flipped surrealDriver shape", () => {
  test("exposes registry + explode + introspectAll; drops the retired IR methods", () => {
    expect(surrealDriver.registry).toBe(surrealKinds)
    const objs = surrealDriver.explode(
      [
        table("user", {
          id: s.string(),
          name: s.string().$unique(),
        }),
      ] as never,
      [] as never,
    )
    // explode fans the table into a table object + its index, each tagged by kind.
    expect(objs.map((o) => o.kind).sort()).toEqual(["index", "table"])
    expect(typeof surrealDriver.introspectAll).toBe("function")
    ;["lower", "emit", "diff", "introspect", "normalize", "equal"].forEach((m) => {
      expect((surrealDriver as unknown as Record<string, unknown>)[m]).toBeUndefined()
    })
  })
})
