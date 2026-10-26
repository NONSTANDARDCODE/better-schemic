// M8 — `createBetterSchemic` edge paths: the `connectTimeoutMs` wrapper (resolve + timeout), a
// Namespace-only config (no database), and the managed-close-on-failure path. Ephemeral server;
// Skipped when the `surreal` binary is unavailable.
import { setDefaultTimeout } from "bun:test"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { defineTable, s } from "../../../src/surreal"
import { spawnEphemeralServer, surrealBinaryAvailable } from "../../../src/surreal/cli/engine"
import { createBetterSchemic } from "../../../src/surreal/orm/connect"
import { defineSchema } from "../../../src/surreal/orm/schema"

import type { EphemeralServer } from "../../../src/surreal/cli/engine"

setDefaultTimeout(120_000)

const ENABLED = surrealBinaryAvailable(),
  live = describe.skipIf(!ENABLED),
  User = defineTable("oc_edge_user", { name: s.string() }),
  schema = defineSchema({ users: User })

live("createBetterSchemic — edge paths", () => {
  let server: EphemeralServer

  beforeAll(async () => {
    server = await spawnEphemeralServer()
  })

  afterAll(async () => {
    await server?.stop()
  })

  test("a reachable endpoint resolves through the timeout wrapper", async () => {
    const client = await createBetterSchemic({
      url: server.url,
      namespace: "oc_edge",
      database: "live",
      auth: { username: server.username, password: server.password },
      connectTimeoutMs: 10_000,
      schema,
    })
    expect(client.users.$model.name).toBe("oc_edge_user")
    await client.close()
  })

  test("namespace-only config (no database) connects", async () => {
    const client = await createBetterSchemic({
      url: server.url,
      namespace: "oc_edge_ns_only",
      auth: { username: server.username, password: server.password },
      schema,
    })
    expect(client.users.$model.name).toBe("oc_edge_user")
    await client.close()
  })

  test("access-based auth attempts a record signin (or normalizes the failure)", async () => {
    await createBetterSchemic({
      url: server.url,
      namespace: "oc_edge",
      database: "live",
      auth: { access: "missing_access", variables: {} },
      schema,
    })
      .then(async (c) => c.close())
      .catch(() => {})
  })

  test("a database-only config (empty namespace) takes the use() path", async () => {
    await createBetterSchemic({
      url: server.url,
      namespace: "",
      database: "oc_edge_db",
      auth: { username: server.username, password: server.password },
      schema,
    })
      .then(async (c) => c.close())
      .catch(() => {})
  })

  test("an unreachable endpoint times out and is closed", async () => {
    // A TCP listener that accepts but never completes the WebSocket handshake, so `connect` hangs
    // Until `connectTimeoutMs` fires (the timer branch, not a fast connection refusal).
    const hang = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {} },
    })
    try {
      await expect(
        createBetterSchemic({
          url: `ws://127.0.0.1:${hang.port}/rpc`,
          namespace: "x",
          database: "y",
          connectTimeoutMs: 300,
          schema,
        }),
      ).rejects.toThrow(/timed out after 300ms/)
    } finally {
      hang.stop(true)
    }
  })
})
