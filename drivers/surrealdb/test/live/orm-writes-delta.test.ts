// `upsertDelta` — the live contract on a REAL server: ONE round-trip create-or-update returning
// the decoded before/after delta (create/update/no-op/removal/expressions/codecs/strict mode),
// atomicity under concurrent same-id calls and transaction participation. Ephemeral server;
// skipped without the `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Decimal, RecordId } from "surrealdb";
import { surrealBinaryAvailable } from "../../src/cli/engine";
import { defineTable, s, surql } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import type { BetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught } from "../orm-fixtures";
import { type LiveServer, startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-writes-delta] `surreal` binary unavailable — skipping");

const Owner = defineTable("dl_owner", { name: s.string() });
const Account = defineTable("dl_account", {
  name: s.string(),
  balance: s.decimal(),
  count: s.int(),
  note: s.string().optional(),
  at: s.datetime().optional(),
  owner: s.recordId(() => Owner).optional(),
}).index("dl_account_name", ["name"], { unique: true });
const schema = defineSchema({ accounts: Account, owners: Owner });

live("orm upsertDelta — live", () => {
  let live_: LiveServer;
  let client: Client<typeof schema>;

  const base = (name: string) => ({
    name,
    balance: new Decimal("10.00"),
    count: 1,
  });

  beforeAll(async () => {
    live_ = await startLiveServer({
      namespace: "orm_writes_delta",
      database: "live",
      ddl: `
        DEFINE TABLE dl_owner SCHEMAFULL;
        DEFINE FIELD name ON dl_owner TYPE string;
        DEFINE TABLE dl_account SCHEMAFULL;
        DEFINE FIELD name ON dl_account TYPE string;
        DEFINE FIELD balance ON dl_account TYPE decimal;
        DEFINE FIELD count ON dl_account TYPE int;
        DEFINE FIELD note ON dl_account TYPE option<string>;
        DEFINE FIELD at ON dl_account TYPE option<datetime>;
        DEFINE FIELD owner ON dl_account TYPE option<record<dl_owner>>;
        DEFINE INDEX dl_account_name ON dl_account FIELDS name UNIQUE;
      `,
    });
    client = betterSchemic(live_.db, { schema });
  });

  afterAll(async () => {
    await live_?.stop();
  });

  test("create, explicit id: created, no before/delta/changed, decoded row", async () => {
    const created = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: base("Acct1"),
    });
    expect(created.created).toBe(true);
    expect(created.before).toBeNull();
    expect(created.delta).toBeNull();
    expect(created.changed).toEqual([]);
    expect(created.record.id).toEqual(new RecordId("dl_account", "1"));
    expect(created.record.balance).toBeInstanceOf(Decimal);
    expect(
      (created.record.balance as Decimal).equals(new Decimal("10.00")),
    ).toBe(true);
  });

  test("create, no target: server-generated id", async () => {
    const fresh = await client.accounts.upsertDelta({
      data: base("Generated"),
    });
    expect(fresh.created).toBe(true);
    expect(fresh.record.id).toBeInstanceOf(RecordId);
    expect(fresh.record.id.table.name).toBe("dl_account");
    expect(String(fresh.record.id).length).toBeGreaterThan(
      "dl_account:".length,
    );
    expect(fresh.before).toBeNull();
    expect(fresh.delta).toBeNull();
  });

  test("update, one field: only that field in the delta; before is the prior row", async () => {
    const updated = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: { balance: new Decimal("12.34") },
    });
    expect(updated.created).toBe(false);
    expect(updated.before?.name).toBe("Acct1");
    expect(updated.before?.count).toBe(1);
    expect(updated.changed).toEqual(["balance"]);
    const oldBalance = updated.delta?.old.balance as Decimal | undefined;
    const newBalance = updated.delta?.new.balance as Decimal | undefined;
    expect(oldBalance?.equals(new Decimal("10.00"))).toBe(true);
    expect(newBalance?.equals(new Decimal("12.34"))).toBe(true);
    expect(
      (updated.record.balance as Decimal).equals(new Decimal("12.34")),
    ).toBe(true);
    expect(updated.delta?.old.name).toBeUndefined();
  });

  test("update, multiple fields: every changed key, unchanged absent", async () => {
    const multi = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: { count: 2, note: "hello" },
    });
    expect([...multi.changed].sort()).toEqual(["count", "note"]);
    expect(multi.delta?.old).toMatchObject({ count: 1, note: undefined });
    expect(multi.delta?.new).toMatchObject({ count: 2, note: "hello" });
  });

  test("no-op update: delta null, changed empty, before present", async () => {
    const noop = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: { count: 2 },
    });
    expect(noop.created).toBe(false);
    expect(noop.delta).toBeNull();
    expect(noop.changed).toEqual([]);
    expect(noop.before?.count).toBe(2);
    expect(noop.record.count).toBe(2);
  });

  test("strict mode: a missing id rejects ResultNotFound and creates nothing", async () => {
    const error = (await caught(() =>
      client.accounts.upsertDelta({
        where: { id: "dl_account:strict" },
        data: base("Strict"),
        onMissing: "throw",
      }),
    )) as BetterSchemicError;
    expect(error.code).toBe("ResultNotFound");
    expect(error.table).toBe("dl_account");
    expect(error.operation).toBe("upsertDelta");
    expect(
      await client.accounts.findUnique({ where: { id: "dl_account:strict" } }),
    ).toBeNull();

    const hit = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: { note: "strict" },
      onMissing: "throw",
    });
    expect(hit.created).toBe(false);
    expect(hit.changed).toEqual(["note"]);
    expect(hit.delta?.new.note).toBe("strict");
  });

  test("unique-field target: create when absent, update when present", async () => {
    const created = await client.accounts.upsertDelta({
      where: { name: "UniqueA" },
      data: { ...base("UniqueA") },
    });
    expect(created.created).toBe(true);
    const updated = await client.accounts.upsertDelta({
      where: { name: "UniqueA" },
      data: { name: "UniqueA", balance: new Decimal("2.00"), count: 1 },
    });
    expect(updated.created).toBe(false);
    expect(updated.record.id).toEqual(created.record.id);
    expect(updated.changed).toEqual(["balance"]);
    const uniqueBalance = updated.delta?.new.balance as Decimal | undefined;
    expect(uniqueBalance?.equals(new Decimal("2.00"))).toBe(true);
  });

  test("expressions: the delta carries server-computed old/new", async () => {
    await client.accounts.upsertDelta({
      where: { id: "dl_account:expr" },
      data: { ...base("Expr"), count: 5 },
    });
    const bumped = await client.accounts.upsertDelta({
      where: { id: "dl_account:expr" },
      data: { count: surql`count + 10` },
      mode: "set",
    });
    expect(bumped.created).toBe(false);
    expect(bumped.changed).toEqual(["count"]);
    expect(bumped.delta?.old.count).toBe(5);
    expect(bumped.delta?.new.count).toBe(15);
    expect(bumped.record.count).toBe(15);
  });

  test("distinct create/update payloads: both branches and the created flag", async () => {
    const args = {
      where: { id: "dl_account:branches" },
      create: { id: "dl_account:branches", ...base("Branches") },
      update: { count: 7 },
    } as const;
    const created = await client.accounts.upsertDelta({ ...args });
    expect(created.created).toBe(true);
    expect(created.delta).toBeNull();
    const updated = await client.accounts.upsertDelta({ ...args });
    expect(updated.created).toBe(false);
    expect(updated.changed).toEqual(["count"]);
    expect(updated.delta?.old.count).toBe(1);
    expect(updated.delta?.new.count).toBe(7);
  });

  test("mode content removing a field: changed, old value, undefined in new", async () => {
    await client.accounts.upsertDelta({
      where: { id: "dl_account:remove" },
      data: { ...base("Remove"), note: "byebye" },
    });
    const removed = await client.accounts.upsertDelta({
      where: { id: "dl_account:remove" },
      data: { name: "Remove", balance: new Decimal("10.00"), count: 1 },
      mode: "content",
    });
    expect(removed.changed).toEqual(["note"]);
    expect(removed.delta?.old.note).toBe("byebye");
    expect(Object.hasOwn(removed.delta?.new ?? {}, "note")).toBe(true);
    expect(removed.delta?.new.note).toBeUndefined();
  });

  test("codecs round-trip typed inside record, before and delta", async () => {
    const owner = await client.owners.create({ data: { name: "Owner" } });
    const first = new Date("2024-05-06T07:08:09.000Z");
    const second = new Date("2025-01-02T03:04:05.000Z");
    await client.accounts.upsertDelta({
      where: { id: "dl_account:codec" },
      data: { ...base("Codec"), at: first, owner: owner.id },
    });
    const codec = await client.accounts.upsertDelta({
      where: { id: "dl_account:codec" },
      data: { at: second, owner: owner.id },
    });
    expect(codec.changed).toEqual(["at"]);
    expect(codec.delta?.old.at).toBeInstanceOf(Date);
    const oldAt = codec.delta?.old.at as Date | undefined;
    const newAt = codec.delta?.new.at as Date | undefined;
    expect(oldAt?.toISOString()).toBe(first.toISOString());
    expect(codec.delta?.new.at).toBeInstanceOf(Date);
    expect(newAt?.toISOString()).toBe(second.toISOString());
    expect(codec.before?.owner).toEqual(owner.id);
    expect(codec.record.owner).toEqual(owner.id);
    expect(codec.record.owner).toBeInstanceOf(RecordId);
  });

  test("concurrent same-id calls never tear { before, after }", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.accounts.upsertDelta({
          where: { id: "dl_account:race" },
          data: { name: "Race", balance: new Decimal("10.00"), count: i },
        }),
      ),
    );
    const creates = results.filter((r) => r.created);
    expect(creates).toHaveLength(1);
    const first = creates[0];
    if (!first) throw new Error("no create observed in the concurrent batch");
    // Rebuild the serialized order from the atomic snapshots: every update's `before` must be
    // exactly another call's `record`, forming ONE chain (a torn pair breaks or duplicates it).
    let current: (typeof results)[number] = first;
    const seen = new Set<number>([first.record.count as number]);
    while (seen.size < results.length) {
      const next = results.find(
        (r) =>
          !r.created &&
          !seen.has(r.record.count as number) &&
          r.before?.count === current.record.count,
      );
      if (!next)
        throw new Error("torn envelope: no predecessor for the current state");
      if (next.created) throw new Error("expected an update envelope");
      expect(next.changed).toEqual(["count"]);
      expect(next.delta?.old.count).toBe(next.before.count);
      expect(next.delta?.new.count).toBe(next.record.count);
      seen.add(next.record.count as number);
      current = next;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("transaction: commits with the tx and rolls back on a thrown error", async () => {
    const committed = await client.transaction(async (tx) =>
      tx.accounts.upsertDelta({
        where: { id: "dl_account:tx" },
        data: base("Tx"),
      }),
    );
    expect(committed.created).toBe(true);
    expect(
      (await client.accounts.findUnique({ where: { id: "dl_account:tx" } }))
        ?.name,
    ).toBe("Tx");

    const error = await caught(() =>
      client.transaction(async (tx) => {
        await tx.accounts.upsertDelta({
          where: { id: "dl_account:tx2" },
          data: base("Tx2"),
        });
        throw new Error("boom");
      }),
    );
    expect((error as Error).message).toContain("boom");
    expect(
      await client.accounts.findUnique({ where: { id: "dl_account:tx2" } }),
    ).toBeNull();
  });

  test("timeout rides the statement and the write still succeeds", async () => {
    const timed = await client.accounts.upsertDelta({
      where: { id: "dl_account:1" },
      data: { note: "timed" },
      timeout: "5s",
    });
    expect(timed.changed).toEqual(["note"]);
    expect(timed.delta?.new.note).toBe("timed");
  });
});
