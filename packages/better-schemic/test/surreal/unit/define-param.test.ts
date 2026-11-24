const MAGIC_25 = 25
// defineParam — DEFINE PARAM with the access-style split (Manuel's spec): an INLINE literal value
// is fully managed (emit/diff/migrations/pull); env()/secret() and DECLARED (type-/bare)
// params are OUT-OF-BAND (`sc param push/check`) — SurrealDB stores param values READABLY, so a
// secret value must never reach a snapshot or migration. `.$` is the typed `$name` reference.
const concat = surql.fn.string.concat.bind(surql.fn.string)

import { describe, expect, test } from "bun:test"

import { defineParam, env, s, surql } from "../../../src/surreal"
import { schemaStruct } from "../../../src/surreal/cli/lower"
import { normalizeParam } from "../../../src/surreal/cli/struct"
import { emitDefStatement } from "../../../src/surreal/ddl"

describe("authoring modes", () => {
  test("inline literal -> managed; SecretRef -> secret; s schema / bare -> declared", () => {
    expect(defineParam("page_size", MAGIC_25).config.mode).toBe("value")
    expect(defineParam("k", env("RESEND_API_KEY")).config.mode).toBe("secret")
    expect(defineParam("k", s.string()).config.mode).toBe("declared")
    expect(defineParam("k").config.mode).toBe("declared")
    expect(defineParam("page_size", MAGIC_25).managed).toBe(true)
    expect(defineParam("k").managed).toBe(false)
  })

  test("a non-identifier name is rejected", () => {
    expect(() => defineParam("not ok")).toThrow(/plain identifier/u)
  })

  test(".$ is the typed $name reference; the def itself splices in templates", () => {
    const Key = defineParam("resend_api_key", env("RESEND_API_KEY"))
    expect(Key.$.toText()).toBe("$resend_api_key")
    expect(surql`RETURN ${Key}`.query).toBe("RETURN $resend_api_key")
    // deep proxy: object params path through
    const Cfg = defineParam("app_cfg", { retries: 3 })
    expect((Cfg.$ as unknown as { retries: { toText(): string } }).retries.toText()).toBe(
      "$app_cfg.retries",
    )
    // typed: usable where a string operand expects it
    const q = concat("Bearer ", Key.$)
    expect(q.query).toMatch(/^string::concat\(\$r\d+, \$resend_api_key\)$/u)
  })
})

describe("DDL", () => {
  test("managed: the literal value inlines (with PERMISSIONS/COMMENT)", () => {
    const P = defineParam("page_size", MAGIC_25).permissions(false).comment("page size")
    const { ddl, kind } = emitDefStatement(P)
    expect(kind).toBe("param")
    expect(ddl).toBe('DEFINE PARAM $page_size VALUE 25 PERMISSIONS NONE COMMENT "page size";')
  })

  test("secret/declared: a $__value placeholder — the value NEVER reaches DDL text", () => {
    const S = defineParam("api_key", env("API_KEY"))
    const stmt = emitDefStatement(S, { exists: "overwrite" })
    expect(stmt.ddl).toBe("DEFINE PARAM OVERWRITE $api_key VALUE $__value;")
    expect(stmt.bindings).toEqual({ __value: env("API_KEY") })
    expect(emitDefStatement(defineParam("manual")).ddl).toBe("DEFINE PARAM $manual VALUE $__value;")
  })
})

describe("migration-flow scoping", () => {
  test("managed params enter schemaStruct; secret/declared are EXCLUDED", () => {
    const db = schemaStruct(
      [],
      [
        defineParam("page_size", MAGIC_25),
        defineParam("api_key", env("API_KEY")),
        defineParam("manual", s.string()),
      ],
    )
    expect(db.params.map((p) => p.name)).toEqual(["page_size"])
    expect(JSON.stringify(db)).not.toContain("api_key")
  })

  test("normalizeParam folds the inlined string spelling to INFO's '...'", () => {
    const db = schemaStruct([], [defineParam("api_base", "https://x.dev")])
    expect(db.params[0]?.value).toBe("'https://x.dev'")
    expect(normalizeParam({ name: "x", permissions: true, value: 's"a b"' })).toEqual({
      name: "x",
      value: "'a b'",
    })
  })
})
