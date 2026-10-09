// `--args`/`--arg` parsing: k=v sugar merges over the JSON object, and reserved keys are rejected
// (a `__proto__` payload would otherwise mutate the resolver-args prototype).
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli/resolve";

describe("parseArgs", () => {
  test("k=v entries merge over the JSON object", () => {
    expect(parseArgs(["b=2"], '{"a":1}')).toEqual({ a: 1, b: "2" });
    expect(parseArgs(["x=hello=world"])).toEqual({ x: "hello=world" });
    expect(parseArgs(undefined, undefined)).toEqual({});
  });

  test("rejects malformed JSON and non-objects", () => {
    expect(() => parseArgs(undefined, "{oops")).toThrow(/JSON object/);
    expect(() => parseArgs(undefined, "[1,2]")).toThrow(/JSON object/);
    expect(() => parseArgs(undefined, "null")).toThrow(/JSON object/);
    expect(() => parseArgs(["novalue"])).toThrow(/key=value/);
  });

  test("rejects reserved keys (prototype pollution)", () => {
    expect(() => parseArgs(undefined, '{"__proto__":{"admin":true}}')).toThrow(
      /reserved/,
    );
    expect(() => parseArgs(undefined, '{"constructor":{}}')).toThrow(
      /reserved/,
    );
    expect(() => parseArgs(["prototype=x"])).toThrow(/reserved/);
    // The returned object stays plain.
    const out = parseArgs(undefined, '{"ok":1}');
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { admin?: unknown }).admin).toBeUndefined();
  });
});
