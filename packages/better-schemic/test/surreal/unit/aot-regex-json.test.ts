// Bun AOT — string regex sources and typed JSON keep the emitted DDL unchanged.
import { describe, expect, test } from "bun:test"

import { s, selectQuery, table } from "../../../src/surreal"
import { emitTable } from "../../../src/surreal/ddl"

describe("AOT — regex / json emit", () => {
  test("a string regex source emits the same DDL as a RegExp literal", () => {
    const fromString = table("t", { code: s.string().regex("^\\d+$") })
    const fromRegExp = table("t", { code: s.string().regex(/^\d+$/u) })
    expect(emitTable(fromString)).toBe(emitTable(fromRegExp))
  })

  test(".$regex with a string source emits the same ASSERT", () => {
    const a = table("t", { code: s.string().$regex("^A") })
    const b = table("t", { code: s.string().$regex(/^A/u) })
    expect(emitTable(a)).toBe(emitTable(b))
  })

  test("explicit flags are appended once", () => {
    const ddl = emitTable(table("t", { code: s.string().$regex("^a$", "i") }))
    expect(ddl).toContain("$value = /^a$/i")
  })

  test("selectQuery escapes identifiers and builds the projection", () => {
    const q = selectQuery("search_result", ["tenant_id", "score"] as const)
    expect(q.query).toBe("SELECT tenant_id, score FROM search_result")
    const fromDef = selectQuery(table("doc", { title: s.string() }), ["title"] as const)
    expect(fromDef.query).toBe("SELECT title FROM doc")
  })

  test("s.json<T>() emits the same DDL as plain s.json()", () => {
    const a = table("t", { meta: s.json<{ tool: string }>() })
    const b = table("t", { meta: s.json() })
    expect(emitTable(a)).toBe(emitTable(b))
  })
})
