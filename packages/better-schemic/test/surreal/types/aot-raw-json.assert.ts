import { describe, it } from "node:test"

import { assertType } from "../../../../../scripts/type-assert"
import { type App, s, selectQuery, surqlWith, table } from "../../../src/surreal"
import type { Client } from "../../../src/surreal/orm/client"
import { schema } from "../../../src/surreal/orm/schema"

// Bun AOT — typed JSON payloads and typed raw bindings/results. Type-checked by `bun check`.

const Log = table("log", {
  payload: s.json<{ ms: number; tool: string }>(),
  untyped: s.json(),
})
const _schemaDef = schema({ logs: Log })
declare const client: Client<typeof _schemaDef>

void describe("AOT — raw/json boundary", () => {
  void it("s.json<T>() gives a fixed decoder shape", () => {
    assertType<{ ms: number; tool: string }, App<typeof Log>["payload"]>()
  })

  void it("$query infers bindings and result rows from surqlWith", () => {
    const q = surqlWith<{ limit: number }, { score: number }[]>(
      "SELECT score FROM x LIMIT $limit",
      { limit: 10 },
    )
    assertType<{ limit: number }, typeof q.$bindings>()
    const _rowss = client.$query(q)
    assertType<Promise<{ score: number }[]>, typeof _rowss>()
  })

  void it("selectQuery derives fixed row keys (and app types) from the allowlist", () => {
    const _rowss = client.$query(selectQuery(Log, ["payload"] as const))
    assertType<Promise<Pick<App<typeof Log>, "payload">[]>, typeof _rowss>()
  })
})
