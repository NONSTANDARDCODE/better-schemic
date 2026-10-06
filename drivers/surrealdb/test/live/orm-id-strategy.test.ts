// The per-table `idStrategy` against a REAL server: the ULID default (26 chars, time-sortable),
// uuid v7, `rand::id()` (20 chars), explicit-id and singleton overrides, per-row uniqueness in
// batches, `skipDuplicates` with id-less rows, the upsert create branch, upsertMany conflict and
// the schemaless uniform default. Ephemeral server; skipped when no `surreal` binary is available.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineSingleton, defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-id-strategy] `surreal` binary unavailable — skipping");

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAND_ID = /^[0-9a-z]{20}$/;

const Default = defineTable("is_default", {
  name: s.string(),
  email: s.string(),
}).index("uq_is_default_email", ["email"], { unique: true });
const Uuid = defineTable("is_uuid", { name: s.string(), email: s.string() })
  .idStrategy("uuid")
  .index("uq_is_uuid_email", ["email"], { unique: true });
const Rand = defineTable("is_rand", { name: s.string() }).idStrategy("rand");
/** A table name needing an escaped identifier — proves `type::record(s"…")` escaping. */
const Weird = defineTable("is-weird", { name: s.string() });
const Config = defineSingleton("is_config", { value: s.string() });
const schema = defineSchema({
  defaults: Default,
  uuids: Uuid,
  rands: Rand,
  weird: Weird,
  config: Config,
  audit: "is_audit",
});

/** The raw id part of a decoded row (`RecordId.id`), as text. */
const idPart = (row: { id: RecordId }): string => String(row.id.id);
/** The physical table of a decoded row. */
const idTable = (row: { id: RecordId }): string => row.id.table.name;

live("orm id strategy — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "orm_id_strategy", database: "live" });
    await db.query(`
      DEFINE TABLE is_default SCHEMAFULL;
      DEFINE FIELD name ON is_default TYPE string;
      DEFINE FIELD email ON is_default TYPE string;
      DEFINE INDEX uq_is_default_email ON is_default FIELDS email UNIQUE;
      DEFINE TABLE is_uuid SCHEMAFULL;
      DEFINE FIELD name ON is_uuid TYPE string;
      DEFINE FIELD email ON is_uuid TYPE string;
      DEFINE INDEX uq_is_uuid_email ON is_uuid FIELDS email UNIQUE;
      DEFINE TABLE is_rand SCHEMAFULL;
      DEFINE FIELD name ON is_rand TYPE string;
      DEFINE TABLE \`is-weird\` SCHEMAFULL;
      DEFINE FIELD name ON \`is-weird\` TYPE string;
      DEFINE TABLE is_config SCHEMAFULL;
      DEFINE FIELD id ON is_config TYPE 'default';
      DEFINE FIELD value ON is_config TYPE string;
      DEFINE TABLE is_audit SCHEMALESS;
    `);
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("default create is a time-sortable ULID (no opt-in)", async () => {
    const first = await client.defaults.create({
      data: { name: "A", email: "a@x" },
    });
    await Bun.sleep(2);
    const second = await client.defaults.create({
      data: { name: "B", email: "b@x" },
    });
    expect(idTable(first)).toBe("is_default");
    expect(idPart(first)).toMatch(ULID);
    expect(idPart(second)).toMatch(ULID);
    expect(idPart(second) > idPart(first)).toBe(true);
  });

  test("createMany generates a unique ULID per row", async () => {
    const batch = await client.defaults.createMany({
      data: [
        { name: "C1", email: "c1@x" },
        { name: "C2", email: "c2@x" },
        { name: "C3", email: "c3@x" },
      ],
    });
    const ids = (batch.data ?? []).map((row) => idPart(row));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(ULID);
  });

  test("idStrategy('uuid') creates a UUID v7", async () => {
    const row = await client.uuids.create({
      data: { name: "U", email: "u@x" },
    });
    expect(idPart(row)).toMatch(UUID_V7);
  });

  test("idStrategy('rand') keeps the 20-char server default", async () => {
    const row = await client.rands.create({ data: { name: "R" } });
    expect(idPart(row)).toMatch(RAND_ID);
  });

  test("explicit id wins in create/createMany/upsert", async () => {
    const created = await client.defaults.create({
      data: { id: "is_default:manual", name: "M", email: "m@x" },
    });
    expect(String(created.id)).toBe("is_default:manual");

    const many = await client.defaults.createMany({
      data: [
        { id: "is_default:manual2", name: "M2", email: "m2@x" },
        { name: "M3", email: "m3@x" },
      ],
    });
    expect((many.data ?? []).map((row) => idPart(row))).toEqual([
      "manual2",
      expect.stringMatching(ULID),
    ]);

    const up = await client.defaults.upsert({
      where: { id: "is_default:manual" },
      data: { name: "M-updated" },
    });
    expect(String(up?.id)).toBe("is_default:manual");
  });

  test("insert/insertMany generate ULIDs when the payload has no id", async () => {
    const one = await client.defaults.insert({
      data: { name: "I", email: "i@x" },
    });
    expect(idPart(one)).toMatch(ULID);

    const many = await client.defaults.insertMany({
      data: [
        { name: "I2", email: "i2@x" },
        { name: "I3", email: "i3@x" },
      ],
    });
    const ids = (many.data ?? []).map((row) => idPart(row));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(ULID);
  });

  test("skipDuplicates works with id-less rows (generated) and skips explicit duplicates", async () => {
    const first = await client.defaults.createMany({
      data: [{ name: "S1", email: "s1@x" }],
      skipDuplicates: true,
    });
    expect(first.count).toBe(1);
    expect(idPart((first.data ?? [])[0]!)).toMatch(ULID);

    const duplicate = await client.defaults.createMany({
      data: [{ id: "is_default:manual", name: "Dup", email: "dup@x" }],
      skipDuplicates: true,
    });
    expect(duplicate.count).toBe(0);
    expect(duplicate.skipped).toBe(1);
  });

  test("upsert by UNIQUE creates with the strategy id, then updates the same row", async () => {
    const created = await client.uuids.upsert({
      where: { email: "new@x" },
      data: { email: "new@x", name: "New" },
      onMissing: "create",
    });
    expect(created).not.toBeNull();
    expect(idPart(created!)).toMatch(UUID_V7);

    const updated = await client.uuids.upsert({
      where: { email: "new@x" },
      data: { email: "new@x", name: "New2" },
    });
    expect(String(updated?.id)).toBe(String(created?.id));
    expect(updated).toMatchObject({ name: "New2" });
  });

  test("upsert create/update branches generate on the CREATE side", async () => {
    const created = await client.uuids.upsert({
      where: { email: "branch@x" },
      create: { email: "branch@x", name: "Branch" },
      update: { name: "Branch2" },
      onMissing: "create",
    });
    expect(idPart(created!)).toMatch(UUID_V7);
    const updated = await client.uuids.upsert({
      where: { email: "branch@x" },
      create: { email: "branch@x", name: "Branch" },
      update: { name: "Branch2" },
      onMissing: "create",
    });
    expect(String(updated?.id)).toBe(String(created?.id));
    expect(updated).toMatchObject({ name: "Branch2" });
  });

  test("upsert by UNIQUE keeps mode:'set' and RETURN DIFF working with a generated target", async () => {
    const created = await client.uuids.upsert({
      where: { email: "set@x" },
      mode: "set",
      data: { email: "set@x", name: "Set" },
      onMissing: "create",
    });
    expect(idPart(created!)).toMatch(UUID_V7);

    const diff = await client.uuids.upsert({
      where: { email: "set@x" },
      data: { email: "set@x", name: "Set2" },
      return: "diff",
      onMissing: "create",
    });
    expect(Array.isArray(diff)).toBe(true);
  });

  test("upsertMany by conflict keeps RETURN DIFF working with a generated target", async () => {
    const diff = await client.uuids.upsertMany({
      data: [{ email: "umdiff@x", name: "UMDiff" }],
      conflict: "email",
      return: "diff",
    });
    expect(Array.isArray(diff)).toBe(true);
  });

  test("upsertMany by conflict creates with the strategy id, then updates the same row", async () => {
    const created = await client.uuids.upsertMany({
      data: [{ email: "um@x", name: "UM" }],
      conflict: "email",
    });
    expect(created.count).toBe(1);
    const id = idPart((created.data ?? [])[0]!);
    expect(id).toMatch(UUID_V7);

    const updated = await client.uuids.upsertMany({
      data: [{ email: "um@x", name: "UM2" }],
      conflict: "email",
    });
    expect(updated.count).toBe(1);
    expect(idPart((updated.data ?? [])[0]!)).toBe(id);
  });

  test("singleton keeps its fixed id (strategy never applies)", async () => {
    const row = await client.config.create({ data: { value: "x" } });
    expect(String(row.id)).toBe("is_config:default");
    const read = await client.config.findFirst({});
    expect(String(read?.id)).toBe("is_config:default");
  });

  test("schemaless entries ride the uniform ULID default", async () => {
    const row = (await client.audit.create({ data: { event: "x" } })) as {
      id: RecordId;
    };
    expect(idTable(row)).toBe("is_audit");
    expect(idPart(row)).toMatch(ULID);
  });

  test("an escaped table name targets the RIGHT table (toSurqlString, not escapeIdent)", async () => {
    const row = await client.weird.create({ data: { name: "W" } });
    expect(idTable(row)).toBe("is-weird");
    expect(idPart(row)).toMatch(ULID);
  });
});
