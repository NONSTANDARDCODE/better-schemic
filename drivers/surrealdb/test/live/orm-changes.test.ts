// M4.3 — changefeeds end-to-end: `SHOW CHANGES` normalization (update/original/delete), per-table
// decode, versionstamp pagination and database-level reads. Ephemeral server; skipped without a
// `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, type Surreal } from "surrealdb";
import {
  type EphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-changes] `surreal` binary unavailable — skipping");

const Plain = defineTable("cf_plain", { name: s.string() });
const Orig = defineTable("cf_orig", { name: s.string() });
const schema = defineSchema({ plain: Plain, orig: Orig });

live("orm changes — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    const started = await startLiveServer({
      namespace: "orm_changes",
      database: "live",
      ddl: `
        DEFINE TABLE cf_plain SCHEMAFULL CHANGEFEED 1d;
        DEFINE FIELD name ON cf_plain TYPE string;
        DEFINE TABLE cf_orig SCHEMAFULL CHANGEFEED 1d INCLUDE ORIGINAL;
        DEFINE FIELD name ON cf_orig TYPE string;
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

  test("INCLUDE ORIGINAL: create/update/delete with current+diff and before", async () => {
    const id = new RecordId("cf_orig", "one");
    await client.orig.create({ data: { id, name: "one" } });
    await client.orig.update({ where: { id }, data: { name: "two" } });
    await client.orig.delete({ where: { id } });
    const sets = await client.changes({ table: "orig", since: 0, limit: 100 });
    const entries = sets
      .flatMap((set) => set.changes)
      .filter((change) => change.action !== "DEFINE");
    expect(entries.map((e) => e.action)).toEqual([
      "UPDATE",
      "UPDATE",
      "DELETE",
    ]);
    expect(entries[0]).toMatchObject({
      recordId: id,
      value: { id, name: "one" },
    });
    expect(entries[1]).toMatchObject({
      recordId: id,
      value: { id, name: "two" },
      diff: [expect.objectContaining({ op: "change", path: "/name" })],
    });
    expect(entries[2]).toMatchObject({
      recordId: id,
      before: { id, name: "two" },
    });
  });

  test("without INCLUDE ORIGINAL, writes arrive as full rows (create and update alike)", async () => {
    const id = new RecordId("cf_plain", "p1");
    await client.plain.create({ data: { id, name: "A" } });
    await client.plain.update({ where: { id }, data: { name: "B" } });
    const sets = await client.changes({ table: "plain", since: 0 });
    const entries = sets
      .flatMap((set) => set.changes)
      .filter((change) => change.action !== "DEFINE");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: "UPDATE",
      value: { name: "A" },
    });
    expect(entries[1]).toMatchObject({
      action: "UPDATE",
      value: { name: "B" },
    });
    expect(entries[1]).not.toHaveProperty("diff");
  });

  test("versionstamp pagination advances past the inclusive SINCE", async () => {
    await client.plain.deleteMany({ where: { name: "B" } });
    const first = await client.changes({ table: "plain", since: 0, limit: 2 });
    expect(first.length).toBeGreaterThan(0);
    const last = first[first.length - 1]?.versionstamp as bigint;
    const second = await client.changes({
      table: "plain",
      since: last + 1n,
      limit: 10,
    });
    const stamps = second.map((set) => set.versionstamp);
    expect(stamps.every((stamp) => stamp > last)).toBe(true);
    const all = await client.changes({ table: "plain", since: 0, limit: 100 });
    const unique = new Set(all.map((set) => String(set.versionstamp)));
    expect(unique.size).toBe(all.length);
  });

  test("database-level changes decode by each record's own table", async () => {
    const sets = await client.changes({ since: 0, limit: 100 });
    const seen = sets
      .flatMap((set) => set.changes)
      .filter((change) => change.action !== "DEFINE");
    const plain = seen.find(
      (change) => change.recordId?.table?.name === "cf_plain",
    );
    const orig = seen.find(
      (change) => change.recordId?.table?.name === "cf_orig",
    );
    expect(plain).toBeDefined();
    expect(orig).toBeDefined();
    // Both decoded through their model codecs (name is a plain string on both).
    if (plain?.action === "UPDATE")
      expect(typeof plain.value.name).toBe("string");
    if (orig?.action === "DELETE")
      expect(typeof orig.before?.name).toBe("string");
  });

  test("since accepts a Date (epoch reads the whole retained feed)", async () => {
    const sets = await client.changes({ table: "orig", since: new Date(0) });
    expect(sets.flatMap((set) => set.changes).length).toBeGreaterThan(0);
  });
});
