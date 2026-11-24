/* eslint-disable @typescript-eslint/explicit-function-return-type -- callbacks de teste: tipo inferido pelo saturador de assercoes; anotar cada um geraria ruido sem valor. */
// s.jsonValue<T>() — a JSON column that actually parses the JSON string into T on decode.
import { describe, expect, test } from "bun:test"

import { emitTable } from "../../../src/surreal/ddl"
import { s, table } from "../../../src/surreal/pure"

type Payload = { n: number }

const fieldLine = (t: Parameters<typeof emitTable>[0], name: string): string | undefined =>
  emitTable(t)
    .split("\n")
    .find((l) => l.includes(` ${name} `))
    ?.trim()

describe("s.jsonValue<T>() — decode / encode", () => {
  test("decode parses a JSON string into T", () => {
    expect(s.jsonValue<Payload>().decode('{"n":1}')).toEqual({ n: 1 })
  })

  test("encode stringifies the app value into a JSON string", () => {
    const encoded = s.jsonValue<Payload>().encode({ n: 1 })
    expect(typeof encoded).toBe("string")
    expect(encoded).toBe('{"n":1}')
  })

  test("decode(encode(value)) round-trips", () => {
    const f = s.jsonValue<Payload>()
    expect(f.decode(f.encode({ n: 1 }))).toEqual({ n: 1 })
  })

  test("invalid JSON fails via safeDecode with a Zod issue (not a raw SyntaxError)", () => {
    const r = s.jsonValue<Payload>().safeDecode("not json")
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toContain("Invalid JSON")
  })

  test("non-string JSON values fail via safeDecode", () => {
    const f = s.jsonValue<Payload>()
    expect(f.safeDecode(Number("5")).success).toBe(false)
    expect(f.safeDecode({ n: 1 }).success).toBe(false)
    expect(f.safeDecode(null).success).toBe(false)
  })

  test("legacy s.json() / s.json<T>() still decode to the STRING (unchanged)", () => {
    expect(s.json().decode('{"n":1}')).toBe('{"n":1}')
    // The legacy cast claims `Payload`; at runtime it yields the raw JSON string.
    expect(s.json<Payload>().decode('{"n":1}') as unknown).toBe('{"n":1}')
  })
})

describe("s.jsonValue<T>() — DDL parity", () => {
  test("emits the same JSON-union column as s.json() and s.json<T>()", () => {
    const J = table("json_value_t", {
      id: s.string(),
      legacy: s.json<Payload>(),
      parsed: s.jsonValue<Payload>(),
      plain: s.json(),
    })
    const typeOf = (name: string) => fieldLine(J, name)?.split(" TYPE ")[1]
    const plain = typeOf("plain")
    expect(plain).toBeDefined()
    expect(typeOf("legacy")).toBe(plain)
    expect(typeOf("parsed")).toBe(plain)
    expect(plain).toBe("string | number | bool | null | array<any> | object;")
  })
})
