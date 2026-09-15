/**
 * Verifies the @better-schemic/surrealdb REFERENCE example cookbook (`examples/*`): every catalog entry must
 * emit EXACTLY its documented `ddl`. Each entry's `defs` are DERIVED from its `code` snippet (see
 * `examples/_kit.ts#ex`), so `expect(emit(defs)).toBe(ddl)` is exactly `emit(eval(code)) === ddl` — the
 * strongest honesty check: `code`, `defs`, and `ddl` cannot disagree. Change the emitter and this fails
 * until the reference is updated, so the docs can never lie about the DDL.
 *
 * Pure emit (no live database). Round-trip fidelity (apply -> introspect -> diff = 0, and `pull`
 * regeneration) is covered by the live parity suites under `test/parity/*` against SurrealDB 3.1.3.
 */
import { describe, expect, test } from "bun:test";
import { allGroups, emit } from "../../examples";

describe("reference cookbook: authoring -> DDL", () => {
  for (const group of allGroups) {
    describe(group.file, () => {
      for (const example of group.examples) {
        test(example.title, () => {
          // `defs` are eval(code), so this asserts emit(eval(code)) === ddl (code/defs/ddl agree).
          expect(emit(example.defs)).toBe(example.ddl);
          // `code` is the verbatim authoring rendered in docs / the website gallery — must be present.
          expect(example.code.trim().length).toBeGreaterThan(0);
        });
      }
    });
  }

  test("every group has at least one example", () => {
    for (const group of allGroups) {
      expect(group.examples.length).toBeGreaterThan(0);
    }
  });
});
