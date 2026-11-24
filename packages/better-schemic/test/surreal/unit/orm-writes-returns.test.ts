const MAGIC_123 = 123
const MAGIC_5 = 5
// M2 — the write RETURN semantics and the plan decode: `before` state, `diff` patch combining
// across statements, and the eager guards (skipDuplicates, relate sugar, timeout, updateEach
// select). The core write goldens live in `orm-writes.test.ts`; fixtures in `orm-writes-fixtures`.
import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { type Client, orm } from "../../../src/surreal/orm/client"
import { fakeConn, ok } from "../orm-fixtures"

import { codeOf, data, lastCall, LIKE_ROW, makeClient, ROW, schemaDef } from "./orm-writes-fixtures"

describe("return semantics — before/diff and the batch decode", () => {
  test("create return:'before' resolves null (nothing existed before)", async () => {
    const { calls, client } = makeClient([])
    const result = await client.users.create({ data, return: "before" })
    expect(result).toBeNull()
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN BEFORE;',
    )
  })

  test("batch diff results decode as flattened patch ops, not rows", async () => {
    const ops = [{ op: "replace", path: "/age", value: 2 }]
    const { client } = makeClient([ops])
    const many = await client.users.updateMany({
      data: { active: false },
      return: "diff",
      where: { age: { gt: 0 } },
    })
    expect(many).toEqual(ops)

    const one = await client.users.patch({
      patches: [{ op: "replace", path: "/age", value: 3 }],
      return: "diff",
      where: { id: "user:1" },
    })
    expect(one).toEqual(ops)
  })

  test("update with data+unset combines both statements' diffs", async () => {
    let step = 0
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT")) return ok(null)
        step += 1
        return ok([[{ op: "replace", path: `/s${step}`, value: step }]])
      }),
    )
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const result = await client.users.update({
      data: { active: true },
      return: "diff",
      unset: ["age"],
      where: { id: "user:1" },
    })
    expect(result).toEqual([
      { op: "replace", path: "/s1", value: 1 },
      { op: "replace", path: "/s2", value: 2 },
    ])
  })

  test("batch return:'diff' combines every statement's patch (createMany)", async () => {
    let step = 0
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT")) return ok(null)
        step += 1
        return ok([[{ op: "add", path: `/f${step}`, value: step }]])
      }),
    )
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const result = await client.users.createMany({
      data: [data, { ...data, name: "B" }],
      return: "diff",
    })
    expect(result).toEqual([
      { op: "add", path: "/f1", value: 1 },
      { op: "add", path: "/f2", value: 2 },
    ])
  })

  test("upsert RETURN DIFF with expressions is rejected before any query", () => {
    const { calls, client } = makeClient()
    expect(
      codeOf(() =>
        client.users.upsert({
          create: { id: "user:1", ...data },
          onMissing: "create",
          return: "diff",
          update: { age: surql`age + 1` },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.users.upsert({
          data: { age: surql`age + 1` },
          return: "diff",
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(calls).toHaveLength(0)
  })

  test("upsert LET/IF honors return:'before' on both branches", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      create: { id: "user:1", ...data },
      onMissing: "create",
      return: "before",
      update: { age: surql`age + 1` },
      where: { id: "user:1" },
    })
    const sql = lastCall(calls).sql
    expect(sql).toContain("THEN CREATE user:1 CONTENT $p1 RETURN NONE")
    expect(sql).toContain("ELSE UPDATE $__existing[0] MERGE { age: age + 1 } RETURN BEFORE END;")
  })

  test("upsertMany conflict with an explicit update map compiles LET/IF (full create)", async () => {
    const { calls, conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("IF")) return ok([ROW])
        return ok(null)
      }),
    )
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const result = await client.users.upsertMany({
      conflict: "email",
      data: [{ ...data }],
      update: { age: surql`age + 1` },
    })
    const sql = calls[0]?.sql ?? ""
    expect(sql).toContain(
      "LET $__e0 = (SELECT VALUE id FROM user WHERE email = $p0.email LIMIT 1);",
    )
    expect(sql).toContain(
      'IF array::len($__e0) = 0 THEN CREATE type::record(s"user", rand::ulid()) CONTENT $p0 ELSE UPDATE $__e0[0] MERGE { age: age + 1 } END;',
    )
    expect(result.count).toBe(1)
  })

  test("upsertMany conflict must be a single-field UNIQUE index", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.upsertMany({ conflict: "age", data: [{ ...data }] }))).toBe(
      "UniqueTargetRequired",
    )
    expect(
      codeOf(() =>
        client.users.upsertMany({
          conflict: "email",
          data: [{ ...data }],
          update: "drop" as never,
        }),
      ),
    ).toBe("ValidationError")
  })

  test("insertMany return:'diff' combines the single statement's patch", async () => {
    const ops = [{ op: "change", path: "/name", value: "@@ x @@" }]
    const { client } = makeClient([ops])
    const result = await client.users.insertMany({
      data: [{ id: "user:1", ...data }],
      onDuplicate: "update",
      return: "diff",
    })
    expect(result).toEqual(ops)
  })
})

describe("eager guards — skipDuplicates, relate sugar, unrelate timeout, updateEach", () => {
  test("skipDuplicates: id-less rows compile with a generated id; non-objects still fail", async () => {
    const { calls, client } = makeClient()
    expect(
      codeOf(() => client.users.createMany({ data: [MAGIC_5 as never], skipDuplicates: true })),
    ).toBe("ValidationError")
    await client.users.createMany({ data: [data, data], skipDuplicates: true })
    expect(calls[0]?.sql).toBe(
      "BEGIN TRANSACTION;\n" +
        "INSERT IGNORE INTO user { name: $b0, email: $b1, age: $b2, active: $b3, tags: [], address: { city: $b4 }, id: rand::ulid() };\n" +
        "INSERT IGNORE INTO user { name: $b5, email: $b6, age: $b7, active: $b8, tags: [], address: { city: $b9 }, id: rand::ulid() };\n" +
        "COMMIT TRANSACTION;",
    )
  })

  test("relate sugar validates the edge and codec-checks its data", async () => {
    const { calls, client } = makeClient([{ id: new RecordId("post", "1"), title: "T" }])
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [{ edge: "nope", from: "user:1", to: "$self" }],
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [
            {
              data: { score: "x" as never },
              edge: "likes",
              from: "user:1",
              to: "$self",
            },
          ],
        }),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)

    await client.posts.create({
      data: { title: "T" },
      relate: [{ edge: "likes", from: "user:1", to: "$self" }],
      return: "none",
    })
    expect(lastCall(calls).sql).toContain("RETURN NONE;")
  })

  test("create + relate rejects RETURN DIFF", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.posts.create({
          data: { title: "T" },
          relate: [{ edge: "likes", from: "user:1", to: "$self" }],
          return: "diff" as never,
        }),
      ),
    ).toBe("ReturnNotSupported")
  })

  test("relateMany rejects a per-item return", () => {
    const { client } = makeClient([LIKE_ROW])
    expect(
      codeOf(() =>
        client.likes.relateMany({
          data: [{ from: "user:1", return: "before", to: "post:1" } as never],
        }),
      ),
    ).toBe("ValidationError")
  })

  test("unrelate / unrelateMany thread the timeout", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.unrelate({
      from: "user:1",
      timeout: "2s",
      to: "post:1",
    })
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE in = user:1 AND out = post:1 RETURN BEFORE TIMEOUT 2s;",
    )
    await client.likes.unrelateMany({
      timeout: 500,
      where: { score: { lt: 3 } },
    })
    expect(lastCall(calls).sql).toBe("DELETE likes WHERE score < $p0 RETURN BEFORE TIMEOUT 500ms;")
  })

  test("updateEach compiles select before the write and projects the rows", async () => {
    const { calls, client } = makeClient([ROW])
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ age: 31, id: "user:1" }],
          select: MAGIC_123 as never,
        }),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)

    const result = await client.users.updateEach({
      data: [{ age: 31, id: "user:1" }],
      select: { age: true, id: true },
    })
    expect(result.count).toBe(1)
    expect(result.data?.[0]).toEqual({ age: ROW.age, id: ROW.id })
  })

  test("updateEach rejects onEmpty:'throw' with return:'none'", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ age: 1, id: "user:1" }],
          onEmpty: "throw",
          return: "none",
        }),
      ),
    ).toBe("ValidationError")
  })
})
