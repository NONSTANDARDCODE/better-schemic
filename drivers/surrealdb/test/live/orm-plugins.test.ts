// M6.4 — the OFFICIAL plugins against a REAL server: `soft-delete` (delete -> update, read hiding,
// `restore`) and `timestamps` (app mode). M14 adds `create-only` (guard + hard event). Ephemeral
// server; skipped without `surreal`.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { surrealBinaryAvailable } from "../../src/cli/engine";
import { emitTable } from "../../src/ddl";
import { betterSchemic } from "../../src/orm/client";
import type { Delegate } from "../../src/orm/delegate";
import {
  BetterSchemicError,
  isCreateOnlyViolation,
} from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { createOnly, createOnlyGuard } from "../../src/plugins/create-only";
import { softDelete } from "../../src/plugins/soft-delete";
import { timestamps } from "../../src/plugins/timestamps";
import { defineTable, s } from "../../src/pure";
import { caught } from "../orm-fixtures";
import { type LiveServer, startLiveServer } from "./harness";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-plugins] `surreal` binary unavailable — skipping");

const User = defineTable("sd_user", {
  name: s.string(),
  deletedAt: s.datetime().optional(),
});
const schema = defineSchema({ users: User });

/** A model with the soft-delete `extendModel` methods. */
type SoftModel = Delegate<typeof User> & {
  restore(args: { where: unknown }): Promise<unknown>;
  restoreById(id: unknown): Promise<unknown>;
};

live("orm plugins — live", () => {
  let live_: LiveServer;

  beforeAll(async () => {
    live_ = await startLiveServer({
      namespace: "orm_plugins",
      database: "live",
      ddl: "DEFINE TABLE IF NOT EXISTS sd_user SCHEMALESS;",
    });
  });

  afterAll(async () => {
    await live_?.stop();
  });

  test("soft-delete: delete becomes an update and reads hide deleted rows", async () => {
    const client = betterSchemic(live_.db, { schema, plugins: [softDelete()] });
    const created = await client.users.create({ data: { name: "ada" } });
    expect(created.id).toBeDefined();

    expect(
      (await client.users.findMany({})).some((row) => row.name === "ada"),
    ).toBe(true);

    await client.users.delete({ where: { id: created.id } });

    // The row still exists (soft-deleted), so the unfiltered read hides it…
    expect(
      (await client.users.findMany({})).some((row) => row.name === "ada"),
    ).toBe(false);
    // …but `deleted: "with"` reveals it, with the timestamp set.
    const all = await client.users.findMany({ deleted: "with" });
    const gone = all.find((row) => row.name === "ada") as
      | { deletedAt?: unknown }
      | undefined;
    expect(gone?.deletedAt).toBeDefined();

    // restore() clears the column and the row is visible again.
    await (client.users as unknown as SoftModel).restoreById(created.id);
    expect(
      (await client.users.findMany({})).some((row) => row.name === "ada"),
    ).toBe(true);
  });

  test("timestamps: app mode stamps createdAt/updatedAt", async () => {
    const Stamp = defineTable("ts_user", {
      name: s.string(),
      createdAt: s.datetime().optional(),
      updatedAt: s.datetime().optional(),
    });
    const tsSchema = defineSchema({ users: Stamp });
    await live_.db.query("DEFINE TABLE IF NOT EXISTS ts_user SCHEMALESS;");
    const client = betterSchemic(live_.db, {
      schema: tsSchema,
      plugins: [timestamps()],
    });
    const created = await client.users.create({ data: { name: "ada" } });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  test("create-only (soft): create stamps createdAt only; the guard blocks update; $withoutPlugins escapes (root)", async () => {
    const CoSoft = defineTable("co_soft", {
      action: s.string(),
      createdAt: s.datetime().optional(),
    }).use(createOnly());
    const coSchema = defineSchema({ logs: CoSoft });
    await live_.db.query(emitTable(CoSoft));
    const client = betterSchemic(live_.db, {
      schema: coSchema,
      plugins: [timestamps(), createOnlyGuard()],
    });

    const created = await client.logs.create({ data: { action: "login" } });
    expect(created.createdAt).toBeInstanceOf(Date);
    expect((created as { updatedAt?: unknown }).updatedAt).toBeUndefined();

    // The runtime guard rejects BEFORE compiling…
    const blocked = await caught(() =>
      client.logs.update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    );
    expect(isCreateOnlyViolation(blocked)).toBe(true);

    // …and the unchanged row survives; `$withoutPlugins()` is the documented root/admin escape
    // (the DB permission only gates record users — root sessions pass).
    const raw = await client.logs.$withoutPlugins().update({
      where: { id: created.id },
      data: { action: "logout" },
    });
    expect(raw?.action).toBe("logout");
  });

  test("create-only (hard): the event blocks even $withoutPlugins (root) at the database", async () => {
    const CoHard = defineTable("co_hard", {
      action: s.string(),
      createdAt: s.datetime().optional(),
    }).use(createOnly({ hard: true }));
    const coSchema = defineSchema({ logs: CoHard });
    await live_.db.query(emitTable(CoHard));
    const client = betterSchemic(live_.db, {
      schema: coSchema,
      plugins: [timestamps(), createOnlyGuard()],
    });

    const created = await client.logs.create({ data: { action: "login" } });
    expect(created.createdAt).toBeInstanceOf(Date);

    const blocked = await caught(() =>
      client.logs.update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    );
    expect(isCreateOnlyViolation(blocked)).toBe(true);

    // The hard event runs without permission checks: even this root session's escape is rejected
    // by the database (THROW), and the row is untouched.
    const hardBlocked = await caught(() =>
      client.logs.$withoutPlugins().update({
        where: { id: created.id },
        data: { action: "logout" },
      }),
    );
    expect(hardBlocked).toBeInstanceOf(BetterSchemicError);
    expect(String(hardBlocked)).toContain("append-only");
    const after = await client.logs.findFirst({ where: { id: created.id } });
    expect(after?.action).toBe("login");
  });
});
