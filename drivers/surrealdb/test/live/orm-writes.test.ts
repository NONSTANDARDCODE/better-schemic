// M2 — the write surface against a REAL server: create/insert/update/patch/upsert/delete/
// updateEach and the edge operations, decoded to app values and with normalized errors. Ephemeral
// server; skipped when no `surreal` binary is available.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RecordId, Surreal } from "surrealdb";
import {
  type EphemeralServer,
  spawnEphemeralServer,
  surrealBinaryAvailable,
} from "../../src/cli/engine";
import { defineRelation, defineTable, s, surql } from "../../src/index";
import { betterSchemic, type Client } from "../../src/orm/client";
import { isUniqueViolation } from "../../src/orm/errors";
import { defineSchema } from "../../src/orm/schema";
import { caught } from "../orm-fixtures";

const ENABLED = surrealBinaryAvailable();
const live = describe.skipIf(!ENABLED);
if (!ENABLED)
  console.warn("[orm-writes] `surreal` binary unavailable — skipping");

const User = defineTable("wr_user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  active: s.boolean(),
  tags: s.array(s.string()).optional(),
  address: s.object({ city: s.string() }),
}).index("wr_idx_email", ["email"], { unique: true });
const Post = defineTable("wr_post", { title: s.string(), views: s.int() });
const Likes = defineRelation("wr_likes", { score: s.int() })
  .from(User)
  .to(Post);
const schema = defineSchema({ users: User, posts: Post, likes: Likes });

const base = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@x.dev`,
  age: 30,
  active: true,
  tags: ["db"],
  address: { city: "SP" },
});

live("orm writes — live", () => {
  let server: EphemeralServer;
  let db: Surreal;
  let client: Client<typeof schema>;

  beforeAll(async () => {
    server = await spawnEphemeralServer();
    db = new Surreal();
    await db.connect(server.url, { reconnect: false });
    await db.signin({ username: server.username, password: server.password });
    await db.use({ namespace: "orm_writes", database: "live" });
    await db.query(`
      REMOVE TABLE IF EXISTS wr_user;
      REMOVE TABLE IF EXISTS wr_post;
      REMOVE TABLE IF EXISTS wr_likes;
      DEFINE TABLE wr_user SCHEMAFULL;
      DEFINE FIELD name ON wr_user TYPE string;
      DEFINE FIELD email ON wr_user TYPE string;
      DEFINE FIELD age ON wr_user TYPE int;
      DEFINE FIELD active ON wr_user TYPE bool DEFAULT true;
      DEFINE FIELD tags ON wr_user TYPE option<array<string>>;
      DEFINE FIELD address ON wr_user TYPE object;
      DEFINE FIELD address.city ON wr_user TYPE string;
      DEFINE INDEX wr_idx_email ON wr_user FIELDS email UNIQUE;
      DEFINE TABLE wr_post SCHEMAFULL;
      DEFINE FIELD title ON wr_post TYPE string;
      DEFINE FIELD views ON wr_post TYPE int;
      DEFINE TABLE wr_likes TYPE RELATION IN wr_user OUT wr_post;
      DEFINE FIELD score ON wr_likes TYPE int;
    `);
    client = betterSchemic(db, { schema });
  });

  afterAll(async () => {
    await db?.close().catch(() => {});
    await server?.stop();
  });

  test("create: codec-decoded row, only, return none/diff", async () => {
    const row = await client.users.create({ data: base("Create") });
    expect(row).toMatchObject({ name: "Create", age: 30, active: true });
    expect(row.id).toBeInstanceOf(RecordId);
    expect(String(row.id)).toStartWith("wr_user:");

    const one = await client.users.create({
      data: { ...base("Only"), id: "wr_user:only" },
      only: true,
    });
    expect(one).toMatchObject({ name: "Only" });
    expect(one).not.toBeInstanceOf(Array);

    expect(
      await client.users.create({ data: base("None"), return: "none" }),
    ).toBeNull();
    const diff = await client.users.create({
      data: base("Diff"),
      return: "diff",
    });
    expect(Array.isArray(diff)).toBe(true);
  });

  test("createMany in ONE round-trip; skipDuplicates skips existing ids", async () => {
    const result = await client.users.createMany({
      data: [base("Many1"), base("Many2")],
    });
    expect(result.count).toBe(2);
    expect(result.data ?? []).toHaveLength(2);
    expect(result.statements).toBe(2);

    await client.users.create({
      data: { ...base("Skip"), id: "wr_user:skip" },
    });
    const skipped = await client.users.createMany({
      data: [
        { ...base("Skip"), id: "wr_user:skip" },
        { ...base("Skip2"), id: "wr_user:skip2" },
      ],
      skipDuplicates: true,
    });
    expect(skipped.count).toBe(1);
    expect(skipped.skipped).toBe(1);
  });

  test("create.relate creates the edge in the same batch", async () => {
    await client.users.create({ data: { ...base("Rel"), id: "wr_user:rel" } });
    const post = await client.posts.create({
      data: { title: "RelPost", views: 0 },
      relate: [
        {
          from: "wr_user:rel",
          edge: "wr_likes",
          to: "$self",
          data: { score: 0 },
        },
      ],
    });
    const edges = await client.likes.findMany({
      where: { in: "wr_user:rel" as never, out: post.id as never },
    });
    expect(edges).toHaveLength(1);
  });

  test("create duplicate id normalizes to RecordAlreadyExists", async () => {
    await client.users.create({ data: { ...base("Dup"), id: "wr_user:dup" } });
    const error = await client.users
      .create({ data: { ...base("Dup"), id: "wr_user:dup" } })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
  });

  test("insert / insertMany with onDuplicate ignore|update|map", async () => {
    const inserted = await client.users.insert({
      data: { id: "wr_user:ins", ...base("Ins") },
    });
    expect(inserted).toMatchObject({ name: "Ins" });

    const ignored = await client.users.insertMany({
      data: [
        { id: "wr_user:ins", ...base("InsDup") },
        { id: "wr_user:ins2", ...base("Ins2") },
      ],
      onDuplicate: "ignore",
    });
    expect(ignored.count).toBe(1);
    expect(ignored.skipped).toBe(1);

    const updated = await client.users.insert({
      data: { id: "wr_user:ins", ...base("InsUpd"), age: 41 },
      onDuplicate: "update",
    });
    expect(updated).toMatchObject({ name: "InsUpd", age: 41 });

    const mapped = await client.users.insert({
      data: { id: "wr_user:ins", ...base("InsMap"), age: 50 },
      onDuplicate: { name: surql`string::uppercase($input.name)` },
    });
    expect(mapped).toMatchObject({ name: "INSMAP" });

    const before = await client.users.insert({
      data: { id: "wr_user:ins", ...base("InsBefore"), age: 50 },
      onDuplicate: "update",
      return: "before",
    });
    expect(before).toMatchObject({ name: "INSMAP" });
  });

  test("update: modes, expressions, unset, miss→null/.throw()", async () => {
    await client.users.create({
      data: { ...base("Upd"), id: "wr_user:upd", tags: ["a", "b"] },
    });

    const merged = await client.users.update({
      where: { id: "wr_user:upd" },
      data: { age: 31 },
    });
    expect(merged).toMatchObject({ age: 31, name: "Upd" });

    const set = await client.users.update({
      where: { id: "wr_user:upd" },
      mode: "set",
      data: { age: surql`age + 9` },
    });
    expect(set).toMatchObject({ age: 40 });

    const content = await client.users.update({
      where: { id: "wr_user:upd" },
      mode: "content",
      data: { ...base("Upd"), age: 32 },
    });
    expect(content).toMatchObject({ age: 32, tags: ["db"] });

    const unset = await client.users.update({
      where: { id: "wr_user:upd" },
      data: { active: false },
      unset: ["tags"],
    });
    expect(unset).toMatchObject({ active: false });
    expect((unset as Record<string, unknown>).tags).toBeUndefined();

    expect(
      await client.users.update({
        where: { id: "wr_user:ghost" },
        data: { age: 1 },
      }),
    ).toBeNull();
    await expect(
      client.users
        .update({ where: { id: "wr_user:ghost" }, data: { age: 1 } })
        .throw(),
    ).rejects.toMatchObject({ code: "ResultNotFound" });
  });

  test("update by unique field and updateMany whole table", async () => {
    await client.users.create({
      data: { ...base("ByEmail"), id: "wr_user:byemail" },
    });
    const updated = await client.users.update({
      where: { email: "byemail@x.dev" },
      data: { age: 77 },
    });
    expect(updated).toMatchObject({
      id: new RecordId("wr_user", "byemail"),
      age: 77,
    });

    const many = await client.users.updateMany({
      where: { age: 77 },
      data: { active: false },
    });
    expect(many.count).toBe(1);
    expect(many.data?.[0]).toMatchObject({ active: false });
  });

  test("patch: JSON Patch ops apply and RETURN DIFF yields a flat patch list", async () => {
    await client.users.create({
      data: { ...base("Patch"), id: "wr_user:patch", tags: ["a"] },
    });
    const patched = await client.users.patch({
      where: { id: "wr_user:patch" },
      patches: [
        { op: "replace", path: "/age", value: 45 },
        { op: "add", path: "/tags/-", value: "b" },
      ],
    });
    expect(patched).toMatchObject({ age: 45, tags: ["a", "b"] });

    const diff = await client.users.patch({
      where: { id: "wr_user:patch" },
      patches: [{ op: "replace", path: "/age", value: 46 }],
      return: "diff",
    });
    expect(diff).toContainEqual(
      expect.objectContaining({ op: "replace", path: "/age", value: 46 }),
    );
  });

  test("upsert: strict miss, by id, by unique (creates), distinct create/update", async () => {
    // STRICT is the default: a missing target rejects ResultNotFound instead of creating.
    const miss = await caught(() =>
      client.users.upsert({
        where: { id: "wr_user:missing" },
        data: { age: 1 },
      }),
    );
    expect((miss as { code?: string }).code).toBe("ResultNotFound");
    expect(
      await client.users.findUnique({ where: { id: "wr_user:missing" } }),
    ).toBeNull();

    const byId = await client.users.upsert({
      where: { id: "wr_user:upsert" },
      data: { ...base("Upsert"), id: "wr_user:upsert" },
      onMissing: "create",
    });
    expect(byId).toMatchObject({ name: "Upsert" });

    const again = await client.users.upsert({
      where: { id: "wr_user:upsert" },
      data: { age: 60 },
    });
    expect(again).toMatchObject({ name: "Upsert", age: 60 });

    const byEmail = await client.users.upsert({
      where: { email: "newupsert@x.dev" },
      data: { ...base("NewUpsert"), email: "newupsert@x.dev" },
      onMissing: "create",
    });
    expect(byEmail).toMatchObject({ name: "NewUpsert" });

    const branches = await client.users.upsert({
      where: { id: "wr_user:branches" },
      create: { ...base("Branches"), id: "wr_user:branches", age: 1 },
      update: {
        age: surql`(SELECT VALUE age FROM ONLY wr_user:branches) + 10`,
      },
      onMissing: "create",
    });
    expect(branches).toMatchObject({ name: "Branches", age: 1 });
    const branches2 = await client.users.upsert({
      where: { id: "wr_user:branches" },
      create: { ...base("Branches"), id: "wr_user:branches", age: 1 },
      update: {
        age: surql`(SELECT VALUE age FROM ONLY wr_user:branches) + 10`,
      },
      onMissing: "create",
    });
    expect(branches2).toMatchObject({ age: 11 });
  });

  test("upsert: target-less creates; data.id infers a STRICT target", async () => {
    // No `where` and no `data.id` → a plain CREATE with the server-side idStrategy.
    const fresh = await client.users.upsert({ data: base("NoTarget") });
    expect(fresh.id).toBeInstanceOf(RecordId);
    expect(String(fresh.id)).toStartWith("wr_user:");
    expect(fresh).toMatchObject({ name: "NoTarget", age: 30 });

    // `data.id` alone names the target; the payload id MATCHES the MERGE target (live-checked).
    await client.users.create({
      data: { ...base("Inferred"), id: "wr_user:inferred" },
    });
    const updated = await client.users.upsert({
      data: { id: "wr_user:inferred", age: 62 },
    });
    expect(updated).toMatchObject({ name: "Inferred", age: 62 });

    // A missing inferred target is still STRICT: ResultNotFound, never a create.
    const miss = await caught(() =>
      client.users.upsert({ data: { id: "wr_user:inferred_missing", age: 1 } }),
    );
    expect((miss as { code?: string }).code).toBe("ResultNotFound");
    expect(
      await client.users.findUnique({
        where: { id: "wr_user:inferred_missing" },
      }),
    ).toBeNull();

    // `onMissing: "create"` restores create-or-update over the inferred target.
    const created = await client.users.upsert({
      data: { id: "wr_user:inferred_new", ...base("InferredNew") },
      onMissing: "create",
    });
    expect(created).toMatchObject({ name: "InferredNew" });
  });

  test("upsertMany: with ids (one statement) and by conflict field", async () => {
    const withIds = await client.users.upsertMany({
      data: [
        { id: "wr_user:um1", ...base("UM1") },
        { id: "wr_user:um2", ...base("UM2") },
      ],
    });
    expect(withIds.count).toBe(2);

    const conflict = await client.users.upsertMany({
      data: [{ ...base("Conflict"), email: "conflict@x.dev", age: 5 }],
      conflict: "email",
    });
    expect(conflict.count).toBe(1);
    const conflict2 = await client.users.upsertMany({
      data: [{ ...base("Conflict"), email: "conflict@x.dev", age: 6 }],
      conflict: "email",
    });
    expect(conflict2.count).toBe(1);
    const rows = await client.users.findMany({
      where: { email: "conflict@x.dev" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.age).toBe(6);
  });

  test("delete / deleteMany with RETURN rules", async () => {
    await client.users.create({ data: { ...base("Del"), id: "wr_user:del" } });
    const removed = await client.users.delete({ where: { id: "wr_user:del" } });
    expect(removed).toMatchObject({ name: "Del" });
    expect(
      await client.users.delete({ where: { id: "wr_user:del" } }),
    ).toBeNull();

    await client.users.createMany({
      data: [
        { ...base("DelMany1"), id: "wr_user:dm1", age: 90 },
        { ...base("DelMany2"), id: "wr_user:dm2", age: 90 },
      ],
    });
    const many = await client.users.deleteMany({ where: { age: 90 } });
    expect(many.count).toBe(2);
    expect(many.data).toBeUndefined();

    const all = await client.users.deleteMany({
      where: { age: 999 },
      return: "none",
    });
    expect(all.count).toBeUndefined();
  });

  test("updateEach: per-item values, skipped and onEmpty throw", async () => {
    await client.users.createMany({
      data: [
        { ...base("Each1"), id: "wr_user:each1", age: 1 },
        { ...base("Each2"), id: "wr_user:each2", age: 2 },
      ],
    });
    const result = await client.users.updateEach({
      data: [
        { id: "wr_user:each1", age: 11 },
        { id: "wr_user:each2", age: 12 },
        { id: "wr_user:each3", age: 13 },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.skipped).toBe(1);
    const rows = await client.users.findMany({
      where: {
        id: {
          in: [
            new RecordId("wr_user", "each1"),
            new RecordId("wr_user", "each2"),
          ],
        },
      },
      orderBy: [{ age: "asc" }],
    });
    expect(rows.map((row) => row.age)).toEqual([11, 12]);

    await expect(
      client.users.updateEach({
        data: [{ id: "wr_user:each3", age: 13 }],
        onEmpty: "throw",
      }),
    ).rejects.toMatchObject({ code: "ResultNotFound" });
  });

  test("updateEach by a custom unique field", async () => {
    await client.users.create({
      data: { ...base("ByField"), id: "wr_user:byfield" },
    });
    const result = await client.users.updateEach({
      by: "email",
      data: [{ email: "byfield@x.dev", age: 88 }],
    });
    expect(result.count).toBe(1);
    const rows = await client.users.findMany({
      where: { email: "byfield@x.dev" },
    });
    expect(rows[0]?.age).toBe(88);
  });

  test("relate / relateMany / unrelate / unrelateMany", async () => {
    await client.users.createMany({
      data: [
        { ...base("Edge1"), id: "wr_user:edge1" },
        { ...base("Edge2"), id: "wr_user:edge2" },
      ],
    });
    const post = await client.posts.create({
      data: { title: "EdgePost", views: 1 },
    });

    const edge = await client.likes.relate({
      from: "wr_user:edge1",
      to: post.id,
      data: { score: 5 },
    });
    expect(edge).toMatchObject({ score: 5 });
    expect(edge.in).toEqual(new RecordId("wr_user", "edge1"));

    const named = await client.likes.relate({
      from: "wr_user:edge1",
      to: post.id,
      id: "named1",
      data: { score: 0 },
    });
    expect(String(named.id)).toBe("wr_likes:named1");

    const many = await client.likes.relateMany({
      data: [
        { from: "wr_user:edge2", to: post.id, data: { score: 1 } },
        { from: "wr_user:edge2", to: post.id, data: { score: 2 } },
      ],
    });
    expect(many.count).toBe(2);

    const unrelate = await client.likes.unrelate({
      from: "wr_user:edge2",
      to: post.id,
    });
    expect(unrelate.count).toBe(2);

    const removedMany = await client.likes.unrelateMany({
      where: { score: 5 },
    });
    expect(removedMany.count).toBe(1);
    expect(await client.likes.findMany({ where: { score: 5 } })).toHaveLength(
      0,
    );
  });

  test("endpoint validation rejects a wrong FROM table", async () => {
    const post = await client.posts.create({
      data: { title: "WrongEp", views: 0 },
    });
    expect(() =>
      client.likes.relate({ from: post.id as never, to: post.id as never }),
    ).toThrow(/not a declared FROM endpoint/);
  });

  test("batch return:'diff' returns flat patch ops (updateMany/createMany)", async () => {
    await client.users.create({
      data: { ...base("DiffMany"), id: "wr_user:diffmany", age: 10 },
    });
    const diff = await client.users.updateMany({
      where: { age: 10 },
      data: { age: 11 },
      return: "diff",
    });
    expect(diff).toContainEqual(
      expect.objectContaining({ op: "replace", path: "/age", value: 11 }),
    );

    const created = await client.users.createMany({
      data: [
        { ...base("DiffCreate1"), id: "wr_user:diffc1" },
        { ...base("DiffCreate2"), id: "wr_user:diffc2" },
      ],
      return: "diff",
    });
    expect(Array.isArray(created)).toBe(true);
    expect(created.length).toBeGreaterThan(0);
  });

  test("upsertMany conflict + update map updates only the listed fields", async () => {
    const first = await client.users.upsertMany({
      data: [{ ...base("UMConflict"), email: "umc@x.dev", age: 1 }],
      conflict: "email",
      update: { age: 2 },
    });
    expect(first.count).toBe(1);
    const second = await client.users.upsertMany({
      data: [{ ...base("UMConflict2"), email: "umc@x.dev", age: 9 }],
      conflict: "email",
      update: { age: 3 },
    });
    expect(second.count).toBe(1);
    const rows = await client.users.findMany({
      where: { email: "umc@x.dev" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.age).toBe(3);
    expect(rows[0]?.name).toBe("UMConflict");
  });

  test("upsert create/update with before returns the previous row on conflict", async () => {
    await client.users.create({
      data: { ...base("BeforeUpsert"), id: "wr_user:beforeup", age: 1 },
    });
    const before = await client.users.upsert({
      where: { id: "wr_user:beforeup" },
      create: { ...base("BeforeUpsert"), id: "wr_user:beforeup", age: 1 },
      update: { age: surql`age + 10` },
      return: "before",
      onMissing: "create",
    });
    expect(before).toMatchObject({ age: 1 });
  });

  test("updateEach select projects the returned rows", async () => {
    await client.users.create({
      data: { ...base("EachSel"), id: "wr_user:eachsel", age: 20 },
    });
    const result = await client.users.updateEach({
      data: [{ id: "wr_user:eachsel", age: 21 }],
      select: { id: true, age: true },
    });
    expect(result.count).toBe(1);
    expect(result.data?.[0]).toEqual({
      id: new RecordId("wr_user", "eachsel"),
      age: 21,
    });
  });

  test("write projections: server RETURN, client BEFORE/omit and counters", async () => {
    const row = await client.users.create({ data: base("Proj") });

    // Server-side projection rides the statement's own RETURN clause.
    const projected = await client.users
      .update({
        where: { id: row.id },
        data: { age: 31 },
        select: { id: true, age: true, city: "address.city" },
      })
      .throw();
    expect(projected).toEqual({ id: row.id, age: 31, city: "SP" });

    // BEFORE state is projected client-side (RETURN BEFORE <proj> is a parse error).
    const before = await client.users
      .update({
        where: { id: row.id },
        data: { age: 32 },
        return: "before",
        select: { age: true },
      })
      .throw();
    expect(before).toEqual({ age: 31 });

    // omit is client-side too.
    const omitted = await client.users
      .update({
        where: { id: row.id },
        data: { age: 33 },
        omit: ["email", "tags"],
      })
      .throw();
    expect(omitted).not.toHaveProperty("email");
    expect(omitted).not.toHaveProperty("tags");
    expect(omitted).toMatchObject({ age: 33, address: { city: "SP" } });

    // delete projects the removed row client-side.
    const deleted = await client.users.delete({
      where: { id: row.id },
      select: { name: true },
    });
    expect(deleted).toEqual({ name: "Proj" });

    // Counters: one server-side read-modify-write per call.
    const post = await client.posts.create({
      data: { title: "Counter", views: 10 },
    });
    const incremented = await client.posts.upsert({
      where: { id: post.id },
      data: { views: { increment: 5 } },
      select: { views: true },
    });
    expect(incremented).toEqual({ views: 15 });
    const previous = await client.posts
      .update({
        where: { id: post.id },
        data: { views: { decrement: 3 } },
        return: "before",
        select: { views: true },
      })
      .throw();
    expect(previous).toEqual({ views: 15 });
    const after = await client.posts.findUnique({
      where: { id: post.id },
      select: { views: true },
    });
    expect(after).toEqual({ views: 12 });

    await client.posts.updateEach({
      data: [{ id: post.id, views: { increment: 1 } }],
    });
    const final = await client.posts.findUnique({
      where: { id: post.id },
      select: { views: true },
    });
    expect(final).toEqual({ views: 13 });
  });

  test("create + relate return:'none' resolves null but creates the edge", async () => {
    await client.users.create({
      data: { ...base("RelNone"), id: "wr_user:relnone" },
    });
    const created = await client.posts.create({
      data: { title: "RelNone", views: 0 },
      relate: [
        {
          from: "wr_user:relnone",
          edge: "wr_likes",
          to: "$self",
          data: { score: 0 },
        },
      ],
      return: "none",
    });
    expect(created).toBeNull();
    const edges = await client.likes.findMany({
      where: { in: "wr_user:relnone" as never },
    });
    expect(edges).toHaveLength(1);
  });
});
