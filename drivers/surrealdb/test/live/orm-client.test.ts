// M0.5 — the /orm bootstrap against a REAL server: managed `createBetterSchemic` (connect + auth +
// namespace/database), the managed-close rule, and `forkSession`. Ephemeral server; skipped when no
// `surreal` binary is available.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { createBetterSchemic } from "../../src/orm/connect";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-client] `surreal` binary unavailable — skipping");

const User = defineTable("oc_user", { name: s.string(), age: s.int() });
const schema = defineSchema({ users: User });

live("orm client — live", () => {
  let server: EphemeralServer;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  test("createBetterSchemic connects, authenticates and exposes the delegates", async () => {
    const client = await createBetterSchemic({
      url: server.url,
      namespace: "orm_client",
      database: "live",
      auth: { username: server.username, password: server.password },
      schema,
    });
    expect(client.users.$model.name).toBe("oc_user");
    await client.$sdk.query(
      "REMOVE TABLE IF EXISTS oc_user; CREATE oc_user SET name = 'ada', age = 36;",
    );
    const [rows] = (await client.$sdk.query(
      "SELECT name, age FROM oc_user",
    )) as [{ name: string; age: number }[]];
    expect(rows).toEqual([{ name: "ada", age: 36 }]);
    await client.close();
    // The managed client closed the connection it opened. (`await expect(...).rejects` hangs on the
    // SDK's Query thenable after close, so capture the rejection explicitly.)
    const closed = await client.$sdk
      .query("RETURN 1")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(Error);
  });

  test("a BYO client never closes the caller's connection", async () => {
    const { Surreal } = await import("surrealdb");
    const conn = new Surreal();
    await conn.connect(server.url, { reconnect: false });
    await conn.signin({
      username: server.username,
      password: server.password,
    });
    await conn.use({ namespace: "orm_client", database: "byo" });

    const client = betterSchemic(conn, { schema });
    await client.close();
    // Still usable after close(): we don't own it.
    expect(await conn.query("RETURN 1")).toEqual([1]);
    await conn.close();
  });

  test("forkSession() scopes a session; closing the fork leaves the parent open", async () => {
    const client = await createBetterSchemic({
      url: server.url,
      namespace: "orm_client",
      database: "fork",
      auth: { username: server.username, password: server.password },
      schema,
    });
    const forked = await client.forkSession();
    expect(forked.$sdk).not.toBe(client.$sdk);
    expect(forked.users.$model.key).toBe("users");
    expect(await forked.$sdk.query("RETURN 1")).toEqual([1]);
    await forked.close();
    // The parent still works after its fork was disposed.
    expect(await client.$sdk.query("RETURN 1")).toEqual([1]);
    await client.close();
  });
});
