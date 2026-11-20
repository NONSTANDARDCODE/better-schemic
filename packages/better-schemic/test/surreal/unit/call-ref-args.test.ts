// Def.call(...) args accept typed FIELD/BLOCK-VAR refs and builders, not literals /
// fragments / $param refs — `SendEmail.call({ email: e.after.email, code: sv.code })` from a
// block chain. Simple param-path refs splice BARE (`fn::f($code)` — parens there are redundant
// and INFO's printer strips them, so emitting them would phantom-diff DDL round-trips).
import { describe, expect, test } from "bun:test"

import { defineFunction, s, surql, table } from "../../../src/surreal"
import { block } from "../../../src/surreal/query"

const Audit = table("cra_audit", {
  who: s.string(),
  code: s.string(),
})
const Stamp = defineFunction("cra_stamp", {
  who: s.string(),
  code: s.string(),
})
  .returns(s.boolean())
  .body(
    ({ who, code }) => surql`{ CREATE ${Audit} SET who = ${who}, code = ${code}; RETURN true; }`,
  )

describe("call args — refs and builders", () => {
  test("a block-var ref splices BARE: fn::cra_stamp($who, $code)", () => {
    const b = block()
      .let({ code: surql`rand::string(6)`.as<string>() })
      .do((sv) => Stamp.call({ who: surql.$.after.email, code: sv.code }))
    expect(b.toQuery().query).toContain("fn::cra_stamp($after.email, $code)")
  })

  test("a fragment arg splices parenthesized with its binds", () => {
    const q = Stamp.call({
      who: surql`SELECT * FROM ONLY cra_audit WHERE code = ${"x"}`.as<string>(),
      code: "y",
    })
    expect(q.query).toMatch(
      /^fn::cra_stamp\(\(SELECT \* FROM ONLY cra_audit WHERE code = \$bind__\d+\), \$call__\d+_code\)$/u,
    )
    expect(Object.values(q.bindings)).toEqual(expect.arrayContaining(["x", "y"]))
  })

  test("typed: a wrong-kinded ref is a compile error", () => {
    const _bad = () =>
      block()
        .let({ n: 5 })
        // @ts-expect-error — `who` is a string arg; sv.n is a number ref
        .do((sv) => Stamp.call({ who: sv.n, code: "x" }))
    void _bad
  })
})
