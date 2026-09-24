// The link branch of the include compiler: bare/union links (no single target), nested FETCH paths
// and the star-only forms. A tailored schema exercises the shapes the shared fixtures don't have.
import { describe, expect, test } from "bun:test";
import { defineTable, s } from "../../src/index";
import { compileRead, type ReadArgs } from "../../src/orm/compiler/select";
import { createBinds } from "../../src/orm/compiler/shared";
import type { BetterSchemicError } from "../../src/orm/errors";
import { buildSchemaIndex } from "../../src/orm/schema";

const NodeBase = defineTable("node", {
  name: s.string(),
  bare: s.recordId().optional(),
});
const Node = NodeBase.extend({
  parent: s.recordId(() => NodeBase).optional(),
});
const schema = { nodes: Node, audit_log: "audit_log" };
const index = buildSchemaIndex(schema as never);

function compile(args: ReadArgs, table = "nodes") {
  const meta = index.tables.get(table);
  if (!meta) throw new Error(`no table ${table}`);
  return compileRead(meta, args, createBinds(), "findMany", { index });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as BetterSchemicError).code;
  }
}

describe("include — link edge shapes", () => {
  test("onlyStar accepts { '*': false } as a non-star entry", () => {
    expect(
      codeOf(() => compile({ include: { bare: { "*": false } } })),
    ).toBe("ValidationError");
  });

  test("a nested include needs a single target table", () => {
    // `bare` has no declared target → length 0 → the "any" label.
    expect(
      codeOf(() => compile({ include: { bare: { include: { parent: true } } } })),
    ).toBe("ValidationError");
    // a link whose target is schemaless is not a typed table.
    const Schemaless = defineTable("schemaless", {
      ref: s.recordId("audit_log").optional(),
    });
    const idx = buildSchemaIndex({ items: Schemaless, audit_log: "audit_log" } as never);
    const meta = idx.tables.get("items")!;
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
    ).toBe("ValidationError");
  });

  test("nested include: undefined entries skip, star-only passes, empty fails", () => {
    expect(
      compile({ include: { parent: { include: { parent: true } } } }).sql,
    ).toContain("FETCH parent.parent");
    expect(
      compile({ include: { parent: { include: { parent: { "*": true } } } } })
        .sql,
    ).toContain("FETCH parent.parent");
    expect(
      codeOf(() =>
        compile({ include: { parent: { include: { parent: undefined } } } }),
      ),
    ).toBe("ValidationError");
  });
});
