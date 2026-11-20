// Bun AOT — fluent builder at runtime: the chain is an identity/DDL-preserving authoring surface.
import { describe, expect, test } from "bun:test"

import { s, table } from "../../../src/surreal"
import { emitTable } from "../../../src/surreal/ddl"

describe("AOT — fluent table builder", () => {
  const shape = { name: s.string(), active: s.boolean() }
  const meta = { createdAt: s.datetime().$readonly() }
  const extra = { deletedAt: s.datetime().optional() }

  test(".build() is an identity terminal", () => {
    const t = table("customer", shape)
    expect(t.build()).toBe(t)
  })

  test(".extend + .extendIf + .build emits the same DDL as a concrete composition", () => {
    const chained = table("customer", shape).extend(meta).extendIf(false, extra).build()
    const direct = table("customer", { ...shape, ...meta })
    expect(emitTable(chained)).toBe(emitTable(direct))
  })

  test(".extendIf(true, …) adds the conditional columns", () => {
    const chained = table("customer", shape).extend(meta).extendIf(true, extra).build()
    const direct = table("customer", { ...shape, ...meta, ...extra })
    expect(emitTable(chained)).toBe(emitTable(direct))
    expect(emitTable(chained)).toContain("DEFINE FIELD deletedAt ON TABLE customer")
  })
})
