// String ids — the acceptance contract against a REAL SurrealDB: the app speaks bare strings while
// the DB stores `record<…>`; raw `db.query()` still returns `RecordId`. Ephemeral server; skipped
// when no `surreal` binary is available.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { emitTable } from "../../src/ddl";
import { defineRelation, defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[string-ids] `surreal` binary unavailable — skipping");

const Org = defineTable("si_org", { name: s.string() }).stringIds();
const Customer = defineTable("si_customer", {
  name: s.string(),
  org: s.recordId(Org),
  owner: s.recordId(Org).optional(),
  meta: s.object({ ref: s.recordId(Org) }),
  products: s.array(s.object({ product: s.recordId(Org) })),
  tags: s.array(s.recordId(Org)),
}).stringIds();
const Likes = defineRelation("si_likes", { score: s.int() })
  .from(Customer)
  .to(Org)
  .stringIds();
const Event = defineTable("si_event", {
  at: s.datetime(),
  ref: s.recordId(Org),
}).stringIds();
const schema = defineSchema({
  orgs: Org,
  customers: Customer,
  events: Event,
  likes: Likes,
});

const data = (name: string, org: string) => ({
  name,
  org,
  meta: { ref: org },
  products: [{ product: org }],
  tags: [org],
});

live("string ids — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "string_ids", database: "live" });
    for (const table of [Org, Customer, Event, Likes]) {
      await db.query(emitTable(table, { exists: "overwrite" }));
    }
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("create with bare refs returns bare strings; raw SQL still returns RecordId", async () => {
    await client.orgs.create({ data: { id: "o1", name: "Org 1" } });
    await client.orgs.create({ data: { id: "o2", name: "Org 2" } });
    const row = await client.customers.create({
      data: { id: "c1", ...data("A", "o1") },
    });
    expect(row.id).toBe("c1");
    expect(row.org).toBe("o1");
    expect(row.meta.ref).toBe("o1");
    expect(row.products[0]?.product).toBe("o1");
    expect(row.tags).toEqual(["o1"]);

    const raw = await db.query<[Array<{ id: RecordId; org: RecordId }>]>(
      "SELECT * FROM si_customer WHERE id = si_customer:c1",
    );
    const rawRow = raw[0]?.[0];
    expect(rawRow?.id).toBeInstanceOf(RecordId);
    expect(rawRow?.org).toBeInstanceOf(RecordId);
  });

  test("where binds bare strings (shorthand, equals, in, contains, id)", async () => {
    await client.customers.create({ data: { id: "c2", ...data("B", "o2") } });

    const byOrg = await client.customers.findMany({
      where: { org: "o1" },
      orderBy: [{ id: "asc" }],
    });
    expect(byOrg.map((r) => r.id)).toEqual(["c1"]);

    const byEquals = await client.customers.findMany({
      where: { org: { equals: "o2" } },
    });
    expect(byEquals.map((r) => r.id)).toEqual(["c2"]);

    const byIn = await client.customers.findMany({
      where: { org: { in: ["o1", "o2"] } },
      orderBy: [{ id: "asc" }],
    });
    expect(byIn.map((r) => r.id)).toEqual(["c1", "c2"]);

    const byContains = await client.customers.findMany({
      where: { tags: { contains: "o1" } },
    });
    expect(byContains.map((r) => r.id)).toEqual(["c1"]);

    const byId = await client.customers.findMany({ where: { id: "c2" } });
    expect(byId.map((r) => r.id)).toEqual(["c2"]);

    const unique = await client.customers.findUnique({ where: { id: "c1" } });
    expect(unique?.id).toBe("c1");
  });

  test("cursor paginates by bare ids and returns a bare nextCursor", async () => {
    await client.customers.create({ data: { id: "c3", ...data("C", "o1") } });
    const first = await client.customers.cursor({
      orderBy: [{ id: "asc" }],
      limit: 2,
    });
    expect(first.data.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(typeof first.pagination.nextCursor).toBe("string");
    expect(first.pagination.nextCursor).toBe("c2");

    const second = await client.customers.cursor({
      after: first.pagination.nextCursor as string,
      orderBy: [{ id: "asc" }],
      limit: 2,
    });
    expect(second.data.map((r) => r.id)).toEqual(["c3"]);
    expect(second.pagination.hasPrevious).toBe(true);
    expect(typeof second.pagination.previousCursor).toBe("string");
  });

  test("tuple cursor (datetime + bare id) round-trips", async () => {
    await client.events.create({
      data: { id: "e1", at: new Date("2024-01-01T00:00:00Z"), ref: "o1" },
    });
    await client.events.create({
      data: { id: "e2", at: new Date("2024-01-01T00:00:00Z"), ref: "o1" },
    });
    await client.events.create({
      data: { id: "e3", at: new Date("2024-01-02T00:00:00Z"), ref: "o2" },
    });
    const page = await client.events.cursor({
      orderBy: [{ at: "asc" }, { id: "asc" }],
      limit: 2,
    });
    expect(page.data.map((r) => r.id)).toEqual(["e1", "e2"]);
    const cursor = page.pagination.nextCursor as {
      at: unknown;
      id: unknown;
    };
    expect(cursor.id).toBe("e2");
    const next = await client.events.cursor({
      after: cursor,
      orderBy: [{ at: "asc" }, { id: "asc" }],
      limit: 2,
    });
    expect(next.data.map((r) => r.id)).toEqual(["e3"]);
  });

  test("update / upsert / upsertDelta with bare refs", async () => {
    const updated = await client.customers.update({
      where: { id: "c3" },
      data: { org: "o2", meta: { ref: "o2" }, tags: ["o2"] },
    });
    expect(updated?.org).toBe("o2");
    expect(updated?.meta.ref).toBe("o2");

    const upserted = await client.customers.upsert({
      where: { id: "c4" },
      data: { ...data("D", "o1") },
      onMissing: "create",
    });
    expect(upserted.id).toBe("c4");
    expect(upserted.org).toBe("o1");

    const delta = await client.customers.upsertDelta({
      where: { id: "c4" },
      data: data("D", "o2"),
    });
    expect(delta?.before?.org).toBe("o1");
    expect(delta?.record.org).toBe("o2");
    expect(delta?.delta?.new.org).toBe("o2");
    expect(delta?.changed).toContain("org");
  });

  test("include / FETCH hydrates links with bare strings", async () => {
    const rows = await client.customers.findMany({
      where: { id: "c1" },
      include: { org: true },
    });
    expect(rows[0]?.org).toMatchObject({ id: "o1", name: "Org 1" });
    expect((rows[0]?.org as { id: unknown }).id).toBe("o1");
  });

  test("RELATE accepts bare endpoints and returns bare in/out", async () => {
    const edge = await client.likes.relate({
      from: "c1",
      to: "o1",
      data: { score: 3 },
    });
    expect(edge.id).toBeDefined();
    expect(edge.in).toBe("c1");
    expect(edge.out).toBe("o1");
    expect(edge.score).toBe(3);

    const edges = await client.likes.findMany({
      where: { in: "c1", out: "o1" },
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.in).toBe("c1");
  });
});
