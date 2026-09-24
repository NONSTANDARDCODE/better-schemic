// M2 — the write RETURN semantics and the plan decode: `before` state, `diff` patch combining
// across statements, and the eager guards (skipDuplicates, relate sugar, timeout, updateEach
// select). The core write goldens live in `orm-writes.test.ts`; fixtures in `orm-writes-fixtures`.
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
} from "./orm-writes-fixtures";

describe("return semantics — before/diff and the batch decode", () => {
  test("create return:'before' resolves null (nothing existed before)", async () => {
    const { client, calls } = makeClient([]);
    const result = await client.users.create({ data, return: "before" });
    expect(result).toBeNull();
    expect(lastCall(calls).sql).toBe("CREATE user CONTENT $p0 RETURN BEFORE;");
  });

  test("batch diff results decode as flattened patch ops, not rows", async () => {
    const ops = [{ op: "replace", path: "/age", value: 2 }];
    const { client } = makeClient([ops]);
    const many = await client.users.updateMany({
      where: { age: { gt: 0 } },
      data: { active: false },
      return: "diff",
    });
    expect(many).toEqual(ops);

    const one = await client.users.patch({
      where: { id: "user:1" },
      patches: [{ op: "replace", path: "/age", value: 3 }],
      return: "diff",
    });
    expect(one).toEqual(ops);
  });

  test("update with data+unset combines both statements' diffs", async () => {
    let step = 0;
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT"))
          return ok(null);
        step += 1;
        return ok([[{ op: "replace", path: `/s${step}`, value: step }]]);
      }),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const result = await client.users.update({
      where: { id: "user:1" },
      data: { active: true },
      unset: ["age"],
      return: "diff",
    });
    expect(result).toEqual([
      { op: "replace", path: "/s1", value: 1 },
      { op: "replace", path: "/s2", value: 2 },
    ]);
  });

  test("batch return:'diff' combines every statement's patch (createMany)", async () => {
    let step = 0;
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT"))
          return ok(null);
        step += 1;
        return ok([[{ op: "add", path: `/f${step}`, value: step }]]);
      }),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const result = await client.users.createMany({
      data: [data, { ...data, name: "B" }],
      return: "diff",
    });
    expect(result).toEqual([
      { op: "add", path: "/f1", value: 1 },
      { op: "add", path: "/f2", value: 2 },
    ]);
  });

  test("upsert RETURN DIFF with expressions is rejected before any query", () => {
    const { client, calls } = makeClient();
    expect(
      codeOf(() =>
        client.users.upsert({
          where: { id: "user:1" },
          create: { id: "user:1", ...data },
          update: { age: surql`age + 1` },
          return: "diff",
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.users.upsert({
          where: { id: "user:1" },
          data: { age: surql`age + 1` },
          return: "diff",
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(calls).toHaveLength(0);
  });

  test("upsert LET/IF honors return:'before' on both branches", async () => {
    const { client, calls } = makeClient();
    await client.users.upsert({
      where: { id: "user:1" },
      create: { id: "user:1", ...data },
      update: { age: surql`age + 1` },
      return: "before",
    });
    const sql = lastCall(calls).sql;
    expect(sql).toContain("THEN CREATE user CONTENT $p1 RETURN NONE");
    expect(sql).toContain(
      "ELSE UPDATE $__existing[0] MERGE { age: age + 1 } RETURN BEFORE END;",
    );
  });

  test("upsertMany conflict with an explicit update map compiles LET/IF (full create)", async () => {
    const { conn, calls } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("IF")) return ok([ROW]);
        return ok(null);
      }),
    );
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const result = await client.users.upsertMany({
      data: [{ ...data }],
      conflict: "email",
      update: { age: surql`age + 1` },
    });
    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain(
      "LET $__e0 = (SELECT VALUE id FROM user WHERE email = $p0.email LIMIT 1);",
    );
    expect(sql).toContain(
      "IF array::len($__e0) = 0 THEN CREATE user CONTENT $p0 ELSE UPDATE $__e0[0] MERGE { age: age + 1 } END;",
    );
    expect(result.count).toBe(1);
  });

  test("upsertMany conflict must be a single-field UNIQUE index", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.upsertMany({ data: [{ ...data }], conflict: "age" }),
      ),
    ).toBe("UniqueTargetRequired");
    expect(
      codeOf(() =>
        client.users.upsertMany({
          data: [{ ...data }],
          conflict: "email",
          update: "drop" as never,
        }),
      ),
    ).toBe("ValidationError");
  });

  test("insertMany return:'diff' combines the single statement's patch", async () => {
    const ops = [{ op: "change", path: "/name", value: "@@ x @@" }];
    const { client } = makeClient([ops]);
    const result = await client.users.insertMany({
      data: [{ id: "user:1", ...data }],
      onDuplicate: "update",
      return: "diff",
    });
    expect(result).toEqual(ops);
  });
});

describe("eager guards — skipDuplicates, relate sugar, unrelate timeout, updateEach", () => {
  test("skipDuplicates needs an explicit id on every item", () => {
    const { client, calls } = makeClient();
    expect(
      codeOf(() =>
        client.users.createMany({ data: [data, data], skipDuplicates: true }),
      ),
    ).toBe("ValidationError");
    expect(calls).toHaveLength(0);
  });

  test("relate sugar validates the edge and codec-checks its data", async () => {
    const { client, calls } = makeClient([
      { id: new RecordId("post", "1"), title: "T" },
    ]);
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [{ from: "user:1", edge: "nope", to: "$self" }],
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [
            {
              from: "user:1",
              edge: "likes",
              to: "$self",
              data: { score: "x" as never },
            },
          ],
        }),
      ),
    ).toBe("ValidationError");
    expect(calls).toHaveLength(0);

    await client.posts.create({
      data: { title: "T" },
      relate: [{ from: "user:1", edge: "likes", to: "$self" }],
      return: "none",
    });
    expect(lastCall(calls).sql).toContain("RETURN NONE;");
  });

  test("create + relate rejects RETURN DIFF", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [{ from: "user:1", edge: "likes", to: "$self" }],
          return: "diff" as never,
        }),
      ),
    ).toBe("ReturnNotSupported");
  });

  test("relateMany rejects a per-item return", () => {
    const { client } = makeClient([LIKE_ROW]);
    expect(
      codeOf(() =>
        client.likes.relateMany({
          data: [{ from: "user:1", to: "post:1", return: "before" } as never],
        }),
      ),
    ).toBe("ValidationError");
  });

  test("unrelate / unrelateMany thread the timeout", async () => {
    const { client, calls } = makeClient([LIKE_ROW]);
    await client.likes.unrelate({
      from: "user:1",
      to: "post:1",
      timeout: "2s",
    });
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE in = user:1 AND out = post:1 RETURN BEFORE TIMEOUT 2s;",
    );
    await client.likes.unrelateMany({
      where: { score: { lt: 3 } },
      timeout: 500,
    });
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE score < $p0 RETURN BEFORE TIMEOUT 500ms;",
    );
  });

  test("updateEach compiles select before the write and projects the rows", async () => {
    const { client, calls } = makeClient([ROW]);
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ id: "user:1", age: 31 }],
          select: 123 as never,
        }),
      ),
    ).toBe("ValidationError");
    expect(calls).toHaveLength(0);

    const result = await client.users.updateEach({
      data: [{ id: "user:1", age: 31 }],
      select: { id: true, age: true },
    });
    expect(result.count).toBe(1);
    expect(result.data?.[0]).toEqual({ id: ROW.id, age: ROW.age });
  });

  test("updateEach rejects onEmpty:'throw' with return:'none'", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ id: "user:1", age: 1 }],
          return: "none",
          onEmpty: "throw",
        }),
      ),
    ).toBe("ValidationError");
  });
});
