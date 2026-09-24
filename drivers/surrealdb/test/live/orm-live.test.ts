// M4.2 — live queries end-to-end: subscribe (handler + async iterator), decode, diff patches, FETCH,
// kill and reattach (`liveOf`); HTTP connections fail with LiveQueryUnsupported and live inside a
// transaction with LiveInTransaction. Ephemeral server; skipped without a `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import type { LiveNotification } from "../../src/orm/types/live";
import { caught } from "../orm-fixtures";
import { startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-live] `surreal` binary unavailable — skipping");

const UserBase = defineTable("lv_user", {
  name: s.string(),
  active: s.boolean(),
});
const User = UserBase.extend({
  friend: s.recordId(() => UserBase).optional(),
});
const schema = defineSchema({ users: User });

live("orm live — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (done: () => boolean, ms = 8_000): Promise<boolean> => {
    const until = Date.now() + ms;
    while (!done() && Date.now() < until) await sleep(25);
    return done();
  };

  beforeAll(async () => {
    const started = await startLiveServer({
      namespace: "orm_live",
      database: "live",
      ddl: `
        DEFINE TABLE lv_user SCHEMAFULL;
        DEFINE FIELD name ON lv_user TYPE string;
        DEFINE FIELD active ON lv_user TYPE bool;
        DEFINE FIELD friend ON lv_user TYPE option<record<lv_user>>;
        CREATE lv_user:a CONTENT { name: "A", active: true };
        CREATE lv_user:b CONTENT { name: "B", active: false };
      `,
    });
    server = started.server;
    db = started.db;
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("handler receives decoded CREATE/UPDATE/DELETE notifications", async () => {
    type Change = Extract<
      LiveNotification<{ id: RecordId; name: string }>,
      { action: "CREATE" | "UPDATE" | "DELETE" | "KILLED" }
    >;
    const seen: Change[] = [];
    const sub = await client.users.live(
      { where: { active: true } },
      (change) => {
        if (change.action !== "RECONNECTED") seen.push(change as Change);
      },
    );
    await client.users.create({
      data: { id: "lv_user:c", name: "C", active: true },
    });
    await client.users.update({
      where: { id: "lv_user:c" },
      data: { name: "C2" },
    });
    await client.users.delete({ where: { id: "lv_user:c" } });
    await waitFor(() => seen.length >= 3);
    await sub.kill();
    expect(seen.map((c) => c.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
    expect(seen[0]?.recordId).toEqual(new RecordId("lv_user", "c"));
    expect(seen[0]?.value).toMatchObject({ name: "C" });
    expect(seen[1]?.value).toMatchObject({ name: "C2" });
  });

  test("async iterator yields notifications until kill", async () => {
    const sub = await client.users.live({ where: { active: true } });
    const received: string[] = [];
    const consume = (async () => {
      for await (const change of sub) {
        received.push(change.action);
        if (received.length >= 2) await sub.kill();
      }
    })();
    await client.users.create({
      data: { id: "lv_user:d", name: "D", active: true },
    });
    await client.users.update({
      where: { id: "lv_user:d" },
      data: { name: "D2" },
    });
    await waitFor(() => received.length >= 2);
    await consume;
    expect(received).toEqual(["CREATE", "UPDATE"]);
    await client.users.delete({ where: { id: "lv_user:d" } });
  });

  test("diff: true delivers JSON Patch ops instead of the row", async () => {
    const patches: unknown[] = [];
    const sub = await client.users.live({ diff: true }, (change) => {
      if (change.action === "UPDATE") patches.push(change.diff);
    });
    await client.users.create({
      data: { id: "lv_user:e", name: "E", active: true },
    });
    await client.users.update({
      where: { id: "lv_user:e" },
      data: { name: "E2" },
    });
    await waitFor(() => patches.length >= 1);
    await sub.kill();
    expect(patches[0]).toEqual([
      expect.objectContaining({ op: "change", path: "/name" }),
    ]);
  });

  test("fetch materializes the link on the notified row", async () => {
    const seen: LiveNotification<{ friend?: RecordId }>[] = [];
    const sub = await client.users.live(
      { where: { name: "A" }, fetch: ["friend"] },
      (change) => {
        if (change.action === "UPDATE")
          seen.push(change as LiveNotification<{ friend?: RecordId }>);
      },
    );
    await client.users.update({
      where: { id: "lv_user:a" },
      data: { friend: new RecordId("lv_user", "b") },
    });
    await waitFor(() => seen.length >= 1);
    await sub.kill();
    expect(seen[0]?.value?.friend).toEqual(
      expect.objectContaining({ name: "B" }),
    );
  });

  test("client.kill(uuid) ends the live on the server; liveOf reattaches raw", async () => {
    const seen: unknown[] = [];
    const sub = await client.users.live({}, (change) => {
      seen.push(change);
    });
    const reattached: unknown[] = [];
    const other = await client.liveOf(sub.uuid, (change) => {
      reattached.push(change);
    });
    await client.users.create({
      data: { id: "lv_user:f", name: "F", active: true },
    });
    await waitFor(() => seen.length >= 1 && reattached.length >= 1);
    await client.kill(sub.uuid);
    expect(other.isAlive).toBe(true);
    const before = seen.length;
    await client.users.update({
      where: { id: "lv_user:f" },
      data: { name: "F2" },
    });
    await sleep(300);
    expect(seen.length).toBe(before);
    await other.kill();
    await client.users.delete({ where: { id: "lv_user:f" } });
  });

  test("HTTP connections answer LiveQueryUnsupported", async () => {
    const http = new Surreal();
    await http.connect(server.url.replace("ws://", "http://"), {
      reconnect: false,
    });
    await http.signin({ username: server.username, password: server.password });
    await http.use({ namespace: "orm_live", database: "live" });
    const httpClient = betterSchemic(http, { schema });
    const err = await caught(() =>
      httpClient.users.live({ where: { active: true } }),
    );
    expect(isBetterSchemicError(err)).toBe(true);
    expect((err as { code?: string }).code).toBe("LiveQueryUnsupported");
    await http.close();
  });

  test("live inside a transaction fails with LiveInTransaction", async () => {
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await tx.users.live();
      }),
    );
    expect((err as { code?: string }).code).toBe("LiveInTransaction");
  });
});
