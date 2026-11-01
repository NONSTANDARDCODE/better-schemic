/**
 * SYNTAX COVERAGE — every permutation of a `DEFINE …` statement emits EXACTLY its pinned DDL.
 * `def` is real, tsc-checked authoring; emitting it must equal the documented `ddl`. A table goes
 * through `emitTable`, a standalone def (event / function / access / analyzer) through
 * `emitDefStatement`. Pure emit (no live DB); round-trip fidelity is covered by `test/parity/*`.
 */
import { describe, expect, test } from "bun:test";
import { allCoverage } from "../../../coverage";
import type { AnyDef } from "../../../coverage/_kit";
import { type DefineOptions, emitDefStatement, emitTable } from "../../../src/surreal/ddl";
import { TableDef } from "../../../src/surreal/pure";

/** Emit a coverage `def` with the right emitter for its kind. */
function emitCoverage(def: AnyDef, options?: DefineOptions): string {
  return def instanceof TableDef
    ? emitTable(def, options)
    : emitDefStatement(def, options).ddl;
}

describe("DEFINE-statement syntax coverage", () => {
  for (const group of allCoverage) {
    describe(group.syntax, () => {
      for (const item of group.items) {
        test(item.title, () => {
          expect(emitCoverage(item.def, item.options)).toBe(item.ddl);
          expect(item.code.trim().length).toBeGreaterThan(0);
        });
      }
    });
  }

  test("every group has at least one permutation", () => {
    for (const group of allCoverage) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});
