// Bun AOT — typed JSON payloads and typed raw bindings/results. Type-checked by `bun check`.
import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { type App, s, selectQuery, surqlWith, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"

const Log = table("log", {
  payload: s.json<{ tool: string; ms: number }>(),
  untyped: s.json(),
})
const schemaDef = schema({ logs: Log })
declare const client: Client<typeof schemaDef>

describe("AOT — raw/json boundary", () => {
  it("s.json<T>() gives a fixed decoder shape", () => {
    assertType<{ tool: string; ms: number }, App<typeof Log>["payload"]>()
  })

  it("$query infers bindings and result rows from surqlWith", () => {
    const q = surqlWith<{ limit: number }, Array<{ score: number }>>(
      "SELECT score FROM x LIMIT $limit",
      { limit: 10 },
    )
    assertType<{ limit: number }, typeof q.$bindings>()
    const rows = client.$query(q)
    assertType<Promise<Array<{ score: number }>>, typeof rows>()
  })

  it("selectQuery derives fixed row keys (and app types) from the allowlist", () => {
    const rows = client.$query(selectQuery(Log, ["payload"] as const))
    assertType<Promise<Array<Pick<App<typeof Log>, "payload">>>, typeof rows>()
  })
})
