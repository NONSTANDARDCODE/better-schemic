/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-magic-numbers, @typescript-eslint/no-meaningless-void-operator, unicorn/no-thenable, @typescript-eslint/no-unnecessary-condition -- Object key order mirrors expected serialized output and must stay as authored. Literal values are intentional test data and must stay as authored. The void operator discards intentionally unused type-probe values. Bun test calls return thenable handles that are not awaited. Defensive checks document fixture intent. */
// Typed-fragments PHASE 0 (docs/proposals/typed-fragments.md): eager marker resolution in the
// surql tag (TableDef/Table/FunctionDef/surql.$ splice as TEXT; everything else binds), the
// surql.record/table/$/expr helpers, event THEN auto-blocking (multi-statement bodies wrap { ...; }
// matching INFO's canonical spelling), and lazy record refs s.recordId(() => Table).
import { setDefaultTimeout } from "bun:test"

// The workspace gate runs every package's suite IN PARALLEL — parallel-suite CPU contention can slow live
// connects/DDL far past bun's 30s default, timing out beforeAll/afterAll hooks (reported as
// "(unnamed)" tests). Live work gets a generous ceiling; isolated runs unaffect them.
setDefaultTimeout(120_000)

import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"

import { defineFunction, s, surql, table } from "../../../src/surreal"
import { emitTable } from "../../../src/surreal/ddl"

const SendMail = defineFunction("frag_send_mail", {
  email: s.string(),
  code: s.string(),
})
  .returns(s.string())
  .body(surql`RETURN $email + ":" + $code`)

const User = table("frag_user", {
  name: s.string(),
  email: s.string().$min(1),
})

const Verification = table("frag_verification", {
  id: s.tuple([User.record()]),
  codeHash: s.string().$internal(),
  expiresAt: s.datetime(),
  attempts: s.int().$default(0),
})

describe("surql tag — eager marker resolution", () => {
  test("TableDef / FunctionDef / surql.$ splice as TEXT (no bindings)", () => {
    const q = surql`SELECT * FROM ${User} WHERE ${surql.$.after.email} != NONE AND ${SendMail}($x, $y)`
    expect(q.query).toContain("FROM frag_user ")
    expect(q.query).toContain("$after.email != NONE")
    expect(q.query).toContain("fn::frag_send_mail($x, $y)")
    expect(Object.keys(q.bindings ?? {})).toHaveLength(0)
  })

  test("plain values still BIND as params; nested BoundQuery composes", () => {
    const inner = surql`age >= ${18}`
    const q = surql`SELECT * FROM ${User} WHERE ${inner} AND name = ${"ada"}`
    expect(q.query).toContain("FROM frag_user")
    // BOUND, not inlined. Assert on a TOKEN boundary, not a substring: the SDK names its params
    // `bind__<n>` off a module-global counter (`getIncrementalID` — private to `surrealdb`, so it
    // can neither be reset nor made per-query from here). Once it passes 180 the query reads
    // `age >= $bind__181`, in which a plain `toContain("18")` finds the counter's digits and the
    // test fails depending on WHICH FILES RAN BEFORE IT.
    expect(q.query).not.toMatch(/(?<!\w)18(?!\w)/u)
    expect(Object.values(q.bindings ?? {})).toContain(18)
    expect(Object.values(q.bindings ?? {})).toContain("ada")
  })

  test("the bind assertion holds however far the SDK's global counter has advanced", () => {
    // Reproduces the order-dependence directly: burn enough ids that the next `bind__` name
    // contains "18", then re-assert. Guards the fix above against a regression to `toContain`.
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (let i = 0; i < 200; i++) void surql`x = ${i}`
    const q = surql`SELECT * WHERE age >= ${18}`
    expect(q.query).toMatch(/\$bind__\d+/u)
    expect(q.query).not.toMatch(/(?<!\w)18(?!\w)/u)
    expect(Object.values(q.bindings ?? {})).toContain(18)
  })

  test("surql.record builds type::record with the typed table ref", () => {
    const q = surql.record(Verification, surql`[$after.id]`)
    expect(q.query).toBe("type::record(frag_verification, [$after.id])")
  })

  test("surql.table splices the escaped name", () => {
    expect(surql.table(User).query).toBe("frag_user")
  })

  test("a single-table RecordIdField ref splices its table name", () => {
    const ref = s.recordId("frag_user")
    expect(surql`SELECT * FROM ${ref}`.query).toBe("SELECT * FROM frag_user")
  })
})

describe("event THEN auto-block", () => {
  test("a multi-statement then wraps { ...; } and collapses whitespace (INFO-canonical)", () => {
    const T = table("frag_evt", { n: s.int() }).event("bump", {
      when: surql`$event = 'CREATE'`,
      then: surql`
        LET $x = $after.n + 1;
        UPDATE $after.id SET n = $x;
      `,
    })
    const ddl = emitTable(T)
      .split("\n")
      .find((l) => l.includes("EVENT"))
    expect(ddl).toContain("THEN { LET $x = $after.n + 1; UPDATE $after.id SET n = $x; };")
  })

  test("a single statement stays bare (trailing ; stripped)", () => {
    const T = table("frag_evt1", { n: s.int() }).event("one", {
      then: surql`UPDATE $after.id SET n = 1;`,
    })
    const ddl = emitTable(T)
      .split("\n")
      .find((l) => l.includes("EVENT"))
    expect(ddl).toContain("THEN UPDATE $after.id SET n = 1;")
    expect(ddl).not.toContain("{")
  })

  test("a ; inside a string literal does not trigger blocking", () => {
    const T = table("frag_evt2", { note: s.string() }).event("lit", {
      then: surql`UPDATE $after.id SET note = 'a;b'`,
    })
    const ddl = emitTable(T)
      .split("\n")
      .find((l) => l.includes("EVENT"))
    expect(ddl).toContain("THEN UPDATE $after.id SET note = 'a;b';")
    expect(ddl).not.toContain("THEN {")
  })

  test("an author-braced block passes through (whitespace collapsed)", () => {
    const T = table("frag_evt3", { n: s.int() }).event("braced", {
      then: surql`{
        LET $x = 1;
        UPDATE $after.id SET n = $x;
      }`,
    })
    const ddl = emitTable(T)
      .split("\n")
      .find((l) => l.includes("EVENT"))
    expect(ddl).toContain("THEN { LET $x = 1; UPDATE $after.id SET n = $x; };")
  })
})

describe("lazy record refs — s.recordId(() => Table)", () => {
  //  reference `Later` BEFORE its declaration: the thunk defers until emit, which is
  //  what breaks import cycles between mutually-linked table modules.
  const Early = table("frag_early", {
    link: s.recordId(() => Later),
  })
  const Later = table("frag_later", { name: s.string() })

  test("the thunk resolves at emit time — record<frag_later> in the DDL", () => {
    const ddl = emitTable(Early)
    expect(ddl).toContain("DEFINE FIELD link ON TABLE frag_early TYPE record<frag_later>")
  })

  test(".tables / .for() resolve lazily too", () => {
    const ref = s.recordId(() => Later)
    expect(ref.tables).toEqual(["frag_later"])
    const rid = ref.for("x1")
    expect(rid).toBeInstanceOf(RecordId)
    expect(rid.table.name).toBe("frag_later")
  })

  test("runtime validation enforces the resolved table", () => {
    const ref = s.recordId(() => Later)
    expect(ref.schema.safeParse(new RecordId("frag_later", "a")).success).toBe(true)
    expect(ref.schema.safeParse(new RecordId("frag_early", "a")).success).toBe(false)
  })

  test("mixed arrays (eager + lazy) union in the DDL", () => {
    const T = table("frag_mixed", {
      target: s.recordId([User, () => Later]),
    })
    expect(emitTable(T)).toContain("record<frag_user | frag_later>")
  })
})
