// Formatting must never phantom-diff: authors write MULTI-LINE surql bodies, INFO prints blocks
// Single-line — and INFO itself prints nested multi-statement blocks with NEWLINES. Both sides
// Normalize through collapseWs (quote-aware), so only real changes diff.
import { describe, expect, test } from "bun:test"

import { normalizeFunction } from "../../../src/surreal/cli/struct"

describe("block whitespace canonicalization", () => {
  test("multi-line function block == single-line (trailing ; dropped)", () => {
    const multi = normalizeFunction({
        name: "f",
        args: [],
        block: "{ LET $x = string::concat(\n  'a',\n  'b'\n);\n  RETURN $x;\n}",
      }),
      single = normalizeFunction({
        name: "f",
        args: [],
        block: "{ LET $x = string::concat('a', 'b'); RETURN $x }",
      })
    expect(multi.block).toBe(single.block)
  })

  test("whitespace INSIDE string literals is preserved", () => {
    const fn = normalizeFunction({
      name: "f",
      args: [],
      block: "{ RETURN 'two  spaces\\nand a newline' }",
    })
    expect(fn.block).toContain(String.raw`two  spaces\nand a newline`)
  })
})

// --- live (SURREAL_URL-gated): the cases that used to phantom-diff -------------------------------
const URL = process.env.SURREAL_URL

describe.skipIf(!URL)("normalize-ws live", () => {
  test("multi-line fn body + multi-statement IF branches round-trip drift-free", async () => {
    const { Surreal } = await import("surrealdb"),
      { emitDefStatement, emitTable } = await import("../../../src/surreal/ddl"),
      { explodeSchema, introspectAll } = await import("../../../src/surreal/kinds/explode"),
      { deepEqual } = await import("../../../src/surreal/cli/struct"),
      { defineFunction, defineTable, s, surql } = await import("../../../src/surreal"),
      // Multi-line authored function body (single-line in INFO).
      F = defineFunction("nws_fn", { a: s.string() })
        .returns(s.string())
        .body(
          ({ a }) => surql`{
          LET $x = string::concat(
            'pre-',
            ${a}
          );
          RETURN $x;
        }`,
        ),
      // Event THEN whose IF branch holds a MULTI-STATEMENT block (INFO prints it with newlines).
      T = defineTable("nws_t", { n: s.number() }),
      TV = T.event("nws_ev", {
        when: (e) => e.event.eq("CREATE"),
        then: surql`{
        IF $after.n > 1 {
          LET $y = $after.n + 1;
          UPDATE nws_t SET n = $y WHERE id = $after.id;
        };
      }`,
      }),
      c = new Surreal()
    await c.connect(URL!)
    await c.signin({
      username: process.env.SURREAL_USER ?? "root",
      password: process.env.SURREAL_PASS ?? "root",
    })
    await c.use({ namespace: "nws", database: "nws" })
    await c.query("REMOVE TABLE IF EXISTS nws_t; REMOVE FUNCTION IF EXISTS fn::nws_fn;")
    await c.query(emitDefStatement(F, { exists: "overwrite" }).ddl)
    await c.query(emitTable(TV, { exists: "overwrite" }))

    const scrub = (v: unknown) => JSON.parse(JSON.stringify(v)),
      authored = explodeSchema([TV], [F]),
      live = await introspectAll(c)
    for (const [kind, name] of [
      ["function", "nws_fn"],
      ["table", "nws_t"],
    ] as const) {
      const a = authored.find((o) => o.kind === kind && o.name === name) as {
          native?: unknown
          struct?: unknown
        },
        l = live.find((o) => o.kind === kind && o.name === name) as {
          native?: unknown
          struct?: unknown
        }
      expect(deepEqual(scrub(a.native ?? a.struct), scrub(l.native ?? l.struct))).toBe(true)
    }

    await c.query("REMOVE TABLE IF EXISTS nws_t; REMOVE FUNCTION IF EXISTS fn::nws_fn;")
    await c.close()
  }, 60_000)
})
