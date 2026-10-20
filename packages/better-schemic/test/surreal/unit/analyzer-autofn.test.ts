import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../../../src/surreal/cli/surreal-diff";
import { surql } from "../../../src/surreal";
import { defineAnalyzer, defineFunction, s } from "../../../src/surreal/pure";

// An analyzer's inline `.function(input => surql`…`)` auto-defines an `<analyzer>_fn` function. That
// function must be emitted as its own DEFINE FUNCTION (the analyzer references it) — and an auto-name
// colliding with an already-defined function must be caught, not silently clobbered.
describe("analyzer inline .function(cb) auto-defines fn::<analyzer>_fn", () => {
  const az = defineAnalyzer("custom")
    .function((input) => surql`string::lowercase(${input})`)
    .tokenizers("blank");

  const stmts = (...defs: unknown[]) =>
    buildSnapshot([], defs as Parameters<typeof buildSnapshot>[1]).statements;

  test("emits the DEFINE FUNCTION, before the DEFINE ANALYZER that references it", () => {
    const snap = stmts(az);
    const keys = Object.keys(snap);
    expect(snap["function::custom_fn"]?.ddl).toContain(
      "DEFINE FUNCTION fn::custom_fn($input: string)",
    );
    expect(snap["analyzer::custom"]?.ddl).toContain("FUNCTION fn::custom_fn");
    // function precedes the analyzer (the analyzer's FUNCTION clause depends on it existing first)
    expect(keys.indexOf("function::custom_fn")).toBeLessThan(
      keys.indexOf("analyzer::custom"),
    );
  });

  test("a custom name (second arg) overrides the auto `<analyzer>_fn` name", () => {
    const named = defineAnalyzer("custom")
      .function((input) => surql`string::lowercase(${input})`, "lower_tok")
      .tokenizers("blank");
    const snap = stmts(named);
    expect(snap["function::lower_tok"]?.ddl).toContain(
      "DEFINE FUNCTION fn::lower_tok($input: string)",
    );
    expect(snap["analyzer::custom"]?.ddl).toContain("FUNCTION fn::lower_tok");
    expect(snap["function::custom_fn"]).toBeUndefined();
  });

  test("throws when the auto-name collides with a different function", () => {
    const clashing = defineFunction("custom_fn", { input: s.string() }).body(
      surql`RETURN $input`,
    );
    expect(() => stmts(clashing, az)).toThrow(
      /analyzer "custom" auto-defines fn::custom_fn .* a different function fn::custom_fn already exists/,
    );
  });

  test("dedupes when an identical function of the same name is also defined", () => {
    const identical = defineFunction("custom_fn", { input: s.string() }).body(
      surql`string::lowercase($input)`,
    );
    const snap = stmts(identical, az);
    expect(
      Object.keys(snap).filter((k) => k.startsWith("function::")),
    ).toHaveLength(1);
  });
});
