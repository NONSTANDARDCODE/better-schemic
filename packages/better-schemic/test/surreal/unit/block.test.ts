// Typed-fragments PHASE 3 (2/3): block() — the typed statement-block builder. LET vars type
// through the chain (s.n is a real ref of the value's kind), IF/FOR/RETURN/THROW give statement
// parity, and the block is a fragment: it interpolates into surql templates and every authoring
// slot (event THEN, function body) via the Fragmentable (`toQuery()`) coercion.
import { describe, expect, test } from "bun:test"

import { defineFunction, s, surql, table } from "../../../src/surreal"
import { emitDefStatement, emitTable } from "../../../src/surreal/ddl"
import { block } from "../../../src/surreal/query"

const Post = table("blk_post", {
  title: s.string(),
  author: s.string(),
  views: s.number(),
})

describe("lowering", () => {
  test("let + if + return: `{ LET $n = ...; IF ... { ... }; RETURN ...; }`", () => {
    const q = block()
      .let({
        n: surql`(SELECT count() FROM blk_post GROUP ALL)[0].count OR 0`.as<number>(),
      })
      .if((sv) => sv.n.gt(100), surql`RETURN 'big'`)
      .return((sv) => sv.n)
      .toQuery()
    expect(q.query).toMatch(
      /^\{ LET \$n = \(SELECT count\(\) FROM blk_post GROUP ALL\)\[0\]\.count OR 0; IF \$n > \$sub__\d+_b0 \{ RETURN 'big' \}; RETURN \$n; \}$/u,
    )
    expect(Object.values(q.bindings ?? {})).toEqual([100])
  })

  test("typed let vars: a literal number var is a NUMBER ref — .plus flows", () => {
    const q = block()
      .let({ n: 5 })
      .return((sv) => sv.n.plus(1))
      .toQuery()
    expect(q.query).toMatch(/RETURN \$n \+ \$sub__\d+_r\d+; \}$/u)
  })

  test("literal lets bind; string vars get the string family", () => {
    const q = block()
      .let({ greeting: "hello" })
      .return((sv) => sv.greeting.uppercase())
      .toQuery()
    expect(q.query).toMatch(
      /^\{ LET \$greeting = \$sub__\d+_b0; RETURN string::uppercase\(\$greeting\); \}$/u,
    )
    expect(Object.values(q.bindings ?? {})).toEqual(["hello"])
  })

  test("for loops: FOR $item IN <iterable> { body } with a typed loop var", () => {
    const q = block()
      .let({ names: ["a", "b"] })
      .for(
        (sv) => ({ name: sv.names }),
        (sv) => surql`CREATE ${Post} SET title = ${sv.name.uppercase()}`,
      )
      .toQuery()
    expect(q.query).toMatch(
      /FOR \$name IN \$names \{ CREATE blk_post SET title = string::uppercase\(\$name\) \}; \}$/u,
    )
  })

  test("throw: a plain string binds", () => {
    const q = block().throw("nope").toQuery()
    expect(q.query).toMatch(/^\{ THROW \$sub__\d+_b0 \}$/u)
    expect(Object.values(q.bindings ?? {})).toEqual(["nope"])
  })

  test("do(): an arbitrary statement (fragments splice bare)", () => {
    const q = block()
      .do(surql`UPDATE ${Post} SET views += 1`)
      .do(surql`SELECT * FROM blk_post WHERE views > 1`)
      .toQuery()
    expect(q.query).toMatch(
      /^\{ UPDATE blk_post SET views \+= 1; SELECT \* FROM blk_post WHERE views > 1; \}$/u,
    )
  })

  test("if/else with nested block()s", () => {
    const q = block()
      .let({ n: 5 })
      .if((sv) => sv.n.gte(10), block().return(surql`'big'`), block().return(surql`'small'`))
      .toQuery()
    expect(q.query).toMatch(
      /IF \$n >= \$sub__\d+_b1 \{ RETURN 'big' \} ELSE \{ RETURN 'small' \}; \}$/u,
    )
  })

  test("reserved/invalid let names are rejected with guidance", () => {
    expect(() => block().let({ b0: 1 })).toThrow(/reserved/u)
    expect(() => block().let({ "no spaces": 1 })).toThrow(/identifier/u)
  })
})

describe("body canonicalization + value kinds", () => {
  const ifWith = (body: Parameters<ReturnType<typeof block>["if"]>[1]) =>
    block()
      .let({ n: 1 })
      .if((sv) => sv.n.gt(0), body)
      .toQuery().query

  test("a semicolon inside a quoted string is not top-level", () => {
    expect(ifWith(surql`RETURN 'a;b'`)).toContain("{ RETURN 'a;b' }")
    expect(ifWith(surql`RETURN "a;b"`)).toContain('{ RETURN "a;b" }')
  })

  test("a semicolon inside brackets/braces is not top-level", () => {
    expect(ifWith(surql`RETURN [1; 2]`)).toContain("{ RETURN [1; 2] }")
    expect(ifWith(surql`RETURN { a: 1; b: 2 }`)).toContain("{ RETURN { a: 1; b: 2 } }")
    expect(ifWith(surql`RETURN (1; 2)`)).toContain("{ RETURN (1; 2) }")
  })

  test("a backslash inside a quoted string does not close it", () => {
    // The escaped `;` stays inside the quote, so the scan treats the body as single-statement.
    expect(ifWith(surql`RETURN 'a\\;b'`)).toContain("{ RETURN 'a\\;b' }")
  })

  test("a top-level semicolon wraps as a multi-statement body", () => {
    expect(ifWith(surql`LET $x = 1; RETURN $x`)).toContain("{ LET $x = 1; RETURN $x; }")
  })

  test("a Date LET carries the date kind", () => {
    const q = block()
      .let({ d: new Date(0) })
      .return((sv) => sv.d)
      .toQuery()
    expect(q.query).toContain("LET $d =")
  })
})

describe("composition", () => {
  test("a block interpolates into a surql template", () => {
    const q = surql`${block().return(surql`1 + 1`)}`
    expect(q.query).toBe("{ RETURN 1 + 1 }")
  })

  test("typed: the block's RETURN types the fragment (Frag<R> flows to .let)", () => {
    // n: number -> RETURN s.n -> Block<..., number>; nesting keeps the type.
    const inner = block()
      .let({ n: 5 })
      .return((sv) => sv.n)
    const outer = block()
      .let({ m: inner })
      .return((sv) => sv.m.plus(1))
    expect(outer.toQuery().query).toContain("LET $m = { LET $n =")
  })
})

describe("authoring slots take blocks directly (Fragmentable)", () => {
  test("event THEN: block() emits as the braced body", () => {
    const T = Post.event("blk_notify", {
      when: (e) => e.event.eq("CREATE"),
      then: (e) =>
        block()
          .let({ who: e.after.author })
          .do(surql`UPDATE ${Post} SET views += 1 WHERE author = $who`),
    })
    const ddl = emitTable(T)
      .split("\n")
      .find((l) => l.includes("EVENT"))
    expect(ddl).toContain("THEN { LET $who = $after.author;")
    expect(ddl).toContain("UPDATE blk_post SET views += 1 WHERE author = $who; }")
  })

  test("function body: block() with typed args", () => {
    const F = defineFunction("blk_bump", { by: s.number() })
      .returns(s.number())
      .body((a) =>
        block()
          .let({
            n: surql`(SELECT count() FROM blk_post GROUP ALL)[0].count OR 0`.as<number>(),
          })
          .return((sv) => surql`${sv.n} + ${a.by}`),
      )
    const { ddl } = emitDefStatement(F)
    expect(ddl).toContain(
      "{ LET $n = (SELECT count() FROM blk_post GROUP ALL)[0].count OR 0; RETURN $n + $by; }",
    )
  })
})

describe("object bindings — refactor safety extras", () => {
  test("multi-key .let emits several LETs in order", () => {
    const q = block()
      .let({ a: 1, b: "x" })
      .return((sv) => surql`${sv.a} + ${sv.b.length()}`)
      .toQuery()
    expect(q.query).toMatch(
      /^\{ LET \$a = \$sub__\d+_b0; LET \$b = \$sub__\d+_b1; RETURN \$a \+ string::len\(\$b\); \}$/u,
    )
  })

  test(".let with an empty object throws with guidance", () => {
    expect(() => block().let({})).toThrow(/at least one var/u)
  })

  test(".for with more than one binding key throws", () => {
    expect(() =>
      block().for({ a: [1], b: [2] } as Record<string, number[]>, surql`RETURN 1`),
    ).toThrow(/exactly ONE loop binding/u)
  })

  test("callback .let sees earlier vars: (s) => ({ next: s.n.plus(1) })", () => {
    const q = block()
      .let({ n: 1 })
      .let((sv) => ({ next: sv.n.plus(1) }))
      .return((sv) => sv.next)
      .toQuery()
    expect(q.query).toMatch(/LET \$next = \$n \+ \$sub__\d+_r\d+; RETURN \$next; \}$/u)
  })
})

describe("empty block", () => {
  test("block() with no statements emits the valid no-op `{ }`", () => {
    expect(block().toQuery().query).toBe("{ }")
  })
})
