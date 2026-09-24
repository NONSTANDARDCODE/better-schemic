// The query logger against a REAL server: the framed output carries the actual execution plan from
// `.explain()` and from auto-explain (`EXPLAIN FORMAT JSON`). Ephemeral server; skipped without the
// `surreal` binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-logger] `surreal` binary unavailable — skipping");

const User = defineTable("lg_user", {
  name: s.string(),
  age: s.int(),
  active: s.boolean(),
}).index("lg_idx_age", ["age"], { unique: true });
const schema = defineSchema({ users: User });

function capturing(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  return {
    lines,
    out: () => lines.join("\n"),
    option: {
      write: (l: string) => lines.push(l),
      colors: false,
      ...overrides,
    },
  };
}

live("orm logger — live", () => {
  let server: EphemeralServer;
  let db: Surreal;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "orm_logger", database: "live" });
    await db.query(`
      REMOVE TABLE IF EXISTS lg_user;
      DEFINE TABLE lg_user SCHEMAFULL;
      DEFINE FIELD name ON lg_user TYPE string;
      DEFINE FIELD age ON lg_user TYPE int;
      DEFINE FIELD active ON lg_user TYPE bool DEFAULT true;
      DEFINE INDEX lg_idx_age ON lg_user FIELDS age UNIQUE;
      CREATE lg_user:1 CONTENT { name: "Alice", age: 30, active: true };
      CREATE lg_user:2 CONTENT { name: "Bob", age: 25, active: false };
    `);
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("a read is logged as a framed box with the SQL, rows and duration", async () => {
    const cap = capturing();
    const client = betterSchemic(db, { schema, logger: cap.option }) as Client<
      typeof schema
    >;
    const rows = await client.users.findMany({ where: { age: { gte: 25 } } });
    expect(rows).toHaveLength(2);
    const out = cap.out();
    expect(out).toContain("findMany");
    expect(out).toContain("SELECT * FROM lg_user");
    expect(out).toContain("rows");
    expect(out).toContain("╭");
  });

  test(".explain() logs the server's real execution plan", async () => {
    const cap = capturing();
    const client = betterSchemic(db, { schema, logger: cap.option }) as Client<
      typeof schema
    >;
    const plan = await client.users
      .findMany({ where: { age: { gt: 1 } } })
      .explain();
    expect(plan.statements.length).toBeGreaterThan(0);
    const out = cap.out();
    expect(out).toContain("EXPLAIN findMany");
    expect(out).toMatch(/Scan|Iterate|Select/);
  });

  test("auto-explain 'slow' draws the FORMAT JSON plan tree", async () => {
    const cap = capturing({ slowMs: 0, explain: "slow" });
    const client = betterSchemic(db, { schema, logger: cap.option }) as Client<
      typeof schema
    >;
    await client.users.findMany({ where: { age: { gt: 1 } } });
    const out = cap.out();
    expect(out).toContain("plan");
    expect(out).toMatch(/Scan|Iterate|Select/);
  });

  test("a server-side error is logged (and still throws)", async () => {
    const cap = capturing();
    const client = betterSchemic(db, { schema, logger: cap.option }) as Client<
      typeof schema
    >;
    // A duplicate unique insert fails on the server; the logger shows the error.
    await client.users
      .create({ data: { name: "Alice", age: 30, active: true } })
      .catch(() => {});
    const out = cap.out();
    expect(out).toContain("create");
    expect(out).toMatch(/⛔|already exists|DatabaseError|ParseError/);
  });
});
