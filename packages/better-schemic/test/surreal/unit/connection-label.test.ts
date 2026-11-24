/* eslint-disable perfectionist/sort-objects -- Object key order mirrors expected serialized output and must stay as authored. */
// The `surrealConnection` entry's display label: `ns/db @ url`, degrading to the connection name
// when the config carries neither namespace/database nor a url.
import { defineConfig } from "better-schemic/config"
import { resolveFromConfig } from "better-schemic/core"
import { describe, expect, test } from "bun:test"

import { surrealConnection } from "../../../src/surreal/connection"

describe("surrealConnection label", () => {
  test("ns/db @ url when present", async () => {
    const config = defineConfig({
      connections: {
        main: surrealConnection({
          schema: "./s",
          url: "ws://localhost:8000/rpc",
          namespace: "app",
          database: "main",
        }),
      },
    })
    const r = await resolveFromConfig(config, "/proj", { name: "main" })
    expect(r.labels).toEqual(["app/main @ ws://localhost:8000/rpc"])
  })
})
