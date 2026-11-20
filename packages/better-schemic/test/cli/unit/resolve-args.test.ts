// `--args`/`--arg` parsing: k=v sugar merges over the JSON object, and reserved keys reject them
// (a `__proto__` payload would otherwise mutate the resolver-args prototype).
import { describe, expect, test } from "bun:test"

import { parseArgs } from "../../../src/cli/resolve"

describe("parseArgs", () => {
  test("k=v entries merge over the JSON object", () => {
    expect(parseArgs(["b=2"], '{"a":1}')).toEqual({ a: 1, b: "2" })
    expect(parseArgs(["x=hello=world"])).toEqual({ x: "hello=world" })
    expect(parseArgs(undefined, undefined)).toEqual({})
  })

  test("rejects malformed JSON and non-objects", () => {
    expect(() => parseArgs(undefined, "{oops")).toThrow(/JSON object/u)
    expect(() => parseArgs(undefined, "[1,2]")).toThrow(/JSON object/u)
    expect(() => parseArgs(undefined, "null")).toThrow(/JSON object/u)
    expect(() => parseArgs(["novalue"])).toThrow(/key=value/u)
  })

  test("rejects reserved keys (prototype pollution)", () => {
    expect(() => parseArgs(undefined, '{"__proto__":{"admin":true}}')).toThrow(/reserved/u)
    expect(() => parseArgs(undefined, '{"constructor":{}}')).toThrow(/reserved/u)
    expect(() => parseArgs(["prototype=x"])).toThrow(/reserved/u)
    // The returned object stays plain.
    const out = parseArgs(undefined, '{"ok":1}')
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { admin?: unknown }).admin).toBeUndefined()
  })
})
