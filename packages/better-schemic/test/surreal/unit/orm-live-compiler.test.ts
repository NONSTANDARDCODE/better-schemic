// The LIVE compiler in isolation: the args shape guard, the live-clause whitelist, diff/select
// Exclusivity, and the `fetch` lowering (which needs the schema index).
import { describe, expect, test } from "bun:test"

import { defineTable, s } from "../../../src/surreal"
import { compileLive } from "../../../src/surreal/orm/compiler/live"
import { createBinds } from "../../../src/surreal/orm/compiler/shared"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"

const UserBase = defineTable("lu", { name: s.string() }),
  User = UserBase.extend({
    mentor: s.recordId(() => UserBase).optional(),
  }),
  index = buildSchemaIndex({ users: User }),
  meta = index.tables.get("users")!,
  code = (fn: () => unknown): string | undefined => {
    try {
      fn()
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

describe("compileLive", () => {
  test("no args compiles a bare LIVE SELECT", () => {
    expect(compileLive(meta, undefined, createBinds()).sql).toBe("LIVE SELECT * FROM lu")
    expect(compileLive(meta, {}, createBinds()).sql).toBe("LIVE SELECT * FROM lu")
  })

  test("args must be an object; unknown clauses are rejected", () => {
    expect(code(() => compileLive(meta, 5, createBinds()))).toBe("ValidationError")
    expect(code(() => compileLive(meta, { limit: 1 }, createBinds()))).toBe(
      "ClauseNotSupportedInLive",
    )
    expect(code(() => compileLive(meta, { diff: "x" }, createBinds()))).toBe("ValidationError")
    expect(
      code(() => compileLive(meta, { diff: true, select: { name: true } }, createBinds())),
    ).toBe("ClauseNotSupportedInLive")
  })

  test("fetch needs the index; with it, FETCH is appended", () => {
    expect(code(() => compileLive(meta, { fetch: ["mentor"] }, createBinds()))).toBe(
      "ValidationError",
    )
    const plan = compileLive(meta, { fetch: ["mentor"] }, createBinds(), "live", {
      index,
    })
    expect(plan.sql).toContain("FETCH mentor")
  })

  test("diff compiles LIVE SELECT DIFF", () => {
    expect(compileLive(meta, { diff: true }, createBinds()).sql).toBe("LIVE SELECT DIFF FROM lu")
  })
})
