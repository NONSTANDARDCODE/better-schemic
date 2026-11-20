// s.jsonValue<T>() type surface: app value parses to T, wire value is the JSON string.
// Type-checked by `bun check`; mirrors the style of aot-raw-json.assert.ts.
import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { type App, s, table, type Wire } from "../../../src/surreal"

type Payload = { n: number }

const J = table("json_value_types", {
  legacy: s.json<Payload>(),
  parsed: s.jsonValue<Payload>(),
})

describe("s.jsonValue<T>() types", () => {
  it("App is T and Wire is the JSON string", () => {
    assertType<Payload, App<typeof J>["parsed"]>()
    assertType<string, Wire<typeof J>["parsed"]>()
  })

  it("legacy s.json<T>() keeps its cast surface (App and Wire both T)", () => {
    assertType<Payload, App<typeof J>["legacy"]>()
    assertType<Payload, Wire<typeof J>["legacy"]>()
  })
})
