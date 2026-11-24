const MAGIC_2 = 2
const MAGIC_3 = 3
const MAGIC_5 = 5
// M2 — the write compiler and the delegate writes: golden SQL/vars per form, the runtime envelopes
// (row/miss/batch/count), codec validation with expression splice, and the teaching guards. Offline.
// Return semantics + eager guards live in `orm-writes-returns.test.ts`; fixtures shar them there.
import { describe, expect, test } from "bun:test"
import { RecordId } from "surrealdb"
import type { ZodArray, ZodBoolean, ZodInt, ZodString } from "zod"

import { relation, s, surql, table } from "../../../src/surreal"
import { type Client, orm } from "../../../src/surreal/orm/client"
import type { OrmError } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import type {
  RecordIdField,
  SField,
  SObjectField,
  TableDef,
  WithSmartId,
} from "../../../src/surreal/pure"
import { KEEP_ORDER } from "../../order-barrier"
import { caught, type FakeCall, type FakeConn, fakeConn, ok } from "../orm-fixtures"

import {
  codeOf,
  data,
  lastCall,
  LIKE_ROW,
  makeClient,
  Post,
  ROW,
  schemaDef,
  stable,
  User,
} from "./orm-writes-fixtures"

describe("create", () => {
  test("CREATE CONTENT with the codec-encoded payload", async () => {
    const { calls, client } = makeClient()
    await client.users.create({ data })
    expect(lastCall(calls)).toEqual({
      sql: 'CREATE type::record(s"user", rand::ulid()) CONTENT $p0;',
      vars: { p0: data },
    })
  })

  test("id payload binds a RecordId and targets CREATE ONLY t:id", async () => {
    const { calls, client } = makeClient()
    await client.users.create({
      data: { id: "user:aeon", ...data },
      only: true,
    })
    const call = lastCall(calls)
    expect(call.sql).toBe("CREATE ONLY user:aeon CONTENT $p0;")
    const payload = call.vars.p0 as { id: unknown }
    expect(payload.id).toBeInstanceOf(RecordId)
    expect(String(payload.id)).toBe("user:aeon")
  })

  test("return none/diff/only lower the RETURN clause", async () => {
    const { calls, client } = makeClient([])
    await client.users.create({ data, return: "none" })
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN NONE;',
    )
    await client.users.create({ data, return: "diff" })
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN DIFF;',
    )
  })

  test("expression fields splice; literal fields stay codec-encoded", async () => {
    const { calls, client } = makeClient()
    await client.users.create({
      data: { ...data, name: surql`string::uppercase(${"a"})` },
    })
    const call = lastCall(calls)
    expect(stable(call.sql, call.vars)).toEqual({
      sql: 'CREATE type::record(s"user", rand::ulid()) CONTENT { email: $b0, age: $b1, active: $b2, tags: [], address: { city: $b3 }, name: string::uppercase($frag0) };',
      vars: { b0: "a@x", b1: 1, b2: true, b3: "SP", frag0: "a" },
    })
  })

  test("invalid data fails the codec with ValidationError", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.create({ data: { ...data, age: "old" } as never }))).toBe(
      "ValidationError",
    )
  })

  test("createMany: N CREATEs in one transaction", async () => {
    const { calls, client } = makeClient()
    const p = client.users.createMany({ data: [data, { ...data, name: "B" }] })
    expect(calls[0]?.sql).toBe(
      'BEGIN TRANSACTION;\nCREATE type::record(s"user", rand::ulid()) CONTENT $p0;\nCREATE type::record(s"user", rand::ulid()) CONTENT $p1;\nCOMMIT TRANSACTION;',
    )
    const result = await p
    expect(result.count).toBe(MAGIC_2)
    expect(result.statements).toBe(MAGIC_2)
  })

  test("createMany skipDuplicates compiles one INSERT IGNORE per row", async () => {
    let statement = 0
    const { calls, conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT")) return ok(null)
        statement += 1
        return ok(statement === 1 ? [ROW] : [])
      }),
    )
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const result = await client.users.createMany({
      data: [
        { id: "user:1", ...data },
        { id: "user:2", ...data },
      ],
      skipDuplicates: true,
    })
    expect(calls[0]?.sql).toBe(
      "BEGIN TRANSACTION;\nINSERT IGNORE INTO user $p0;\nINSERT IGNORE INTO user $p1;\nCOMMIT TRANSACTION;",
    )
    expect(result.count).toBe(1)
    expect(result.skipped).toBe(1)
  })

  test("relate sugar: LET + RELATE + RETURN in one transaction", async () => {
    const postRow = { id: new RecordId("post", "1"), title: "T" }
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok([postRow])))
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    await client.posts.create({
      data: { title: "T" },
      relate: [{ edge: "likes", from: "user:1", to: "$self" }],
    })
    expect(calls[0]?.sql).toBe(
      'BEGIN TRANSACTION;\nLET $__created = (CREATE ONLY type::record(s"post", rand::ulid()) CONTENT $p0);\nRELATE user:1->likes->$__created;\nRETURN $__created;\nCOMMIT TRANSACTION;',
    )
    // An explicit id keeps the targeted form (never the generated target).
    await client.posts.create({
      data: { id: "post:fixed", title: "T" },
      relate: [{ edge: "likes", from: "user:1", to: "$self" }],
    })
    expect(calls[1]?.sql).toContain("LET $__created = (CREATE ONLY post:fixed CONTENT $p0);")
  })
})

describe("insert", () => {
  test("INSERT INTO keeps payload ids; onDuplicate ignore/update/map", async () => {
    const { calls, client } = makeClient()
    await client.users.insert({ data: { id: "user:a", ...data } })
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0;")

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "ignore",
    })
    expect(lastCall(calls).sql).toBe("INSERT IGNORE INTO user $p0;")

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "update",
    })
    expect(lastCall(calls).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email, age = $input.age, active = $input.active, tags = $input.tags, address = $input.address;",
    )

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: {
        name: surql`$input.name`,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        age: surql`age + 1`,
      },
    })
    expect(stable(lastCall(calls).sql, lastCall(calls).vars).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = ($input.name), age = (age + 1);",
    )
  })

  test("insert rejects arrays (insertMany) and allows RETURN BEFORE with onDuplicate", async () => {
    const { calls, client } = makeClient()
    expect(codeOf(() => client.users.insert({ data: [data] as never }))).toBe("ValidationError")
    await client.users.insert({
      data,
      onDuplicate: "ignore",
      return: "before",
    })
    expect(lastCall(calls).sql).toBe(
      "INSERT IGNORE INTO user { name: $b0, email: $b1, age: $b2, active: $b3, tags: [], address: { city: $b4 }, id: rand::ulid() } RETURN BEFORE;",
    )
  })

  test("insertMany: one INSERT IGNORE, skipped = input - inserted", async () => {
    const { client } = makeClient([ROW])
    const result = await client.users.insertMany({
      data: [
        { id: "user:1", ...data },
        { id: "user:2", ...data },
      ],
      onDuplicate: "ignore",
    })
    expect(result.count).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.statements).toBe(1)
  })
})

describe("update", () => {
  test("modes merge/set/content/replace", async () => {
    const { calls, client } = makeClient()
    await client.users.update({ data: { age: 2 }, where: { id: "user:1" } })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;")

    await client.users.update({
      data: {
        age: 2,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        active: false,
      },
      mode: "set",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age = $p0, active = $p1;")

    await client.users.update({
      data,
      mode: "content",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 CONTENT $p0;")

    await client.users.update({
      data,
      mode: "replace",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 REPLACE $p0;")
  })

  test("unique-field target compiles UPDATE t … WHERE uniq = $p", async () => {
    const { calls, client } = makeClient()
    await client.users.update({ data: { age: 2 }, where: { email: "a@x" } })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p1 WHERE email = $p0;")
  })

  test("update NEVER creates: a miss resolves null and .throw() raises ResultNotFound", async () => {
    const { client } = makeClient([])
    const miss = await client.users.update({
      data: { age: 2 },
      where: { id: "user:1" },
    })
    expect(miss).toBeNull()
    let failure: unknown
    try {
      await client.users.update({ data: { age: 2 }, where: { id: "user:1" } }).throw()
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "ResultNotFound" })
  })

  test("unset alone and combined with data (2 statements, transactional)", async () => {
    const { calls, client } = makeClient()
    await client.users.update({
      unset: ["age", "tags"],
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 UNSET age, tags;")

    const p = client.users.update({
      data: { active: true },
      timeout: "2s",
      unset: ["age"],
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nUPDATE user:1 MERGE $p0 TIMEOUT 2s;\nUPDATE user:1 UNSET age TIMEOUT 2s;\nCOMMIT TRANSACTION;",
    )
    await p
  })

  test("expression data splices (set mode)", async () => {
    const { calls, client } = makeClient()
    await client.users.update({
      data: { age: surql`age + ${1}` },
      mode: "set",
      where: { id: "user:1" },
    })
    const call = lastCall(calls)
    expect(stable(call.sql, call.vars)).toEqual({
      sql: "UPDATE user:1 SET age = (age + $frag0);",
      vars: { frag0: 1 },
    })
  })

  test("teaching guards: missing data, bad mode, non-unique where, unset id", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.update({ where: { id: "user:1" } }))).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.users.update({
          data: { age: 1 },
          mode: "drop" as never,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(() => client.users.update({ data: { age: 2 }, where: { age: 1 } }))).toBe(
      "UniqueTargetRequired",
    )
    expect(codeOf(() => client.users.update({ unset: ["id"], where: { id: "user:1" } }))).toBe(
      "ValidationError",
    )
  })

  test("updateMany without a where updates the whole table", async () => {
    const { calls, client } = makeClient()
    const result = await client.users.updateMany({ data: { active: false } })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p0;")
    expect(result.count).toBe(1)
  })
})

describe("patch", () => {
  test("UPDATE … PATCH $ops", async () => {
    const { calls, client } = makeClient()
    await client.users.patch({
      patches: [
        { op: "replace", path: "/age", value: 31 },
        { op: "remove", path: "/tags/0" },
      ],
      where: { id: "user:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE user:1 PATCH $p0;",
      vars: {
        p0: [
          { op: "replace", path: "/age", value: 31 },
          { op: "remove", path: "/tags/0" },
        ],
      },
    })
  })

  test("invalid ops fail with a teaching ValidationError", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.patch({
          patches: [{ op: "set", path: "/a" }] as never,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.users.patch({
          patches: [{ op: "replace", path: "/a" }],
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("upsert", () => {
  test("strict by id (default): UPDATE ONLY t:id — never creates", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({ data: { age: 2 }, where: { id: "user:1" } })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0;")
  })

  test("onMissing create by id: UPSERT t:id MERGE", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      data: { age: 2 },
      onMissing: "create",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPSERT user:1 MERGE $p0;")
  })

  test("strict by unique field: UPDATE t … WHERE uniq = $v", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      data: { age: 2 },
      where: { email: "a@x" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p0 WHERE email = $p1;")
  })

  test("onMissing create by unique field: resolve-or-create with the generated target", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      data: { age: 2, email: "a@x" },
      onMissing: "create",
      where: { email: "a@x" },
    })
    expect(lastCall(calls).sql).toBe(
      'UPSERT ((SELECT VALUE id FROM user WHERE email = $p0 LIMIT 1)[0] ?? type::record(s"user", rand::ulid())) MERGE $p1;',
    )
  })

  test("distinct create/update by id: literal update uses INSERT ON DUPLICATE", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      create: { id: "user:1", ...data },
      onMissing: "create",
      update: { active: false },
      where: { id: "user:1" },
    })
    const call = lastCall(calls)
    expect(call.sql).toBe("INSERT INTO user $p1 ON DUPLICATE KEY UPDATE active = $p0.active;")
  })

  test("distinct create/update with EXPRESSIONS falls back to LET/IF", async () => {
    const { calls, client } = makeClient()
    const p = client.users.upsert({
      create: { id: "user:1", ...data },
      onMissing: "create",
      update: { age: surql`age + 1` },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toContain(
      "LET $__existing = (SELECT VALUE id FROM user WHERE id = $p0 LIMIT 1);",
    )
    expect(lastCall(calls).sql).toContain(
      "IF array::len($__existing) = 0 THEN CREATE user:1 CONTENT $p1 ELSE UPDATE $__existing[0] MERGE { age: age + 1 } END;",
    )
    await p
  })

  test("distinct create/update by unique: LET + IF/ELSE", async () => {
    const { calls, client } = makeClient()
    const p = client.users.upsert({
      create: { ...data },
      onMissing: "create",
      update: { age: 2 },
      where: { email: "a@x" },
    })
    expect(calls[0]?.sql).toContain(
      "LET $__existing = (SELECT VALUE id FROM user WHERE email = $p0 LIMIT 1);",
    )
    expect(calls[0]?.sql).toContain(
      'IF array::len($__existing) = 0 THEN CREATE type::record(s"user", rand::ulid()) CONTENT $p1 ELSE UPDATE $__existing[0] MERGE $p2 END;',
    )
    await p
  })

  test("upsert needs data or create+update", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.upsert({ where: { id: "user:1" } }))).toBe("ValidationError")
  })

  test("strict rejects create/update branches and RETURN DIFF with teaching errors", () => {
    const { client } = makeClient()
    const us = (args: unknown): string | undefined =>
      codeOf((): Promise<null> => client.users.upsert(args as never))
    expect(
      us({
        create: { id: "user:1", ...data },
        update: { age: 2 },
        where: { id: "user:1" },
      }),
    ).toBe("ValidationError")
    expect(us({ data: { age: 2 }, return: "diff", where: { id: "user:1" } })).toBe(
      "ReturnNotSupported",
    )
  })

  test("strict return: none still compiles the row-returning form (miss stays observable)", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      data: { age: 2 },
      return: "none",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0;")
  })

  test("no target (no where, no data.id): a plain CREATE, mirroring create()", async () => {
    const { calls, client } = makeClient()
    const row = await client.users.upsert({ data })
    expect(lastCall(calls).sql).toBe('CREATE type::record(s"user", rand::ulid()) CONTENT $p0;')
    expect(row).toMatchObject({ age: 30, name: "A" })
    // `onMissing: "create"` is a no-op on a target-less call — it's already a create.
    await client.users.upsert({ data, onMissing: "create" })
    expect(lastCall(calls).sql).toBe('CREATE type::record(s"user", rand::ulid()) CONTENT $p0;')
  })

  test("no target mirrors create's only/diff/timeout lowering", async () => {
    const { calls, client } = makeClient([ROW])
    await client.users.upsert({ data, only: true })
    expect(lastCall(calls).sql).toBe('CREATE ONLY type::record(s"user", rand::ulid()) CONTENT $p0;')
    await client.users.upsert({ data, return: "diff" })
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN DIFF;',
    )
    await client.users.upsert({ data, timeout: "2s" })
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 TIMEOUT 2s;',
    )
  })

  test("data.id infers the id target: strict UPDATE ONLY, no where needed", async () => {
    const { calls, client } = makeClient()
    const row = await client.users.upsert({
      data: { ...data, id: "user:inferred" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:inferred MERGE $p0;")
    const payload = lastCall(calls).vars.p0 as { id: unknown }
    expect(payload.id).toBeInstanceOf(RecordId)
    expect(String(payload.id)).toBe("user:inferred")
    expect(row).toMatchObject({ name: "A" })
  })

  test("data.id + onMissing create: UPSERT t:id (create-or-update)", async () => {
    const { calls, client } = makeClient()
    await client.users.upsert({
      data: { ...data, id: "user:9" },
      onMissing: "create",
    })
    expect(lastCall(calls).sql).toBe("UPSERT user:9 MERGE $p0;")
  })

  test("target-less guards teach with the upsertDelta wording", () => {
    const { client } = makeClient()
    expect(() => client.users.upsert({ data, onMissing: "throw" })).toThrow(
      /needs a target — pass "where"/u,
    )
    expect(() =>
      client.users.upsert({
        create: { ...data, id: "user:1" },
        onMissing: "create",
        update: { age: 2 },
      }),
    ).toThrow(/distinct "create"\/"update" payloads need a target/u)
    expect(() => client.users.upsert({ data, mode: "set" })).toThrow(
      /"mode" only applies to the update branch/u,
    )
  })

  test("where.id/data.id mismatch, non-unique and undefined where keep teaching errors", () => {
    const { client } = makeClient()
    const us = (args: unknown): string | undefined =>
      codeOf((): Promise<null> => client.users.upsert(args as never))
    expect(us({ data: { ...data, id: "user:2" }, where: { id: "user:1" } })).toBe("ValidationError")
    // Identical ids name the same record — no error.
    expect(us({ data: { ...data, id: "user:1" }, where: { id: "user:1" } })).toBeUndefined()
    expect(us({ data, where: { age: 1 } })).toBe("UniqueTargetRequired")
    expect(us({ data, where: { id: undefined } })).toBe("UniqueTargetRequired")
  })

  test("target-less: the created row comes back; a filtered create rejects, never null", async () => {
    const { client } = makeClient([ROW])
    const row = await client.users.upsert({ data })
    expect(row).toMatchObject({ age: 30, name: "A" })

    const { conn } = fakeConn((sql) => sql.split("\n").map(() => ok(null)))
    const filtered = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const error = (await caught(() => filtered.users.upsert({ data }))) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(error.message).toContain("wrote no row")
    expect(error.message).not.toContain("onMissing")
  })

  test("strict targeted miss keeps the onMissing teaching message", async () => {
    const { conn } = fakeConn((sql) => sql.split("\n").map(() => ok(null)))
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const error = (await caught(() =>
      client.users.upsert({ data: { age: 1 }, where: { id: "user:missing" } }),
    )) as OrmError
    expect(error.code).toBe("ResultNotFound")
    expect(error.message).toContain('onMissing: "throw"')
  })

  test("upsertMany with ids: INSERT ON DUPLICATE from the union of fields", async () => {
    const { calls, client } = makeClient()
    await client.users.upsertMany({ data: [{ id: "user:a", ...data }] })
    expect(lastCall(calls).sql).toBe(
      "INSERT INTO user $p0 ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email, age = $input.age, active = $input.active, tags = $input.tags, address = $input.address;",
    )
  })

  test("upsertMany without ids needs conflict and compiles UPSERT … WHERE", async () => {
    const { calls, client } = makeClient()
    await client.users.upsertMany({ conflict: "email", data: [{ ...data }] })
    expect(lastCall(calls).sql).toBe(
      'UPSERT ((SELECT VALUE id FROM user WHERE email = $p0.email LIMIT 1)[0] ?? type::record(s"user", rand::ulid())) MERGE $p0;',
    )
    expect(codeOf(() => client.users.upsertMany({ data: [{ ...data }] }))).toBe("ValidationError")
  })
})

describe("update/upsert — mode & data guards", () => {
  test("update: data XOR patches; patch mode requires patches; id can't be updated", () => {
    const { client } = makeClient()
    const u = (args: unknown): string | undefined =>
      codeOf((): Promise<null> => client.users.update(args as never))
    expect(u({ data, patches: [], where: { id: "user:1" } })).toBe("ValidationError")
    expect(u({ mode: "patch", where: { id: "user:1" } })).toBe("ValidationError")
    expect(
      u({
        mode: "merge",
        patches: [{ op: "remove", path: "/a" }],
        where: { id: "user:1" },
      }),
    ).toBe("ValidationError")
    expect(u({ data: { id: "user:1", name: "A" }, where: { id: "user:1" } })).toBe(
      "ValidationError",
    )
  })

  test("upsert: data XOR create/update; patch mode is not allowed", () => {
    const { client } = makeClient()
    const us = (args: unknown): string | undefined =>
      codeOf((): Promise<null> => client.users.upsert(args as never))
    expect(
      us({
        create: { id: "user:1", ...data },
        data: { age: 2 },
        update: { age: 2 },
        where: { id: "user:1" },
      }),
    ).toBe("ValidationError")
    expect(us({ mode: "patch", patches: [], where: { id: "user:1" } })).toBe("ValidationError")
  })

  test("upsert create/update: create needs the id, it must match, update needs a field", () => {
    const { client } = makeClient()
    const us = (args: unknown): string | undefined =>
      codeOf((): Promise<null> => client.users.upsert(args as never))
    // create missing the id (by-id target).
    expect(us({ create: { ...data }, update: { age: 2 }, where: { id: "user:1" } })).toBe(
      "ValidationError",
    )
    // create id mismatch.
    expect(
      us({
        create: { id: "user:2", ...data },
        update: { age: 2 },
        where: { id: "user:1" },
      }),
    ).toBe("ValidationError")
    // empty update map.
    expect(
      us({
        create: { id: "user:1", ...data },
        update: {},
        where: { id: "user:1" },
      }),
    ).toBe("ValidationError")
  })
})

describe("delete", () => {
  test("DELETE t:id RETURN BEFORE and by unique", async () => {
    const { calls, client } = makeClient()
    await client.users.delete({ where: { id: "user:1" } })
    expect(lastCall(calls).sql).toBe("DELETE user:1 RETURN BEFORE;")

    await client.users.delete({ return: "none", where: { email: "a@x" } })
    expect(lastCall(calls).sql).toBe("DELETE FROM user WHERE email = $p0 RETURN NONE;")
  })

  test("delete rejects after/diff and non-unique wheres", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.delete({
          return: "after" as never,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(codeOf(() => client.users.delete({ where: { age: 1 } }))).toBe("UniqueTargetRequired")
  })

  test("deleteMany requires all:true without a where", async () => {
    const { calls, client } = makeClient()
    expect(codeOf(() => client.users.deleteMany({}))).toBe("UnsafeMutation")
    const result = await client.users.deleteMany({ all: true })
    expect(lastCall(calls).sql).toBe("DELETE user RETURN BEFORE;")
    expect(result.count).toBe(1)
    expect(result.data).toBeUndefined()
  })
})

describe("updateEach", () => {
  test("per-item UPDATE statements, one round-trip", async () => {
    const { calls, client } = makeClient([ROW])
    const result = await client.users.updateEach({
      data: [
        { age: 31, id: "user:1" },
        { age: 28, id: "user:2" },
      ],
    })
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nUPDATE user MERGE $p1 WHERE id = $p0;\nUPDATE user MERGE $p3 WHERE id = $p2;\nCOMMIT TRANSACTION;",
    )
    const vars = lastCall(calls).vars
    expect(vars.p0).toBeInstanceOf(RecordId)
    expect(vars.p2).toBeInstanceOf(RecordId)
    expect(vars.p1).toEqual({ age: 31 })
    expect(vars.p3).toEqual({ age: 28 })
    expect(result.count).toBe(MAGIC_2)
    expect(result.skipped).toBe(0)
  })

  test("default by is id; duplicates and missing by are rejected", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [{ age: 1, email: "a@x" }],
        } as never),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.users.updateEach({
          data: [
            { age: 1, id: "user:1" },
            { age: 2, id: "user:1" },
          ],
        }),
      ),
    ).toBe("ValidationError")
  })

  test("onEmpty throw raises when an item matches nothing; return counts skipped", async () => {
    let statement = 0
    const { conn } = fakeConn((sql) =>
      sql.split("\n").map((line) => {
        if (line.startsWith("BEGIN") || line.startsWith("COMMIT")) return ok(null)
        statement += 1
        return ok(statement === 1 ? [ROW] : [])
      }),
    )
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const skipped = await client.users.updateEach({
      data: [
        { age: 1, id: "user:1" },
        { age: 2, id: "user:2" },
      ],
    })
    expect(skipped.count).toBe(1)
    expect(skipped.skipped).toBe(1)
    statement = 0
    let failure: unknown
    try {
      await client.users.updateEach({
        data: [
          { age: 1, id: "user:1" },
          { age: 2, id: "user:2" },
        ],
        onEmpty: "throw",
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: "ResultNotFound" })
  })
})

describe("relate / unrelate (edge delegate)", () => {
  test("RELATE from->edge->to SET data", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.relate({
      data: { score: 5 },
      from: "user:1",
      to: "post:1",
    })
    expect(lastCall(calls)).toEqual({
      sql: "RELATE user:1->likes->post:1 SET score = $p0;",
      vars: { p0: 5 },
    })
  })

  test("named edge id and relateMany (transactional)", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.relate({
      from: "user:1",
      id: "likes:first",
      to: "post:1",
    })
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes:first->post:1;")

    // An ALREADY-escaped id round-trips (unescaped once, escaped once — no double escape).
    await client.likes.relate({
      from: "user:1",
      id: "likes:⟨first id⟩",
      to: "post:1",
    } as never)
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes:⟨first id⟩->post:1;")

    await client.likes.relateMany({
      data: [
        { data: { score: 5 }, from: "user:1", to: "post:1" },
        { from: "user:2", to: "post:1" },
      ],
    })
    expect(lastCall(calls).sql).toBe(
      "BEGIN TRANSACTION;\nRELATE user:1->likes->post:1 SET score = $p0;\nRELATE user:2->likes->post:1;\nCOMMIT TRANSACTION;",
    )
  })

  test("endpoints are validated against the declared FROM/TO tables", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.likes.relate({ from: "post:1", to: "user:1" }))).toBe(
      "ValidationError",
    )
  })

  test("unrelate / unrelateMany", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.unrelate({ from: "user:1", to: "post:1" })
    expect(lastCall(calls).sql).toBe(
      "DELETE likes WHERE in = user:1 AND out = post:1 RETURN BEFORE;",
    )

    await client.likes.unrelateMany({ where: { score: { lt: 3 } } })
    expect(lastCall(calls).sql).toBe("DELETE likes WHERE score < $p0 RETURN BEFORE;")
    expect(codeOf(() => client.likes.unrelateMany({}))).toBe("UnsafeMutation")
  })

  test("non-relation delegates reject relate at runtime", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        (client.users as unknown as { relate: (a: unknown) => unknown }).relate({
          from: "user:1",
          to: "post:1",
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("relate / unrelate — guards and expressions", () => {
  test("relate requires both endpoints", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.likes.relate({ from: "user:1" } as never))).toBe("ValidationError")
    expect(codeOf(() => client.likes.relate({ to: "post:1" } as never))).toBe("ValidationError")
  })

  test("a surql expression endpoint splices", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.relate({ from: surql`$user`, to: "post:1" } as never)
    expect(lastCall(calls).sql).toContain("RELATE ($user)->likes->post:1")
  })

  test("a null/undefined endpoint is rejected", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.likes.relate({ from: null, to: "post:1" } as never))).toBe(
      "ValidationError",
    )
  })

  test("a bare endpoint adopts the single declared table (string-id convenience)", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.relate({ from: "abc", to: "post:1" } as never)
    expect(lastCall(calls).sql).toBe("RELATE user:abc->likes->post:1;")
  })

  test("a bare endpoint is rejected when the direction has multiple tables", () => {
    const Multi = relation("multi", { score: s.int() }).from([User, Post]).to(Post)
    const multiSchema = schema({
      multi: Multi,
      posts: Post,
      users: User,
    })
    const { conn } = fakeConn()
    const client = orm(conn, { schema: multiSchema })
    expect(
      codeOf(() =>
        (client.multi as unknown as { relate: (a: unknown) => unknown }).relate({
          from: "abc",
          to: "post:1",
        }),
      ),
    ).toBe("ValidationError")
  })

  test("a non-string edge id is rejected", () => {
    const { client } = makeClient()
    expect(
      codeOf(() => client.likes.relate({ from: "user:1", id: 5, to: "post:1" } as never)),
    ).toBe("ValidationError")
  })

  test("relateMany guards: non-object item, missing endpoints, per-item return", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.likes.relateMany({ data: [MAGIC_5] } as never))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => client.likes.relateMany({ data: [{ from: "user:1" }] } as never))).toBe(
      "ValidationError",
    )
    expect(
      codeOf(() =>
        client.likes.relateMany({
          data: [{ from: "user:1", return: "before", to: "post:1" }],
        } as never),
      ),
    ).toBe("ValidationError")
  })

  test("unrelate requires both endpoints", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.likes.unrelate({ from: "user:1" } as never))).toBe("ValidationError")
  })

  test("unrelateMany with all: true deletes every edge", async () => {
    const { calls, client } = makeClient([LIKE_ROW])
    await client.likes.unrelateMany({ all: true })
    expect(lastCall(calls).sql).toBe("DELETE likes RETURN BEFORE;")
  })
})

describe("create.relate sugar — guards", () => {
  const rel = (entry: unknown): string | undefined => codeOf((): unknown => clientCreate(entry))
  const { client } = makeClient()
  function clientCreate(entry: unknown): unknown {
    return (client.users as unknown as { create: (a: unknown) => unknown }).create({
      data,
      relate: [entry],
    })
  }

  test("a non-object entry is rejected", () => {
    expect(rel(MAGIC_5)).toBe("ValidationError")
  })
  test("an entry missing from/edge/to is rejected", () => {
    expect(rel({ edge: "likes", from: "user:1" })).toBe("ValidationError")
  })
  test("a non-string edge is rejected", () => {
    expect(rel({ edge: 5, from: "user:1", to: "$self" })).toBe("ValidationError")
  })
  test("an edge that is a table (not a relation) is rejected", () => {
    expect(rel({ edge: "user", from: "user:1", to: "$self" })).toBe("ValidationError")
  })
  test("an unknown edge name is rejected", () => {
    expect(rel({ edge: "ghost", from: "user:1", to: "$self" })).toBe("ValidationError")
  })
})

describe("write compiler — create/insert guards", () => {
  test("create and createMany require a payload", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.create({} as never))).toBe("ValidationError")
    expect(codeOf(() => client.users.createMany({ data: [MAGIC_5] } as never))).toBe(
      "ValidationError",
    )
  })

  test("insert requires data; insertMany requires an array", () => {
    const { client } = makeClient()
    expect(codeOf(() => client.users.insert({} as never))).toBe("ValidationError")
    expect(codeOf(() => client.users.insertMany({ data: 5 } as never))).toBe("ValidationError")
  })

  test("onDuplicate guards: update with no updatable fields, empty map, invalid value", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.insert({
          data: { id: new RecordId("user", 1) },
          onDuplicate: "update",
        } as never),
      ),
    ).toBe("ValidationError")
    expect(codeOf(() => client.users.insert({ data, onDuplicate: {} } as never))).toBe(
      "ValidationError",
    )
    expect(codeOf(() => client.users.insert({ data, onDuplicate: "bad" } as never))).toBe(
      "ValidationError",
    )
  })
})

describe("runtime envelopes + eager execution", () => {
  test("writes run immediately (no lazy thenable) and have no .explain()", async () => {
    const { calls, client } = makeClient()
    const promise = client.users.create({ data }) as Promise<unknown> & {
      explain?: unknown
    }
    expect(calls).toHaveLength(1)
    expect(promise.explain).toBeUndefined()
    await promise
  })

  test("return:'none' makes the batch count undefined", async () => {
    const { client } = makeClient([])
    const result = await client.users.updateMany({
      data: { active: false },
      return: "none",
    })
    expect(result.count).toBeUndefined()
    expect(result.data).toBeUndefined()
    expect(result.statements).toBe(1)
  })

  test("BatchResult carries the statement count", async () => {
    const { client } = makeClient()
    const result = await client.users.createMany({ data: [data, data, data] })
    expect(result.statements).toBe(MAGIC_3)
  })
})

describe("composite UNIQUE target — every upsert lowering", () => {
  const Acct = table("w_acct", {
    email: s.string(),
    name: s.string(),
    owner: s.recordId(() => User),
    tenant: s.string(),
  }).index("w_acct_idx", ["tenant", "email"], { unique: true })
  const multi = schema({ accts: Acct, users: User })
  const row = [
    {
      email: "a@x",
      id: new RecordId("w_acct", "1"),
      name: "A",
      owner: new RecordId("user", "aeon"),
      tenant: "t1",
    },
  ]

  const clientOver = (
    result: unknown = row,
  ): {
    calls: FakeCall[]
    client: Client<
      {
        readonly accts: TableDef<
          "w_acct",
          WithSmartId<
            "w_acct",
            {
              email: SField<ZodString>
              name: SField<ZodString>
              owner: RecordIdField<"user">
              tenant: SField<ZodString>
            }
          >
        >
        readonly users: TableDef<
          "user",
          WithSmartId<
            "user",
            {
              active: SField<ZodBoolean>
              address: SObjectField<{ city: SField<ZodString> }>
              age: SField<ZodInt>
              email: SField<ZodString>
              name: SField<ZodString>
              tags: SField<ZodArray<ZodString>>
            }
          >,
          "email"
        >
      },
      FakeConn
    >
  } => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok(result)))
    return { calls, client: orm(conn, { schema: multi }) }
  }

  const where = {
    tenant: "t1",
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    email: "a@x",
  }

  test("upsert (create-or-update) targets the composite", async () => {
    const { calls, client } = clientOver()
    await client.accts.upsert({
      data: { name: "B" },
      onMissing: "create",
      where,
    })
    expect(lastCall(calls).sql).toMatch(/WHERE tenant = \$p\d+ AND email = \$p\d+/u)
  })

  test("the STRICT upsert (the default) targets the composite too", async () => {
    const { calls, client } = clientOver()
    await client.accts.upsert({ data: { name: "B" }, where })
    expect(lastCall(calls).sql).toMatch(/WHERE tenant = \$p\d+ AND email = \$p\d+/u)
  })

  test("a record column inside the group is coerced to RecordId", async () => {
    const Link = table("w_link", {
      owner: s.recordId(() => User),
      tenant: s.string(),
    }).index("w_link_idx", ["tenant", "owner"], { unique: true })
    const schemaDef = schema({ links: Link, users: User })
    const { calls, conn } = fakeConn((sql) =>
      sql.split("\n").map(() =>
        ok([
          {
            id: new RecordId("w_link", "1"),
            owner: new RecordId("user", "aeon"),
            tenant: "t1",
          },
        ]),
      ),
    )
    const client = orm(conn, { schema: schemaDef })
    await client.links.update({
      data: { tenant: "t2" },
      where: {
        tenant: "t1",
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        ...KEEP_ORDER,
        owner: "user:aeon",
      },
    })
    const call = lastCall(calls)
    expect(call.sql).toContain("owner = $p")
    expect(call.vars).toMatchObject({ p0: "t1" })
    expect(Object.values(call.vars)).toContainEqual(new RecordId("user", "aeon"))
  })

  test("update/delete/patch on the same composite target", async () => {
    await Promise.all(
      [...(["update", "delete"] as const)].map(async (op) => {
        const { calls, client } = clientOver()
        await (client.accts as never as Record<string, (a: unknown) => Promise<unknown>>)[op](
          op === "update" ? { data: { name: "B" }, where } : { return: "none", where },
        )
        expect(lastCall(calls).sql).toMatch(/WHERE tenant = \$p\d+ AND email = \$p\d+/u)
      }),
    )
  })
})

describe("composite UNIQUE target — the branch/scope arms", () => {
  const Stock = table("w_stock", {
    qty: s.int(),
    sku: s.string(),
    tenant: s.string(),
  }).index("w_stock_idx", ["tenant", "sku"], { unique: true })
  const schemaDef = schema({ stock: Stock, users: User })
  const where = {
    tenant: "t1",
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    ...KEEP_ORDER,
    sku: "x",
  }
  const row = [
    {
      id: new RecordId("w_stock", "1"),
      qty: 1,
      sku: "x",
      tenant: "t1",
    },
  ]

  const clientOver = (): {
    calls: FakeCall[]
    client: Client<
      {
        readonly stock: TableDef<
          "w_stock",
          WithSmartId<
            "w_stock",
            {
              qty: SField<ZodInt>
              sku: SField<ZodString>
              tenant: SField<ZodString>
            }
          >
        >
        readonly users: TableDef<
          "user",
          WithSmartId<
            "user",
            {
              active: SField<ZodBoolean>
              address: SObjectField<{ city: SField<ZodString> }>
              age: SField<ZodInt>
              email: SField<ZodString>
              name: SField<ZodString>
              tags: SField<ZodArray<ZodString>>
            }
          >,
          "email"
        >
      },
      FakeConn
    >
  } => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok(row)))
    return { calls, client: orm(conn, { schema: schemaDef }) }
  }

  test("an adjustment on a composite target lowers to the compound assignment", async () => {
    const { calls, client } = clientOver()
    await client.stock.update({ data: { qty: { increment: 1 } }, where })
    expect(lastCall(calls).sql).toBe(
      "UPDATE w_stock SET qty += $p2 WHERE tenant = $p0 AND sku = $p1;",
    )
  })

  test("a scoped composite target ANDs the scope after the key", async () => {
    const { calls, client } = clientOver()
    await client.stock.update({
      data: { qty: 2 },
      scope: { tenant: "t1" },
      where,
    } as never)
    const call = lastCall(calls)
    expect(call.sql).toMatch(/WHERE \(tenant = \$p\d+ AND sku = \$p\d+ AND tenant = \$p\d+\)/u)
  })
})
