import { describe, expect, test } from "bun:test";
import type { PortableType } from "@better-schemic/core";
import { normalizeType } from "../../src/cli/struct";
import { emitSurqlType, parseSurqlType } from "../../src/driver/surql-type";

// Milestone 2 LOSSLESS proof: the SurrealQL type string <-> PortableType bridge must round-trip, so
// flipping diff equality to a structured deep-compare over PortableType can't produce false negatives
// (a missed migration). Two invariants: (1) emit∘parse reproduces the canonical SurrealQL spelling
// (== normalizeType), and (2) parse∘emit is identity on PortableType.

// Canonical kind strings (the form normalizeType produces) the engine actually emits/introspects.
const CANONICAL = [
  "string",
  "int",
  "float",
  "decimal",
  "number",
  "bool",
  "datetime",
  "duration",
  "uuid",
  "bytes",
  "any",
  "object",
  "null",
  "option<int>",
  "option<string>",
  "array<string>",
  "array<int, 3>",
  "set<string>",
  "set<float, 2>",
  "array<record<user>>",
  "array<object>",
  "record<user>",
  "record<account | user>",
  "geometry<point>",
  "geometry<polygon>",
  "range",
  "'admin'",
  "'a' | 'b'",
  "null | string",
  "option<null | string>",
  "references<user>",
  "none",
  "array<none>",
  // A top-level union whose first member is `option<…>` and last ends with `>` — the greedy
  // `option<…>` regex must not swallow it (round-trip regression).
  "option<int> | string",
  // A nullable union: `null` sorts as a FLAT member (`array<…> | null | set<…>`), not appended last.
  "array<int> | null | set<string>",
];

describe("surql-type bridge (Milestone 2 losslessness)", () => {
  test("emit∘parse reproduces the canonical SurrealQL spelling", () => {
    for (const kind of CANONICAL) {
      expect(emitSurqlType(parseSurqlType(kind))).toBe(kind);
    }
  });

  test("parse∘emit is identity on PortableType", () => {
    for (const kind of CANONICAL) {
      const p = parseSurqlType(kind);
      expect(parseSurqlType(emitSurqlType(p))).toEqual(p);
    }
  });

  test("agrees with normalizeType on non-canonical input (the canonicalizer's job)", () => {
    const cases: [string, string][] = [
      // union member ordering
      ["user | account", "account | user"],
      ["record<user | account>", "record<account | user>"],
      // a `none` union member folds into option<…>
      ["string | none", "option<string>"],
      // double-quoted literal -> single-quoted
      ['"admin"', "'admin'"],
      // nullable canonical form (null sorts first)
      ["string | null", "null | string"],
    ];
    for (const [input, canonical] of cases) {
      expect(emitSurqlType(parseSurqlType(input))).toBe(
        normalizeType(canonical),
      );
      // and the bridge's own output matches the engine's canonicalizer
      expect(emitSurqlType(parseSurqlType(input))).toBe(normalizeType(input));
    }
  });

  test("literal atoms: numbers, booleans and double-quoted strings", () => {
    // non-string literals exercise the emit side that isn't a quoted string.
    expect(emitSurqlType(parseSurqlType("42"))).toBe("42");
    expect(emitSurqlType(parseSurqlType("-3.5"))).toBe("-3.5");
    expect(emitSurqlType(parseSurqlType("true"))).toBe("true");
    expect(emitSurqlType(parseSurqlType("false"))).toBe("false");
    // a double-quoted literal parses identically to its single-quoted spelling.
    expect(parseSurqlType('"admin"')).toEqual(parseSurqlType("'admin'"));
  });

  test("peculiar inputs fall through cleanly", () => {
    // a union of ONLY none/null: no rest members → option<…> around the empty/nullable bottom.
    expect(emitSurqlType(parseSurqlType("none | null"))).toBe(
      "option<none | null>",
    );
    // an unknown geometry kind stays a Surreal-native escape hatch (not a geometry node).
    expect(emitSurqlType(parseSurqlType("geometry<bogus>"))).toBe(
      "geometry<bogus>",
    );
  });

  test("a tag outside the PortableType union is a hard error (exhaustive switch)", () => {
    // The switch is exhaustive; this guards against a value smuggled in via `any`/a stale cast, so
    // a dialect mismatch fails loudly instead of emitting a silently-wrong type.
    expect(() =>
      emitSurqlType({ t: "bogus" } as unknown as PortableType),
    ).toThrow("unhandled portable type: bogus");
  });
});
