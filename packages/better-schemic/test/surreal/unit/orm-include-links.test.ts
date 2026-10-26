// The link branch of the include compiler: bare/union links (no single target), nested FETCH paths
// And the star-only forms. A tailored schema exercises the shapes the shared fixtures don't have.
import { describe, expect, test } from "bun:test"

import { defineTable, s } from "../../../src/surreal"
import { compileRead } from "../../../src/surreal/orm/compiler/select"
import { createBinds } from "../../../src/surreal/orm/compiler/shared"
import { buildSchemaIndex } from "../../../src/surreal/orm/schema"

import type { ReadArgs } from "../../../src/surreal/orm/compiler/select"
import type { BetterSchemicError } from "../../../src/surreal/orm/errors"

const NodeBase = defineTable("node", {
    name: s.string(),
    bare: s.recordId().optional(),
  }),
  Node = NodeBase.extend({
    parent: s.recordId(() => NodeBase).optional(),
  }),
  schema = { nodes: Node, audit_log: "audit_log" },
  index = buildSchemaIndex(schema)

function compile(args: ReadArgs, table = "nodes") {
  const meta = index.tables.get(table)
  if (!meta) throw new Error(`no table ${table}`)
  return compileRead(meta, args, createBinds(), "findMany", { index })
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as BetterSchemicError).code
  }
}

describe("include — link edge shapes", () => {
  test("onlyStar accepts { '*': false } as a non-star entry", () => {
    expect(codeOf(() => compile({ include: { bare: { "*": false } } }))).toBe("ValidationError")
  })

  test("a nested include needs a single target table", () => {
    // `bare` has no declared target → length 0 → the "any" label.
    expect(codeOf(() => compile({ include: { bare: { include: { parent: true } } } }))).toBe(
      "ValidationError",
    )
    // A link whose target is schemaless is not a typed table.
    const Schemaless = defineTable("schemaless", {
        ref: s.recordId("audit_log").optional(),
      }),
      idx = buildSchemaIndex({ items: Schemaless, audit_log: "audit_log" }),
      meta = idx.tables.get("items")!
    expect(
      codeOf(() =>
        compileRead(
          meta,
          { include: { ref: { include: { x: true } } } },
          createBinds(),
          "findMany",
          { index: idx },
        ),
      ),
    ).toBe("ValidationError")
  })

  test("nested include: undefined entries skip, star-only passes, empty fails", () => {
    expect(compile({ include: { parent: { include: { parent: true } } } }).sql).toContain(
      "FETCH parent.parent",
    )
    expect(compile({ include: { parent: { include: { parent: { "*": true } } } } }).sql).toContain(
      "FETCH parent.parent",
    )
    expect(codeOf(() => compile({ include: { parent: { include: { parent: undefined } } } }))).toBe(
      "ValidationError",
    )
  })
})
