// FULL-TS function bodies — zero raw surql. Three features compose: (1) plain object/array args
// SPLICE embedded refs/fragments (pure data still binds whole); (2) refs expose PROPERTY PATHS
// (`sv.res.id` -> `$res.id`); (3) block `.return`/`.let`/`.throw` take predicate Exprs
// (`sv.res.id.isNotNone()` -> `RETURN $res.id != NONE`). Plus http.* response generics
// (`http.post<R>(...)` — shorthand for `.as<R>()`).
import { describe, expect, test } from "bun:test"

import { defineFunction, s, surql, table } from "../../../src/surreal"
import { emitDefStatement } from "../../../src/surreal/ddl"
import { block } from "../../../src/surreal/query"

// THE dogfood function, no raw surql anywhere.
const SendVerificationEmail = defineFunction("fts_send_email", {
  email: s.string(),
  code: s.string(),
})
  .returns(s.boolean())
  .body(({ email, code }) =>
    block()
      .let({
        html: surql.fn.string.concat(
          "<h2>Verify your email</h2><p>Your verification code is <strong>",
          code,
          "</strong>. It expires in 15 minutes.</p>",
        ),
      })
      .let((sv) => ({
        res: surql.fn.http.post<{ id?: string }>(
          "https://api.resend.com/emails",
          {
            from: "Game Backlog <verify@example.dev>",
            to: [email],
            subject: "Your Game Backlog verification code",
            html: sv.html,
          },
          {
            Authorization: surql.fn.string.concat("Bearer ", surql.$.resend_api_key.as<string>()),
          },
        ),
      }))
      .return((sv) => sv.res.id.isNotNone()),
  )

describe("object/array args splice refs", () => {
  test("the full-TS body lowers to the intended SurrealQL", () => {
    const { ddl } = emitDefStatement(SendVerificationEmail)
    expect(ddl).toContain("to: [$email]")
    expect(ddl).toContain("html: $html")
    expect(ddl).toMatch(/Authorization: string::concat\(s?['"]Bearer ['"], \$resend_api_key\)/u)
    expect(ddl).toContain("RETURN $res.id != NONE")
    expect(ddl).toContain("string::concat(")
    expect(ddl).not.toContain("undefined")
  })

  test("pure-data objects still BIND whole (no splice, one param)", () => {
    const q = surql.fn.object.keys({ a: 1, b: "x" })
    expect(q.query).toMatch(/^object::keys\(\$r\d+\)$/u)
    expect(Object.values(q.bindings ?? {})).toEqual([{ a: 1, b: "x" }])
  })

  test("non-identifier keys quote; nested arrays/objects recurse", () => {
    const ref = surql.$.after.email.as<string>()
    const q = surql.fn.object.keys({ "x-y": { deep: [ref, 1] } })
    expect(q.query).toMatch(
      /^object::keys\(\{ "x-y": \{ deep: \[\$after\.email, \$[br]\d+\] \} \}\)$/u,
    )
  })
})

describe("ref property paths", () => {
  test("block-var paths splice: $res.id", () => {
    const b = block()
      .let({ res: surql.fn.http.get<{ id?: string }>("https://x.dev") })
      .return((sv) => sv.res.id.isNotNone())
    expect(b.toQuery().query).toMatch(/RETURN \$res\.id != NONE; \}$/u)
  })

  test("typed: paths follow the object shape; missing keys reject", () => {
    const b = block().let({
      res: surql.fn.http.get<{ id?: string }>("https://x.dev"),
    })
    const _ok = () => b.return((sv) => sv.res.id.isNotNone())
    // @ts-expect-error — `nope` is not a key of the typed response
    const _bad = () => b.return((sv) => sv.res.nope.isNotNone())
    void _ok
    void _bad
  })
})

describe("http response generics + .as on fn results", () => {
  test("http.post<R> and .as<R> are equivalent shorthands", () => {
    const norm = (q: string) => q.replace(/\$r\d+/gu, "$R")
    const a = surql.fn.http.post<{ id?: string }>("https://x.dev", {})
    const b = surql.fn.http.post("https://x.dev", {}).as<{ id?: string }>()
    expect(norm(a.query)).toBe(norm(b.query))
  })

  test("every catalog result carries .as<T>()", () => {
    const n = surql.fn.string.len("abc").as<number>()
    expect(n.query).toMatch(/^string::len\(\$r\d+\)$/u)
  })
})
