// M2 — the write compiler and the delegate writes: golden SQL/vars per form, the runtime envelopes
// (row/miss/batch/count), codec validation with expression splice, and the teaching guards. Offline.
// Return semantics + eager guards live in `orm-writes-returns.test.ts`; fixtures are shared there.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { surql } from "../../src/index";
import type { Client } from "../../src/orm/client";
import { betterSchemic } from "../../src/orm/client";
import { fakeConn, ok } from "../orm-fixtures";
import {
  codeOf,
  data,
  LIKE_ROW,
  lastCall,
  makeClient,
  ROW,
  schema,
  stable,
} from "./orm-writes-fixtures";

describe("create", () => {
  test("CREATE CONTENT with the codec-encoded payload", async () => {
    const { client, calls } = makeClient();
    await client.users.create({ data });
    expect(lastCall(calls)).toEqual({
      sql: "CREATE user CONTENT $p0;",
      vars: { p0: data },
    });
  });

  test("id payload binds a RecordId and targets CREATE ONLY t:id", async () => {
    const { client, calls } = makeClient();
    await client.users.create({
      data: { id: "user:aeon", ...data },
      only: true,
    });
    const call = lastCall(calls);
    expect(call.sql).toBe("CREATE ONLY user:aeon CONTENT $p0;");
    const payload = call.vars.p0 as { id: unknown };
    expect(payload.id).toBeInstanceOf(RecordId);
    expect(String(payload.id)).toBe("user:aeon");
  });

  test("return none/diff/only lower the RETURN clause", async () => {
    const { client, calls } = makeClient([]);
    await client.users.create({ data, return: "none" });
    expect(lastCall(calls).sql).toBe("CREATE user CONTENT $p0 RETURN NONE;");
    await client.users.create({ data, return: "diff" });
    expect(lastCall(calls).sql).toBe("CREATE user CONTENT $p0 RETURN DIFF;");
  });

  test("expression fields splice; literal fields stay codec-encoded", async () => {
    const { client, calls } = makeClient();
    await client.users.create({
      data: { ...data, name: surql`string::uppercase(${"a"})` },
    });
    const call = lastCall(calls);
    expect(stable(call.sql, call.vars)).toEqual({
      sql: "CREATE user CONTENT { email: $b0, age: $b1, active: $b2, tags: [], address: { city: $b3 }, name: string::uppercase($frag0) };",
      vars: { b0: "a@x", b1: 1, b2: true, b3: "SP", frag0: "a" },
    });
  });

  test("invalid data fails the codec with ValidationError", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.create({ data: { ...data, age: "old" } as never }),
      ),
    ).toBe("ValidationError");
  });

  test("createMany: N CREATEs in one transaction", async () => {
    const { client, calls } = makeClient();
    const p = client.users.createMany({ data: [data, { ...data, name: "B" }] });
    expect(calls[0]?.sql).toBe(
      "BEGIN TRANSACTION;\nCREATE user CONTENT $p0;\nCREATE user CONTENT $p1;\nCOMMIT TRANSACTION;",
    );
    const result = await p;
    expect(result.count).toBe(2);
    expect(result.statements).toBe(2);
  });

  test("createMany skipDuplicates compiles one INSERT IGNORE per row", async () => {
    let statement = 0;
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT"))
          return ok(null);
        statement += 1;
        return ok(statement === 1 ? [ROW] : []);
      }),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const result = await client.users.createMany({
      data: [
        { id: "user:1", ...data },
        { id: "user:2", ...data },
      ],
      skipDuplicates: true,
    });
    expect(calls[0]?.sql).toBe(
      "BEGIN TRANSACTION;\nINSERT IGNORE INTO user $p0;\nINSERT IGNORE INTO user $p1;\nCOMMIT TRANSACTION;",
    );
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test("relate sugar: LET + RELATE + RETURN in one transaction", async () => {
    const postRow = { id: new RecordId("post", "1"), title: "T" };
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map(() => ok([postRow])),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    await client.posts.create({
      data: { title: "T" },
      relate: [{ from: "user:1", edge: "likes", to: "$self" }],
    });
    expect(calls[0]?.sql).toBe(
      "BEGIN TRANSACTION;\nLET $__created = (CREATE ONLY post CONTENT $p0);\nRELATE user:1->likes->$__created;\nRETURN $__created;\nCOMMIT TRANSACTION;",
    );
  });
});

describe("insert", () => {
  test("INSERT INTO keeps payload ids; onDuplicate ignore/update/map", async () => {
    const { client, calls } = makeClient();
    await client.users.insert({ data: { id: "user:a", ...data } });
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0;");

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "ignore",
    });
    expect(lastCall(calls).sql).toBe("INSERT IGNORE INTO user $p0;");

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "update",
    });
    expect(lastCall(calls).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email, age = $input.age, active = $input.active, tags = $input.tags, address = $input.address;",
    );

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: { name: surql`$input.name`, age: surql`age + 1` },
    });
    expect(stable(lastCall(calls).sql, lastCall(calls).vars).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = ($input.name), age = (age + 1);",
    );
  });

  test("insert rejects arrays (insertMany) and allows RETURN BEFORE with onDuplicate", async () => {
    const { client, calls } = makeClient();
    expect(codeOf(() => client.users.insert({ data: [data] as never }))).toBe(
      "ValidationError",
    );
    await client.users.insert({
      data,
      onDuplicate: "ignore",
      return: "before",
    });
    expect(lastCall(calls).sql).toBe(
      "INSERT IGNORE INTO user $p0 RETURN BEFORE;",
    );
  });

  test("insertMany: one INSERT IGNORE, skipped = input - inserted", async () => {
    const { client } = makeClient([ROW]);
    const result = await client.users.insertMany({
      data: [
        { id: "user:1", ...data },
        { id: "user:2", ...data },
      ],
      onDuplicate: "ignore",
    });
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.statements).toBe(1);
  });
});

describe("update", () => {
  test("modes merge/set/content/replace", async () => {
    const { client, calls } = makeClient();
    await client.users.update({ where: { id: "user:1" }, data: { age: 2 } });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;");

    await client.users.update({
      where: { id: "user:1" },
      mode: "set",
      data: { age: 2, active: false },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 SET age = $p0, active = $p1;",
    );

    await client.users.update({
      where: { id: "user:1" },
      mode: "content",
      data,
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 CONTENT $p0;");

    await client.users.update({
      where: { id: "user:1" },
      mode: "replace",
      data,
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 REPLACE $p0;");
  });

  test("unique-field target compiles UPDATE t … WHERE uniq = $p", async () => {
    const { client, calls } = makeClient();
    await client.users.update({ where: { email: "a@x" }, data: { age: 2 } });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user MERGE $p1 WHERE email = $p0;",
    );
  });

  test("update NEVER creates: a miss resolves null and .throw() raises ResultNotFound", async () => {
    const { client } = makeClient([]);
    const miss = await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
    });
    expect(miss).toBeNull();
    await expect(
      client.users
        .update({ where: { id: "user:1" }, data: { age: 2 } })
        .throw(),
    ).rejects.toMatchObject({ code: "ResultNotFound" });
  });

  test("unset alone and combined with data (2 statements, transactional)", async () => {
    const { client, calls } = makeClient();
    await client.users.update({
      where: { id: "user:1" },
      unset: ["age", "tags"],
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 UNSET age, tags;");

    const p = client.users.update({
      where: { id: "user:1" },
      data: { active: true },
      unset: ["age"],
      timeout: "2s",
    });
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nUPDATE user:1 MERGE $p0 TIMEOUT 2s;\nUPDATE user:1 UNSET age TIMEOUT 2s;\nCOMMIT TRANSACTION;",
    );
    await p;
  });

  test("expression data splices (set mode)", async () => {
    const { client, calls } = makeClient();
    await client.users.update({
      where: { id: "user:1" },
      mode: "set",
      data: { age: surql`age + ${1}` },
    });
    const call = lastCall(calls);
    expect(stable(call.sql, call.vars)).toEqual({
      sql: "UPDATE user:1 SET age = (age + $frag0);",
      vars: { frag0: 1 },
    });
  });

  test("teaching guards: missing data, bad mode, non-unique where, unset id", () => {
    const { client } = makeClient();
    expect(codeOf(() => client.users.update({ where: { id: "user:1" } }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: 1 },
          mode: "drop" as never,
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        client.users.update({ where: { age: 1 }, data: { age: 2 } }),
      ),
    ).toBe("UniqueTargetRequired");
    expect(
      codeOf(() =>
        client.users.update({ where: { id: "user:1" }, unset: ["id"] }),
      ),
    ).toBe("ValidationError");
  });

  test("updateMany without a where updates the whole table", async () => {
    const { client, calls } = makeClient();
    const result = await client.users.updateMany({ data: { active: false } });
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p0;");
    expect(result.count).toBe(1);
  });
});

describe("patch", () => {
  test("UPDATE … PATCH $ops", async () => {
    const { client, calls } = makeClient();
    await client.users.patch({
      where: { id: "user:1" },
      patches: [
        { op: "replace", path: "/age", value: 31 },
        { op: "remove", path: "/tags/0" },
      ],
    });
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE user:1 PATCH $p0;",
      vars: {
        p0: [
          { op: "replace", path: "/age", value: 31 },
          { op: "remove", path: "/tags/0" },
        ],
      },
    });
  });

  test("invalid ops fail with a teaching ValidationError", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.patch({
          where: { id: "user:1" },
          patches: [{ op: "set", path: "/a" }] as never,
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        client.users.patch({
          where: { id: "user:1" },
          patches: [{ op: "replace", path: "/a" }],
        }),
      ),
    ).toBe("ValidationError");
  });
});

describe("upsert", () => {
  test("by id: UPSERT t:id MERGE", async () => {
    const { client, calls } = makeClient();
    await client.users.upsert({ where: { id: "user:1" }, data: { age: 2 } });
    expect(lastCall(calls).sql).toBe("UPSERT user:1 MERGE $p0;");
  });

  test("by unique field: UPSERT t MERGE $p WHERE uniq = $v", async () => {
    const { client, calls } = makeClient();
    await client.users.upsert({
      where: { email: "a@x" },
      data: { email: "a@x", age: 2 },
    });
    expect(lastCall(calls).sql).toBe(
      "UPSERT user MERGE $p0 WHERE email = $p1;",
    );
  });

  test("distinct create/update by id: literal update uses INSERT ON DUPLICATE", async () => {
    const { client, calls } = makeClient();
    await client.users.upsert({
      where: { id: "user:1" },
      create: { id: "user:1", ...data },
      update: { active: false },
    });
    const call = lastCall(calls);
    expect(call.sql).toBe(
      "INSERT INTO user $p1 ON DUPLICATE KEY UPDATE active = $p0.active;",
    );
  });

  test("distinct create/update with EXPRESSIONS falls back to LET/IF", async () => {
    const { client, calls } = makeClient();
    const p = client.users.upsert({
      where: { id: "user:1" },
      create: { id: "user:1", ...data },
      update: { age: surql`age + 1` },
    });
    expect(lastCall(calls).sql).toContain(
      "LET $__existing = (SELECT VALUE id FROM user WHERE id = $p0 LIMIT 1);",
    );
    expect(lastCall(calls).sql).toContain(
      "IF array::len($__existing) = 0 THEN CREATE user CONTENT $p1 ELSE UPDATE $__existing[0] MERGE { age: age + 1 } END;",
    );
    await p;
  });

  test("distinct create/update by unique: LET + IF/ELSE", async () => {
    const { client, calls } = makeClient();
    const p = client.users.upsert({
      where: { email: "a@x" },
      create: { ...data },
      update: { age: 2 },
    });
    expect(calls[0]?.sql).toContain(
      "LET $__existing = (SELECT VALUE id FROM user WHERE email = $p0 LIMIT 1);",
    );
    expect(calls[0]?.sql).toContain(
      "IF array::len($__existing) = 0 THEN CREATE user CONTENT $p1 ELSE UPDATE $__existing[0] MERGE $p2 END;",
    );
    await p;
  });

  test("upsert needs data or create+update", () => {
    const { client } = makeClient();
    expect(codeOf(() => client.users.upsert({ where: { id: "user:1" } }))).toBe(
      "ValidationError",
    );
  });

  test("upsertMany with ids: INSERT ON DUPLICATE from the union of fields", async () => {
    const { client, calls } = makeClient();
    await client.users.upsertMany({ data: [{ id: "user:a", ...data }] });
    expect(lastCall(calls).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email, age = $input.age, active = $input.active, tags = $input.tags, address = $input.address;",
    );
  });

  test("upsertMany without ids needs conflict and compiles UPSERT … WHERE", async () => {
    const { client, calls } = makeClient();
    await client.users.upsertMany({ data: [{ ...data }], conflict: "email" });
    expect(lastCall(calls).sql).toBe(
      "UPSERT user MERGE $p0 WHERE email = $p0.email;",
    );
    expect(codeOf(() => client.users.upsertMany({ data: [{ ...data }] }))).toBe(
      "ValidationError",
    );
  });
});

describe("delete", () => {
  test("DELETE t:id RETURN BEFORE and by unique", async () => {
    const { client, calls } = makeClient();
    await client.users.delete({ where: { id: "user:1" } });
    expect(lastCall(calls).sql).toBe("DELETE user:1 RETURN BEFORE;");

    await client.users.delete({ where: { email: "a@x" }, return: "none" });
    expect(lastCall(calls).sql).toBe(
      "DELETE FROM user WHERE email = $p0 RETURN NONE;",
    );
  });

  test("delete rejects after/diff and non-unique wheres", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.delete({
          where: { id: "user:1" },
          return: "after" as never,
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(codeOf(() => client.users.delete({ where: { age: 1 } }))).toBe(
      "UniqueTargetRequired",
    );
  });

  test("deleteMany requires all:true without a where", async () => {
    const { client, calls } = makeClient();
    expect(codeOf(() => client.users.deleteMany({}))).toBe("UnsafeMutation");
    const result = await client.users.deleteMany({ all: true });
    expect(lastCall(calls).sql).toBe("DELETE user RETURN BEFORE;");
    expect(result.count).toBe(1);
    expect(result.data).toBeUndefined();
  });
});

describe("updateEach", () => {
  test("per-item UPDATE statements, one round-trip", async () => {
    const { client, calls } = makeClient([ROW]);
    const result = await client.users.updateEach({
      data: [
        { id: "user:1", age: 31 },
        { id: "user:2", age: 28 },
      ],
    });
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nUPDATE user MERGE $p1 WHERE id = $p0;\nUPDATE user MERGE $p3 WHERE id = $p2;\nCOMMIT TRANSACTION;",
    );
    const vars = lastCall(calls).vars ?? {};
    expect(vars.p0).toBeInstanceOf(RecordId);
    expect(vars.p2).toBeInstanceOf(RecordId);
    expect(vars.p1).toEqual({ age: 31 });
    expect(vars.p3).toEqual({ age: 28 });
    expect(result.count).toBe(2);
    expect(result.skipped).toBe(0);
  });

  test("default by is id; duplicates and missing by are rejected", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ email: "a@x", age: 1 }],
        } as never),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [
            { id: "user:1", age: 1 },
            { id: "user:1", age: 2 },
          ],
        }),
      ),
    ).toBe("ValidationError");
  });

  test("onEmpty throw raises when an item matches nothing; return counts skipped", async () => {
    let statement = 0;
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT"))
          return ok(null);
        statement += 1;
        return ok(statement === 1 ? [ROW] : []);
      }),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const skipped = await client.users.updateEach({
      data: [
        { id: "user:1", age: 1 },
        { id: "user:2", age: 2 },
      ],
    });
    expect(skipped.count).toBe(1);
    expect(skipped.skipped).toBe(1);
    statement = 0;
    await expect(
      client.users.updateEach({
        data: [
          { id: "user:1", age: 1 },
          { id: "user:2", age: 2 },
        ],
        onEmpty: "throw",
      }),
    ).rejects.toMatchObject({ code: "ResultNotFound" });
  });
});

describe("relate / unrelate (edge delegate)", () => {
  test("RELATE from->edge->to SET data", async () => {
    const { client, calls } = makeClient([LIKE_ROW]);
    await client.likes.relate({
      from: "user:1",
      to: "post:1",
      data: { score: 5 },
    });
    expect(lastCall(calls)).toEqual({
      sql: "RELATE user:1->likes->post:1 SET score = $p0;",
      vars: { p0: 5 },
    });
  });

  test("named edge id and relateMany (transactional)", async () => {
    const { client, calls } = makeClient([LIKE_ROW]);
    await client.likes.relate({
      from: "user:1",
      to: "post:1",
      id: "likes:first",
    });
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes:first->post:1;");

    await client.likes.relateMany({
      data: [
        { from: "user:1", to: "post:1", data: { score: 5 } },
        { from: "user:2", to: "post:1" },
      ],
    });
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nRELATE user:1->likes->post:1 SET score = $p0;\nRELATE user:2->likes->post:1;\nCOMMIT TRANSACTION;",
    );
  });

  test("endpoints are validated against the declared FROM/TO tables", () => {
    const { client } = makeClient();
    expect(
      codeOf(() => client.likes.relate({ from: "post:1", to: "user:1" })),
    ).toBe("ValidationError");
  });

  test("unrelate / unrelateMany", async () => {
    const { client, calls } = makeClient([LIKE_ROW]);
    await client.likes.unrelate({ from: "user:1", to: "post:1" });
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE in = user:1 AND out = post:1 RETURN BEFORE;",
    );

    await client.likes.unrelateMany({ where: { score: { lt: 3 } } });
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE score < $p0 RETURN BEFORE;",
    );
    expect(codeOf(() => client.likes.unrelateMany({}))).toBe("UnsafeMutation");
  });

  test("non-relation delegates reject relate at runtime", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        (client.users as unknown as { relate: (a: unknown) => unknown }).relate(
          {
            from: "user:1",
            to: "post:1",
          },
        ),
      ),
    ).toBe("ValidationError");
  });
});

describe("runtime envelopes + eager execution", () => {
  test("writes run immediately (no lazy thenable) and have no .explain()", async () => {
    const { client, calls } = makeClient();
    const promise = client.users.create({ data }) as Promise<unknown> & {
      explain?: unknown;
    };
    expect(calls).toHaveLength(1);
    expect(promise.explain).toBeUndefined();
    await promise;
  });

  test("return:'none' makes the batch count undefined", async () => {
    const { client } = makeClient([]);
    const result = await client.users.updateMany({
      data: { active: false },
      return: "none",
    });
    expect(result.count).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(result.statements).toBe(1);
  });

  test("BatchResult carries the statement count", async () => {
    const { client } = makeClient();
    const result = await client.users.createMany({ data: [data, data, data] });
    expect(result.statements).toBe(3);
  });
});
