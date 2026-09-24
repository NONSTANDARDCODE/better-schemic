// The Tier-2 MC/DC engine (`analyzeMcdc` / `describeMcdc`) — correctness of the unique-cause pair
// search: full truth tables, explicit cases, redundancy detection and the input guards.
import { describe, expect, test } from "bun:test";
import { analyzeMcdc, describeMcdc } from "@better-schemic/core/testing";

describe("analyzeMcdc", () => {
  test("a genuine conjunction has a pair for every condition", () => {
    const r = analyzeMcdc({
      label: "and",
      conditions: ["a", "b"],
      evaluate: ({ a, b }) => a && b,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.independent.map((p) => p.condition).sort()).toEqual(["a", "b"]);
    expect(r.assignments).toHaveLength(4);
    // Each pair differs ONLY in its condition and flips the outcome.
    for (const p of r.independent) {
      const [x, y] = p.pair;
      const diff = x.map((v, i) => v !== y[i]);
      expect(diff.filter(Boolean)).toHaveLength(1);
      expect(p.outcomes[0]).not.toBe(p.outcomes[1]);
    }
  });

  test("a disjunction of three has all three independent", () => {
    const r = analyzeMcdc({
      label: "or3",
      conditions: ["a", "b", "c"],
      evaluate: ({ a, b, c }) => a || b || c,
    });
    expect(r.ok).toBe(true);
    expect(r.independent).toHaveLength(3);
  });

  test("a redundant condition has no independence pair", () => {
    const r = analyzeMcdc({
      label: "redundant",
      conditions: ["a", "b"],
      evaluate: ({ a }) => a,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["b"]);
    expect(r.independent.map((p) => p.condition)).toEqual(["a"]);
  });

  test("explicit cases reflect REAL coverage, not the full table", () => {
    const all = analyzeMcdc({
      label: "and",
      conditions: ["a", "b"],
      evaluate: ({ a, b }) => a && b,
    });
    expect(all.ok).toBe(true);
    // Only the rows a real suite might exercise; with `b` never true, neither condition can flip.
    const partial = analyzeMcdc({
      label: "and-partial",
      conditions: ["a", "b"],
      cases: [
        [false, false],
        [true, false],
      ],
      evaluate: ({ a, b }) => a && b,
    });
    expect(partial.ok).toBe(false);
    expect(partial.missing).toEqual(["a", "b"]);
  });

  test("input guards: no conditions, too many, duplicate names, mis-sized case", () => {
    expect(() =>
      analyzeMcdc({ label: "x", conditions: [], evaluate: () => true }),
    ).toThrow(/at least one/);
    expect(() =>
      analyzeMcdc({
        label: "x",
        conditions: Array.from({ length: 9 }, (_, i) => `c${i}`),
        evaluate: () => true,
      }),
    ).toThrow(/limit/);
    expect(() =>
      analyzeMcdc({
        label: "x",
        conditions: ["a", "a"],
        evaluate: () => true,
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      analyzeMcdc({
        label: "x",
        conditions: ["a", "b"],
        cases: [[true]],
        evaluate: () => true,
      }),
    ).toThrow(/case has/);
  });
});

describeMcdc({
  label: "a && (b || c)",
  conditions: ["a", "b", "c"],
  evaluate: ({ a, b, c }) => a && (b || c),
});
