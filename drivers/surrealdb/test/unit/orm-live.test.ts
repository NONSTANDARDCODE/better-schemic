// M4.2 — the live-query runtime over a recording fake: compilation (LIVE SELECT forms), message
// decode, diff, handler/iterator fan-out, kill, reconnect (`RECONNECTED`) and the error routes.
import { describe, expect, test } from "bun:test";
import { RecordId, Uuid } from "surrealdb";
import { betterSchemic } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { caught, lines, ok } from "../orm-fixtures";

const UserBase = defineTable("user", { name: s.string() });
const User = UserBase.extend({
  mentor: s.recordId(() => UserBase).optional(),
});
const schema = defineSchema({ users: User });

interface LiveMessage {
  readonly queryId: Uuid;
  readonly action: "CREATE" | "UPDATE" | "DELETE" | "KILLED";
  readonly recordId: RecordId;
  readonly value: unknown;
}

/** A fake SDK live subscription: records kills, fans messages out to its subscribers. */
function fakeSub(id: Uuid) {
  const subscribers = new Set<(message: LiveMessage) => void>();
  const sub = {
    id,
    isAlive: true,
    killed: 0,
    kill() {
      sub.killed++;
      sub.isAlive = false;
      return Promise.resolve();
    },
    subscribe(handler: (message: LiveMessage) => void) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    emit(message: Omit<LiveMessage, "queryId">) {
      for (const handler of subscribers) handler({ ...message, queryId: id });
    },
  };
  return sub;
}

/** A fake connection that answers LIVE SELECT with a fresh uuid and tracks liveOf/subscribe. */
function fakeLiveConn(options: { readonly liveOfThrows?: Error } = {}) {
  const calls: { sql: string; vars?: Record<string, unknown> }[] = [];
  const subs: ReturnType<typeof fakeSub>[] = [];
  const connected = new Set<() => void>();
  let nextId = 0;
  const conn = {
    calls,
    subs,
    connected,
    query(sql: string, vars?: Record<string, unknown>) {
      calls.push({ sql, vars });
      return {
        responses: async () =>
          lines(sql).map((line) =>
            line.trim().toUpperCase().startsWith("LIVE SELECT")
              ? ok(new Uuid(crypto.randomUUID()))
              : ok([]),
          ),
      };
    },
    liveOf(id: Uuid) {
      if (options.liveOfThrows) return Promise.reject(options.liveOfThrows);
      const sub = fakeSub(id);
      subs.push(sub);
      return Promise.resolve(sub);
    },
    subscribe(_event: "connected", listener: () => void) {
      connected.add(listener);
      return () => connected.delete(listener);
    },
    /** Simulate an SDK reconnection. */
    fireConnected() {
      nextId++;
      for (const listener of connected) listener();
      return nextId;
    },
  };
  return conn;
}

const clientOver = (
  conn: ReturnType<typeof fakeLiveConn>,
  live?: Parameters<typeof betterSchemic>[1]["live"],
) =>
  betterSchemic(conn as never, {
    schema,
    ...(live !== undefined ? { live } : {}),
  });

const codeOf = (e: unknown): string | undefined =>
  isBetterSchemicError(e) ? e.code : undefined;

const row = (id: string, name: string) => ({
  id: new RecordId("user", id),
  name,
});

describe("live — compilation", () => {
  test("compiles LIVE SELECT with the read where/select lowering and binds", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const sub = await client.users.live({
      where: { name: "A" },
      select: { id: true, name: true },
    });
    expect(conn.calls[0]?.sql).toBe(
      "LIVE SELECT id, name FROM user WHERE name = $p0;",
    );
    expect(conn.calls[0]?.vars).toEqual({ p0: "A" });
    expect(sub.uuid).toMatch(/^[0-9a-f-]{36}$/);
    await sub.kill();
  });

  test("compiles DIFF, FETCH and the star projection", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const sub = await client.users.live({ fetch: ["mentor"] });
    expect(conn.calls[0]?.sql).toBe("LIVE SELECT * FROM user FETCH mentor;");
    await sub.kill();
    const diff = await client.users.live({ diff: true });
    expect(conn.calls[1]?.sql).toBe("LIVE SELECT DIFF FROM user;");
    await diff.kill();
  });

  test("rejects live-invalid clauses and diff+select fail fast", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    for (const args of [
      { orderBy: [{ name: "asc" }] },
      { limit: 1 },
      { groupBy: ["name"] },
      { include: { mentor: true } },
      { diff: true, select: { id: true } },
      { diff: "yes" },
    ]) {
      const err = await caught(() => client.users.live(args as never));
      expect(codeOf(err)).toMatch(/ClauseNotSupportedInLive|ValidationError/);
    }
    expect(conn.calls).toHaveLength(0);
  });
});

describe("live — notifications", () => {
  test("decodes rows through the codec and fans out to iterator + handler", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const seen: unknown[] = [];
    const sub = await client.users.live({ where: { name: "A" } }, (change) => {
      seen.push(change);
    });
    const iterated: unknown[] = [];
    const consume = (async () => {
      for await (const change of sub) iterated.push(change);
    })();
    const sdk = conn.subs[0] as ReturnType<typeof fakeSub>;
    sdk.emit({
      action: "CREATE",
      recordId: new RecordId("user", "u1"),
      value: row("u1", "A"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sub.kill();
    await consume;
    expect(seen).toHaveLength(1);
    expect(iterated).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: "CREATE",
      recordId: new RecordId("user", "u1"),
      value: { id: new RecordId("user", "u1"), name: "A" },
    });
  });

  test("diff notifications carry the patch ops and a null value", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const seen: {
      action: string;
      value: unknown;
      diff?: readonly unknown[];
    }[] = [];
    const sub = await client.users.live({ diff: true }, (change) => {
      seen.push(change);
    });
    (conn.subs[0] as ReturnType<typeof fakeSub>).emit({
      action: "UPDATE",
      recordId: new RecordId("user", "u1"),
      value: [{ op: "change", path: "/name", value: "@@" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sub.kill();
    expect(seen[0]?.value).toBeNull();
    expect(seen[0]?.diff).toEqual([
      { op: "change", path: "/name", value: "@@" },
    ]);
  });

  test("handler failures are routed to onError (no listener -> console)", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const errors: Error[] = [];
    const sub = await client.users.live({}, () => {
      throw new Error("handler boom");
    });
    sub.onError((error) => errors.push(error));
    (conn.subs[0] as ReturnType<typeof fakeSub>).emit({
      action: "UPDATE",
      recordId: new RecordId("user", "u1"),
      value: row("u1", "A"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sub.kill();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("handler boom");
  });

  test("kill is idempotent, ends iteration and calls the SDK kill once", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const sub = await client.users.live();
    const sdk = conn.subs[0] as ReturnType<typeof fakeSub>;
    await sub.kill();
    await sub.kill();
    expect(sub.isAlive).toBe(false);
    expect(sdk.killed).toBe(1);
    expect(() => sub[Symbol.asyncIterator]()).toThrow();
  });
});

describe("live — reconnect and client surfaces", () => {
  test("reconnect re-runs the LIVE, re-subscribes and emits RECONNECTED", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn, { reconnect: true });
    const events: string[] = [];
    const sub = await client.users.live({}, (change) => {
      events.push(change.action);
    });
    const firstSdk = conn.subs[0] as ReturnType<typeof fakeSub>;
    conn.fireConnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(conn.calls).toHaveLength(2);
    expect(conn.calls[1]?.sql).toBe("LIVE SELECT * FROM user;");
    expect(conn.subs).toHaveLength(2);
    expect(events).toEqual(["RECONNECTED"]);
    // The NEW subscription is live; the old one is detached.
    firstSdk.emit({
      action: "CREATE",
      recordId: new RecordId("user", "old"),
      value: row("old", "Old"),
    });
    (conn.subs[1] as ReturnType<typeof fakeSub>).emit({
      action: "CREATE",
      recordId: new RecordId("user", "new"),
      value: row("new", "New"),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["RECONNECTED", "CREATE"]);
    await sub.kill();
  });

  test("reconnect: false keeps the original subscription", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn, { reconnect: false });
    const sub = await client.users.live();
    conn.fireConnected();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(conn.calls).toHaveLength(1);
    await sub.kill();
  });

  test("client.live(table) routes through the delegate; client.kill binds the uuid", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const sub = await client.live("users", { where: { name: "A" } });
    expect(conn.calls[0]?.sql).toBe(
      "LIVE SELECT * FROM user WHERE name = $p0;",
    );
    const uuid = sub.uuid;
    await client.kill(uuid);
    expect(conn.calls[1]?.sql).toBe("KILL $p0;");
    expect(conn.calls[1]?.vars).toEqual({ p0: uuid });
    await sub.kill();
    const bad = await caught(() => client.kill("not-a-uuid"));
    expect(codeOf(bad)).toBe("ValidationError");
  });

  test("liveOf reattaches raw (no table meta) and rejects bad uuids", async () => {
    const conn = fakeLiveConn();
    const client = clientOver(conn);
    const uuid = crypto.randomUUID();
    const seen: unknown[] = [];
    const sub = await client.liveOf(uuid, (change) => {
      seen.push(change);
    });
    expect(sub.uuid).toBe(uuid);
    (conn.subs[0] as ReturnType<typeof fakeSub>).emit({
      action: "CREATE",
      recordId: new RecordId("user", "u1"),
      value: { id: new RecordId("user", "u1"), name: "A" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen[0]).toMatchObject({
      action: "CREATE",
      value: { name: "A" },
    });
    await sub.kill();
    const bad = await caught(() => client.liveOf("nope"));
    expect(codeOf(bad)).toBe("ValidationError");
  });

  test("HTTP-style liveOf failures normalize to LiveQueryUnsupported", async () => {
    const unsupported = Object.assign(
      new Error(
        "The configured engine does not support the feature: live-queries",
      ),
      { name: "UnsupportedFeatureError" },
    );
    const err = await caught(() =>
      clientOver(fakeLiveConn({ liveOfThrows: unsupported })).users.live(),
    );
    expect(codeOf(err)).toBe("LiveQueryUnsupported");
    const bare = {
      query: () => ({
        responses: async () => [ok(new Uuid(crypto.randomUUID()))],
      }),
    };
    const noLive = betterSchemic(bare as never, { schema });
    const missing = await caught(() => noLive.users.live());
    expect(codeOf(missing)).toBe("LiveQueryUnsupported");
  });

  test("live inside a transaction fails with LiveInTransaction", async () => {
    const conn = fakeLiveConn();
    const withTx = {
      ...conn,
      beginTransaction() {
        return Promise.resolve({
          query: conn.query,
          commit: () => Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      },
    };
    const client = betterSchemic(withTx as never, { schema });
    const err = await caught(() =>
      client.transaction(async (tx) => {
        await tx.users.live();
      }),
    );
    expect(codeOf(err)).toBe("LiveInTransaction");
  });
});
