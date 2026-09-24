// M5 — raw escape hatches, context scoping, functions, APIs and admin end-to-end against an
// ephemeral server: parameterized `$raw`/`$query`, multi-tenant `$withContext` (no session leak),
// `fn.call`, `DEFINE API`, `info`/`version`/`ping`/`export`/`import`. Skipped without a `surreal`
// binary.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Surreal } from "surrealdb";
import {
  type EphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineFunction, defineTable, s } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { isBetterSchemicError } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught } from "../orm-fixtures";
import { startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED) console.warn("[orm-raw] `surreal` binary unavailable — skipping");

const Item = defineTable("item", { name: s.string() });
const Add = defineFunction("add", { a: s.number(), b: s.number() }).returns(
  s.number(),
);
const schema = defineSchema({ items: Item, add: Add });

/** `[id, name]` pairs — decoded ids are SDK `RecordId` instances. */
const labelled = async (
  source: Client<typeof schema>,
): Promise<[string, string][]> =>
  (await source.items.findMany()).map((row) => [String(row.id), row.name]);

live("orm raw / context / fn / api / admin — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    const started = await startLiveServer({
      namespace: "root_ns",
      database: "main",
      ddl: `
        DEFINE TABLE item SCHEMAFULL;
        DEFINE FIELD name ON item TYPE string;
        CREATE item:root CONTENT { name: "root" };
        DEFINE FUNCTION fn::add($a: number, $b: number) { RETURN $a + $b; };
        DEFINE API '/articles' FOR get THEN { RETURN { status: 200, body: (SELECT * FROM item) }; }
          FOR post THEN { RETURN { status: 201, body: $request.body }; };
        DEFINE API '/boom' FOR get THEN { RETURN { status: 418, body: { why: "teapot" } }; };

        DEFINE NAMESPACE tenant_a;
        USE NS tenant_a DB app;
        DEFINE TABLE item SCHEMAFULL;
        DEFINE FIELD name ON item TYPE string;
        CREATE item:a CONTENT { name: "tenant-a" };
        DEFINE FUNCTION fn::add($a: number, $b: number) { RETURN $a + $b; };

        DEFINE NAMESPACE tenant_b;
        USE NS tenant_b DB app;
        DEFINE TABLE item SCHEMAFULL;
        DEFINE FIELD name ON item TYPE string;
        CREATE item:b CONTENT { name: "tenant-b" };
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

  test("$raw parameterizes and $query runs a multi-statement script", async () => {
    const rows = await client.$raw<{ id: unknown; name: string }[]>`
      SELECT * FROM item WHERE name = ${"root"}
    `;
    expect(rows.map((row) => [String(row.id), row.name])).toEqual([
      ["item:root", "root"],
    ]);

    const results = await client.$query<[unknown, string]>`
      LET $x = ${10}; IF $x > 5 THEN RETURN 'big' ELSE RETURN 'small' END;
    `;
    expect(results.at(-1)).toBe("big");
  });

  test("$unsafe is gated and raw.requireComment enforces a reason", async () => {
    const unsafe = await caught(() => client.$unsafe("SELECT * FROM item"));
    expect(isBetterSchemicError(unsafe) && unsafe.code).toBe("UnsafeDisabled");

    const open = betterSchemic(db, {
      schema,
      raw: { unsafe: true, requireComment: true },
    });
    await open.$unsafe("SELECT * FROM item");
    const missing = await caught(() => open.$raw("DELETE item"));
    expect(isBetterSchemicError(missing) && missing.code).toBe(
      "ValidationError",
    );
    await open.$raw("DELETE item", { meta: { comment: "cleanup" } });
    // The curried tag carries the comment into the template form.
    await open.$raw({
      meta: { comment: "re-seed" },
    })`CREATE item:root CONTENT { name: 'root' }`;
    expect((await labelled(client)).map(([, name]) => name)).toContain("root");
  });

  test("$withContext routes to a namespace without leaking the session", async () => {
    const tenantA = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    const tenantB = client.$withContext({
      namespace: "tenant_b",
      database: "app",
    });

    expect(await labelled(tenantA)).toEqual([["item:a", "tenant-a"]]);
    expect(await labelled(tenantB)).toEqual([["item:b", "tenant-b"]]);
    // The parent session never left root_ns/main.
    expect(db.namespace).toBe("root_ns");
    expect(db.database).toBe("main");
    expect(await labelled(client)).toEqual([["item:root", "root"]]);

    // A per-call context overrides the clone's namespace.
    const cross = await tenantA.items.findMany({
      context: { namespace: "tenant_b" },
    });
    expect(cross.map((row) => [String(row.id), row.name])).toEqual([
      ["item:b", "tenant-b"],
    ]);
  });

  test("$withContext clones reject session-bound ops; import stays context-aware", async () => {
    const tenantA = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    const api = await caught(() => tenantA.api.get("/articles"));
    expect(isBetterSchemicError(api) && api.code).toBe("UnsupportedCapability");
    const dump = await caught(() => tenantA.export());
    expect(isBetterSchemicError(dump) && dump.code).toBe(
      "UnsupportedCapability",
    );

    await tenantA.import(
      "DELETE item; CREATE item:a CONTENT { name: 'tenant-a' };",
    );
    expect(await tenantA.items.count()).toBe(1);
  });

  test("a transaction inside a context clone writes to the scoped namespace", async () => {
    const tenantA = client.$withContext({
      namespace: "tenant_a",
      database: "app",
    });
    await tenantA.transaction(async (tx) => {
      await tx.items.create({ data: { name: "tx-a" } });
    });
    expect((await labelled(tenantA)).map(([, name]) => name)).toContain("tx-a");
    // The root namespace never saw it.
    expect((await labelled(client)).map(([, name]) => name)).not.toContain(
      "tx-a",
    );
    // `fn.call` resolves in the clone's namespace too.
    expect(await tenantA.fn.call<number>("fn::add", [4, 5])).toBe(9);

    // The implicit batch wrapper prefixes USE before BEGIN (one round-trip).
    await tenantA.items.createMany({ data: [{ name: "batch-a" }] });
    expect((await labelled(tenantA)).map(([, name]) => name)).toContain(
      "batch-a",
    );
    expect((await labelled(client)).map(([, name]) => name)).not.toContain(
      "batch-a",
    );
  });

  test("fn.call and the typed shortcut hit the server function", async () => {
    expect(await client.fn.call<number>("fn::add", [2, 3])).toBe(5);
    expect(await client.fn.add({ a: 20, b: 22 })).toBe(42);
    const inside = await client.transaction(async (tx) =>
      tx.fn.call<number>("fn::add", [1, 1]),
    );
    expect(inside).toBe(2);
  });

  test("api unwraps the body and throws on a >=400 status", async () => {
    const articles =
      await client.api.get<{ id: unknown; name: string }[]>("/articles");
    expect(articles.map((row) => [String(row.id), row.name])).toEqual([
      ["item:root", "root"],
    ]);

    const echoed = await client.api.post<{ hello: string }>("/articles", {
      body: { hello: "world" },
    });
    expect(echoed).toEqual({ hello: "world" });

    const boom = await caught(() => client.api.get("/boom"));
    expect(isBetterSchemicError(boom) && boom.code).toBe("DatabaseError");
    expect(isBetterSchemicError(boom) && boom.status).toBe(418);
    expect(isBetterSchemicError(boom) && boom.details).toEqual({
      why: "teapot",
    });
  });

  test("admin: info/version/ping/export/import", async () => {
    const info = await client.info("db");
    expect(Object.keys(info.tables ?? {})).toContain("item");
    expect((await client.version()).version).toContain("surrealdb-");
    expect(await client.ping()).toBe(true);

    const dump = await client.export();
    expect(typeof dump).toBe("string");
    await db.query("DELETE item;");
    expect(await client.items.count()).toBe(0);
    await client.import(dump);
    expect(await client.items.count()).toBe(1);
  });

  test("$withContext({ auth }) forks an authenticated session", async () => {
    const tokens = await client.auth.signin({
      username: server.username,
      password: server.password,
    });
    const scoped = await client.$withContext({
      namespace: "tenant_b",
      database: "app",
      auth: tokens,
    });
    expect(await labelled(scoped)).toEqual([["item:b", "tenant-b"]]);
    await scoped.close();
  });

  test("auth.record() on a non-record session teaches NotAuthenticated", async () => {
    const error = await caught(() => client.auth.record());
    expect(isBetterSchemicError(error) && error.code).toBe("NotAuthenticated");
  });
});
