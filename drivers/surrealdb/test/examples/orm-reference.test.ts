/**
 * Verifies the @better-schemic/surrealdb ORM reference cookbook (`examples/orm/*`): every entry's `def`
 * must emit EXACTLY its documented `{ sql, vars }`. `capture` re-runs the real delegate over a recording
 * fake connection, so `code`, the run, and the golden cannot disagree — the same honesty invariant the
 * schema cookbook (`reference.test.ts`) uses, with a runtime statement instead of DDL.
 *
 * Pure compile+run (no live database). Round-trip fidelity (decoded rows, server semantics) is covered
 * by the live suites under `test/live/*` against SurrealDB 3.2.0.
 */
import { describe, expect, test } from "bun:test";
import { allOrmGroups, capture } from "../../examples/orm";

describe("ORM cookbook: delegate call -> runtime SurrealQL", () => {
  for (const group of allOrmGroups) {
    describe(group.file, () => {
      for (const example of group.examples) {
        test(example.title, async () => {
          const got = await capture(example);
          expect(got).toEqual({ sql: example.sql, vars: example.vars });
          // `code` is the verbatim delegate call rendered in docs / the gallery — must be present.
          expect(example.code.trim().length).toBeGreaterThan(0);
        });
      }
    });
  }

  test("every group has at least one example", () => {
    for (const group of allOrmGroups) {
      expect(group.examples.length).toBeGreaterThan(0);
    }
  });
});
