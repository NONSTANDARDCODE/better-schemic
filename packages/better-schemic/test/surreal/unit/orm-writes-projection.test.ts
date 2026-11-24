const MAGIC_10 = 10
const MAGIC_31 = 31
// Write projections (`select`/`omit` riding `RETURN <projection>`) and numeric adjustments
// (`{ increment }`/`{ decrement }` → `SET f ±= $p`): the server-vs-client lowering, the decode,
// and the teaching guards. Core write goldens live in `orm-writes.test.ts`.
import { describe, expect, test } from "bun:test"
import { Decimal, RecordId } from "surrealdb"
import type { ZodArray, ZodInt, ZodString } from "zod"

import { surql } from "../../../src/surreal"
import { adjustmentOf, stripAdjustments } from "../../../src/surreal/orm/arithmetic"
import { type Client, orm } from "../../../src/surreal/orm/client"
import type { OrmError, OrmErrorCode } from "../../../src/surreal/orm/errors"
import { schema } from "../../../src/surreal/orm/schema"
import { s, type SField, table, type TableDef, type WithSmartId } from "../../../src/surreal/pure"
import { KEEP_ORDER } from "../../order-barrier"
import { type FakeCall, type FakeConn, fakeConn, ok } from "../orm-fixtures"

import { codeOf, data, lastCall, makeClient, ROW, schemaDef, stable } from "./orm-writes-fixtures"

describe("write projections — server-side RETURN", () => {
  test("update/create/insert tail carry the projection", async () => {
    const { calls, client } = makeClient([{ name: "A" }])
    const updated = await client.users.update({
      data: { age: 2 },
      select: { name: true },
      where: { id: "user:1" },
    })
    expect(updated).toEqual({ name: "A" })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN name;")

    await client.users.create({
      data,
      select: {
        name: true,
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
        age: true,
      },
    })
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN name, age;',
    )

    await client.users.insert({
      data: { id: "user:a", ...data },
      select: { name: true },
    })
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0 RETURN name;")
  })

  test("nested paths, aliases and expression entries render like reads", async () => {
    const { calls, client } = makeClient([{ address: { city: "SP" } }])
    await client.users.update({
      data: { age: 2 },
      select: { address: { city: true }, city: "address.city" },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 MERGE $p0 RETURN address.city, address.city AS city;",
    )

    await client.users.update({
      data: { age: 2 },
      select: { upper: surql`string::uppercase(name)`.as<string>() },
      where: { id: "user:1" },
    })
    expect(calls.at(-1)?.sql).toContain("AS upper")
  })

  test("`*` + extra entries and ONLY forms", async () => {
    const { calls, client } = makeClient([ROW])
    await client.users.update({
      data: { age: 2 },
      select: { "*": true, age: true },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN *, age;")
  })

  test("upsert (strict), upsertMany and updateEach tail the projection", async () => {
    const { calls, client } = makeClient([{ name: "A" }])
    await client.users.upsert({
      data: { age: 2 },
      select: { name: true },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0 RETURN name;")

    await client.users.upsertMany({
      data: [{ id: "user:1", ...data }],
      select: { name: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN name;")

    await client.users.updateEach({
      data: [{ age: 2, id: "user:1" }],
      select: { age: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p1 WHERE id = $p0 RETURN age;")
  })

  test("relate carries the projection in the same statement", async () => {
    const { calls, client } = makeClient([{ score: 5 }])
    const edge = await client.likes.relate({
      data: { score: 5 },
      from: "user:1",
      select: { score: true },
      to: "post:1",
    })
    expect(edge).toEqual({ score: 5 })
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN score;")
  })

  test("patch / unset / onDuplicate also carry the projection", async () => {
    const { calls, client } = makeClient([{ tags: ["a"] }])
    await client.users.patch({
      patches: [{ op: "add", path: "/tags/-", value: "b" }],
      select: { tags: true },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 PATCH $p0 RETURN tags;")

    await client.users.update({
      data: { age: 2 },
      select: { age: true },
      unset: ["active"],
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toContain("UNSET active RETURN age;")

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "update",
      select: { name: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN name;")
  })

  test("batch (createMany) projects every statement", async () => {
    const { calls, client } = makeClient([{ name: "A" }])
    const many = await client.users.createMany({
      data: [{ ...data }],
      select: { name: true },
    })
    expect(many.data).toEqual([{ name: "A" }])
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN name;',
    )
  })

  test("skipDuplicates, insert and return:'before' create tails", async () => {
    const { calls, client } = makeClient([])

    await client.users.createMany({
      data: [{ id: "user:a", ...data }],
      select: { name: true },
      skipDuplicates: true,
    })
    expect(lastCall(calls).sql).toBe("INSERT IGNORE INTO user $p0 RETURN name;")

    await client.users.insertMany({
      data: [{ id: "user:a", ...data }],
      select: { name: true },
    })
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0 RETURN name;")

    const created = await client.users.create({
      data,
      return: "before",
      select: { name: true },
    })
    expect(created).toBeNull()
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN BEFORE;',
    )
  })

  test("a star-only select is a no-op (no RETURN clause, full decode)", async () => {
    const { calls, client } = makeClient([ROW])
    const row = await client.users.update({
      data: { age: 2 },
      select: { "*": true },
      where: { id: "user:1" },
    })
    expect(row).toEqual(ROW)
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;")
    // `omit: []` projects nothing either — even with RETURN DIFF (which rejects real projections).
    const ops = [{ op: "replace", path: "/age", value: 3 }]
    const { client: diffClient } = makeClient([ops])
    await diffClient.users.update({
      data: { age: 3 },
      omit: [],
      return: "diff",
      where: { id: "user:1" },
    })
  })

  test("insert diff+select is rejected; relate before/relateMany project", async () => {
    const { calls, client } = makeClient([])
    expect(
      codeOf(() =>
        client.users.insert({
          data: { id: "user:a", ...data },
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.users.insertMany({
          data: [{ id: "user:a", ...data }],
          omit: ["email"],
          return: "diff",
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.likes.relate({
          from: "user:1",
          return: "diff",
          select: { score: true },
          to: "post:1",
        }),
      ),
    ).toBe("ReturnNotSupported")

    const before = await client.likes.relate({
      data: { score: 5 },
      from: "user:1",
      return: "before",
      select: { score: true },
      to: "post:1",
    })
    expect(before).toBeNull()
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN BEFORE;")

    await client.likes.relateMany({
      data: [{ data: { score: 1 }, from: "user:1", to: "post:1" }],
      select: { score: true },
    })
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN score;")
  })
})

describe("write projections — client-side (before/delete/omit)", () => {
  test("return:'before' keeps RETURN BEFORE and decodes the projection client-side", async () => {
    const { calls, client } = makeClient([ROW])
    const before = await client.users.update({
      data: { age: 31 },
      return: "before",
      select: { city: "address.city", name: true },
      where: { id: "user:1" },
    })
    expect(before).toEqual({ city: "SP", name: "A" })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN BEFORE;")
  })

  test("delete projects the removed row client-side", async () => {
    const { calls, client } = makeClient([ROW])
    const removed = await client.users.delete({
      select: { name: true },
      where: { id: "user:1" },
    })
    expect(removed).toEqual({ name: "A" })
    expect(lastCall(calls).sql).toBe("DELETE user:1 RETURN BEFORE;")
  })

  test("omit strips fields client-side (RETURN … OMIT is a parse error)", async () => {
    const { calls, client } = makeClient([ROW])
    const row = await client.users.update({
      data: { age: 2 },
      omit: ["email", "tags"],
      where: { id: "user:1" },
    })
    expect(row).toEqual({
      active: true,
      address: { city: "SP" },
      age: 30,
      id: ROW.id,
      name: "A",
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;")
  })

  test("upsertDelta + select projects record/before (and the delta covers those fields)", async () => {
    const envelope = {
      after: { ...ROW, age: 31 },
      before: ROW,
    }
    const { conn } = fakeConn(() => [ok([envelope])])
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const out = await client.users.upsertDelta({
      data: { age: 31 },
      select: { age: true },
      where: { id: "user:1" },
    })
    expect(out).toEqual({
      before: { age: 30 },
      changed: ["age"],
      created: false,
      delta: { new: { age: 31 }, old: { age: 30 } },
      record: { age: 31 },
    })
  })

  test("omit applies client-side to upsertDelta and updateEach too", async () => {
    const envelope = { after: { ...ROW, age: 31 }, before: ROW }
    const { conn } = fakeConn(() => [ok([envelope])])
    const client = orm(conn, { schema: schemaDef }) as Client<typeof schemaDef>
    const out = await client.users.upsertDelta({
      data: { age: 31 },
      omit: ["email"],
      where: { id: "user:1" },
    })
    expect(out.record).not.toHaveProperty("email")
    expect(out.record.age).toBe(MAGIC_31)

    const each = makeClient([ROW])
    const result = await each.client.users.updateEach({
      data: [{ age: 2, id: "user:1" }],
      omit: ["email"],
    })
    expect(result.data?.[0]).not.toHaveProperty("email")
    expect(result.data?.[0]).toMatchObject({ age: 30, name: "A" })
  })

  test("expression entries are rejected when only the client can project", () => {
    const { calls, client } = makeClient([ROW])
    const expression = { upper: surql`string::uppercase(name)`.as<string>() }
    expect(
      codeOf(() =>
        client.users.update({
          data: { age: 2 },
          return: "before",
          select: expression,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.users.upsertDelta({
          data: { age: 2 },
          select: expression,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(calls).toHaveLength(0)
  })

  test("RETURN DIFF rejects select/omit with a teaching error", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.update({
          data: { age: 2 },
          return: "diff",
          select: { age: true },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.users.create({
          data,
          omit: ["email"],
          return: "diff",
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(() =>
        client.users.createMany({
          data: [{ ...data }],
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported")
  })

  test("create.relate sugar projects client-side", async () => {
    const { calls, client } = makeClient([{ name: "A" }])
    await client.users.create({
      data,
      relate: [{ edge: "likes", from: "user:1", to: "post:1" }],
      select: { name: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN $__created;")
  })
})

describe("projections across the upsert lowerings", () => {
  test("strict upsert targets project (unique field, before → client)", async () => {
    const { calls, client } = makeClient([{ age: 30 }])
    await client.users.upsert({
      data: { age: 30 },
      select: { age: true },
      where: { email: "a@x" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p0 WHERE email = $p1 RETURN age;")

    await client.users.upsert({
      data: { age: 30 },
      return: "before",
      select: { age: true },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0 RETURN BEFORE;")
  })

  test("create-mode upsert lowerings carry the projection", async () => {
    const { calls, client } = makeClient([{ age: 30 }])
    await client.users.upsert({
      data: { age: 30 },
      onMissing: "create",
      select: { age: true },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toContain("UPSERT user:1 MERGE $p0 RETURN age;")

    await client.users.upsert({
      data: { age: 30, email: "a@x" },
      onMissing: "create",
      select: { age: true },
      where: { email: "a@x" },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")

    await client.users.upsert({
      data: { age: 30, email: "a@x", id: "user:1" },
      onMissing: "create",
      select: { age: true },
      where: { email: "a@x" },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")
  })

  test("expression upserts project EACH LET/IF branch", async () => {
    const { calls, client } = makeClient([{ age: 30 }])
    await client.users.upsert({
      data: { age: surql`age + 1`.as<number>() },
      onMissing: "create",
      select: { age: true },
      where: { id: "user:1" },
    })
    const sql = lastCall(calls).sql
    expect(sql).toContain("RETURN age ELSE")
    expect(sql).toContain("RETURN age END;")
  })

  test("upsertMany, targetless upsert and upsertDelta project", async () => {
    const { calls, client } = makeClient([ROW])
    await client.users.upsertMany({
      conflict: "email",
      data: [{ ...data }],
      select: { age: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")

    await client.users.upsert({
      data: { ...data },
      select: { age: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")

    await client.users.upsert({ data: { ...data }, return: "before" })
    expect(lastCall(calls).sql).toContain("RETURN BEFORE;")

    const envelope = { after: { ...ROW, age: 31 }, before: ROW }
    const { conn } = fakeConn(() => [ok([envelope])])
    const deltaClient = orm(conn, {
      schema: schemaDef,
    }) as Client<typeof schemaDef>
    const created = await deltaClient.users.upsertDelta({
      data: { ...data },
      select: { age: true },
    })
    expect(created.record).toEqual({ age: 31 })
  })
})

describe("arithmetic adjustments — lowering", () => {
  test("merge mode compiles SET with += / -= (and flattens nested objects)", async () => {
    const { calls, client } = makeClient()
    await client.users.update({
      data: { age: { increment: 1 } },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;")

    await client.users.update({
      data: { age: { decrement: 2 }, name: "B" },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET name = $p0, age -= $p1;")

    await client.users.update({
      data: { address: { city: "X" }, age: { increment: 1 } },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET address.city = $p0, age += $p1;")

    // An empty nested object is a MERGE no-op — it contributes NO assignment.
    await client.users.update({
      data: { address: {}, age: { increment: 1 } },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;")
  })

  test("mode set keeps top-level assignments; content/replace reject adjustments", async () => {
    const { calls, client } = makeClient()
    await client.users.update({
      data: { age: { increment: 1 }, name: "B" },
      mode: "set",
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET name = $p0, age += $p1;")

    expect(
      codeOf(() =>
        client.users.update({
          data: { ...data, age: { increment: 1 } as never },
          mode: "content",
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("updateMany/updateEach/strict upsert lower adjustments", async () => {
    const { calls, client } = makeClient()
    await client.users.updateMany({
      data: { age: { increment: 1 } },
      where: { active: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user SET age += $p1 WHERE active = $p0;")

    await client.users.updateEach({
      data: [
        { age: { increment: 1 }, id: "user:1" },
        { age: { decrement: 3 }, id: "user:2" },
      ],
    })
    expect(lastCall(calls).sql).toContain("SET age += $p1 WHERE id = $p0;")
    expect(lastCall(calls).sql).toContain("SET age -= $p3 WHERE id = $p2;")

    await client.users.upsert({
      data: { age: { decrement: 1 } },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 SET age -= $p0;")
  })

  test("distinct create/update: the update branch adjusts through LET/IF", async () => {
    const { calls, client } = makeClient([ROW])
    await client.users.upsert({
      create: { id: "user:1", ...data },
      onMissing: "create",
      update: { age: { increment: 1 } },
      where: { id: "user:1" },
    })
    const sql = lastCall(calls).sql
    expect(sql).toContain("LET $__existing")
    expect(sql).toContain("SET age += ")
  })

  test("expression operands splice; fragments work in merge mode", async () => {
    const { calls, client } = makeClient()
    await client.users.update({
      data: { age: { increment: surql`2`.as<number>() } },
      where: { id: "user:1" },
    })
    expect(lastCall(calls).sql).toContain("SET age += ")
  })

  test("Decimal operands bind; replace/patch modes reject adjustments", async () => {
    const Ledger = table("ledger", { balance: s.decimal() })
    const { calls, conn } = fakeConn(() => [ok([])])
    const ledger = orm(conn, {
      schema: schema({ ledgers: Ledger }),
    })
    await ledger.ledgers.update({
      data: { balance: { increment: new Decimal("1.5") } },
      where: { id: "ledger:1" },
    })
    const call = calls.at(-1)
    expect(call?.sql).toBe("UPDATE ledger:1 SET balance += $p0;")
    expect(call?.vars?.p0).toBeInstanceOf(Decimal)

    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.update({
          data: { ...data, age: { increment: 1 } as never },
          mode: "replace",
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("arithmetic adjustments — guards", () => {
  test("create-shaped writes reject markers with a teaching error", () => {
    const { calls, client } = makeClient()
    const bad = { ...data, age: { increment: 1 } }
    expect(codeOf(() => client.users.create({ data: bad as never }))).toBe("ValidationError")
    expect(codeOf(() => client.users.createMany({ data: [bad as never] }))).toBe("ValidationError")
    expect(codeOf(() => client.users.insert({ data: bad as never }))).toBe("ValidationError")
    expect(codeOf(() => client.users.insertMany({ data: [bad as never] }))).toBe("ValidationError")
    expect(codeOf(() => client.users.upsert({ data: bad as never }))).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.users.upsert({
          data: { age: { increment: 1 } },
          onMissing: "create",
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.users.upsert({
          create: { id: "user:1", ...bad } as never,
          onMissing: "create",
          update: { age: 1 },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(() => client.users.upsertMany({ data: [bad as never] }))).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("the upsertMany update map rejects adjustments", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.users.upsertMany({
          data: [{ id: "user:1", ...data }],
          update: { age: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("bad targets and operands fail eagerly", () => {
    const { calls, client } = makeClient()
    // non-numeric field
    expect(
      codeOf(() =>
        client.users.update({
          data: { name: { increment: 1 } as never },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    // unknown field
    expect(
      codeOf(() =>
        client.users.update({
          data: { ghost: { increment: 1 } } as never,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    // identity
    expect(
      codeOf(() =>
        client.users.update({
          data: { id: { increment: 1 } } as never,
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    // non-numeric operand
    expect(
      codeOf(() =>
        client.users.update({
          data: { age: { increment: "x" } as never },
          where: { id: "user:1" },
        }),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("relate edge data rejects adjustments (the edge is created anew)", () => {
    const { client } = makeClient()
    expect(
      codeOf(() =>
        client.likes.relate({
          data: { score: { increment: 1 } },
          from: "user:1",
          to: "post:1",
        }),
      ),
    ).toBe("ValidationError")
  })

  test("a schemaless delegate adjusts any field (no column metadata to check)", async () => {
    const { calls, conn } = fakeConn(() => [ok([])])
    const client = orm(conn, {
      schema: schema({ loose: "loose_table" }),
    })
    await client.loose.update({
      data: { counter: { increment: 1 } },
      where: { id: "loose_table:1" },
    })
    const call = calls.at(-1)
    expect(call?.sql).toBe("UPDATE loose_table:1 SET counter += $p0;")
  })
})

describe("adjustment markers — parsing and stripping", () => {
  test("adjustmentOf recognizes exactly-one-key plain markers", () => {
    expect(adjustmentOf({ increment: 1 })).toEqual({
      family: "number",
      kind: "increment",
      op: "+",
      value: 1,
    })
    expect(adjustmentOf({ decrement: 0 })).toEqual({
      family: "number",
      kind: "decrement",
      op: "-",
      value: 0,
    })
    // The array family: same one-key reserved shape, a different target field.
    expect(adjustmentOf({ append: "x" })).toEqual({
      family: "array",
      kind: "append",
      op: "+",
      value: "x",
    })
    expect(adjustmentOf({ remove: "x" })).toEqual({
      family: "array",
      kind: "remove",
      op: "-",
      value: "x",
    })
    expect(adjustmentOf({ union: ["x"] })).toEqual({
      family: "array",
      kind: "union",
      op: "+",
      value: ["x"],
    })
    expect(adjustmentOf({ increment: 1, other: 2 })).toBeUndefined()
    expect(adjustmentOf({ nope: 1 })).toBeUndefined()
    expect(adjustmentOf({ increment: undefined })).toBeUndefined()
    expect(adjustmentOf(null)).toBeUndefined()
    expect(adjustmentOf([1])).toBeUndefined()
    expect(adjustmentOf(new Date())).toBeUndefined()
    // A null-prototype object passes the plain-object guard (proto !== null is false).
    const bare = Object.assign(Object.create(null), { increment: 2 })
    expect(adjustmentOf(bare)).toEqual({
      family: "number",
      kind: "increment",
      op: "+",
      value: 2,
    })
  })

  test("stripAdjustments substitutes numeric operands (arrays mapped, expressions dropped)", () => {
    expect(stripAdjustments({ age: { decrement: 2 }, name: "B" })).toEqual({
      age: 2,
      name: "B",
    })
    expect(
      stripAdjustments([{ age: { increment: 1 } }, { age: { increment: surql`1`.as<number>() } }]),
    ).toEqual([{ age: 1 }, {}])
    expect(stripAdjustments("x")).toBe("x")
    expect(stripAdjustments(null)).toBeNull()
    // A Decimal operand survives substitution (the schema can check the exact class).
    const balance = new Decimal("1.50")
    expect(stripAdjustments({ balance: { increment: balance } })).toEqual({
      balance,
    })
    // A bigint operand survives too.
    expect(stripAdjustments({ balance: { decrement: 2n } })).toEqual({
      balance: 2n,
    })
    // A payload that IS a marker passes it through untouched (nonsensical as a table payload).
    expect(stripAdjustments({ increment: 5 })).toEqual({ increment: 5 })
  })
})

describe("array adjustments — append/remove/union/at", () => {
  const Tag = table("tagged", {
    labels: s.array(s.string()),
    name: s.string(),
    score: s.int(),
  })
  const tagSchema = schema({ tagged: Tag })

  const tagClient = (
    result: unknown = [{ id: new RecordId("tagged", "1"), labels: ["a"], name: "x", score: 0 }],
  ): {
    calls: FakeCall[]
    client: Client<
      {
        readonly tagged: TableDef<
          "tagged",
          WithSmartId<
            "tagged",
            {
              labels: SField<ZodArray<ZodString>>
              name: SField<ZodString>
              score: SField<ZodInt>
            }
          >
        >
      },
      FakeConn
    >
  } => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok(result)))
    return { calls, client: orm(conn, { schema: tagSchema }) }
  }

  test("append/remove lower to the compound assignment forms", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { labels: { append: "b" } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels += $p0;")
    expect(lastCall(calls).vars).toEqual({ p0: "b" })

    await client.tagged.update({
      data: { labels: { append: ["b", "c"] } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels += $p0;")

    await client.tagged.update({
      data: { labels: { remove: "b" } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels -= $p0;")
  })

  test("union uses array::union (the only DEDUPING merge) and at assigns an index", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { labels: { union: ["b"] } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels = array::union(labels, $p0);")

    await client.tagged.update({
      data: { labels: { at: { index: 0, value: "z" } } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels[0] = $p0;")
    expect(lastCall(calls).vars).toEqual({ p0: "z" })
  })

  test("an array marker on a non-array field teaches the family", async () => {
    await Promise.resolve()
    const { calls, client } = tagClient()
    const code = codeOf(() =>
      client.tagged.update({
        data: { name: { append: "b" } },
        where: { id: "tagged:1" },
      } as never),
    )
    expect(code).toBe("ValidationError")
    expect(calls).toHaveLength(0)
    // A numeric marker on an array field is the mirror-image error.
    expect(
      codeOf(() =>
        client.tagged.update({
          data: { labels: { increment: 1 } },
          where: { id: "tagged:1" },
        } as never),
      ),
    ).toBe("ValidationError")
  })

  test("a malformed `at` operand is refused before the round-trip", () => {
    const { calls, client } = tagClient()
    expect(
      codeOf(() =>
        client.tagged.update({
          data: { labels: { at: { index: -1, value: "z" } } },
          where: { id: "tagged:1" },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(() =>
        client.tagged.update({
          data: { labels: { at: "z" } },
          where: { id: "tagged:1" },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("an array marker on a create-shaped payload is refused like a numeric one", () => {
    const { calls, client } = tagClient()
    expect(
      codeOf(() =>
        client.tagged.create({
          data: { labels: { append: "b" }, name: "x" },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("stripAdjustments substitutes the array operand for the zod plugin", () => {
    expect(
      stripAdjustments({
        labels: { append: "b" },
        name: "x",
        note: surql`"kept"`,
        tags: { union: ["a"] },
      }),
    ).toEqual({ labels: "b", name: "x", note: surql`"kept"`, tags: ["a"] })
  })
})

describe("adjustment modifiers — when/else/coalesce", () => {
  const Tag = table("tagged", {
    labels: s.array(s.string()),
    name: s.string(),
    score: s.int(),
  })
  const tagSchema = schema({ tagged: Tag })
  const tagClient = (): {
    calls: FakeCall[]
    client: Client<
      {
        readonly tagged: TableDef<
          "tagged",
          WithSmartId<
            "tagged",
            {
              labels: SField<ZodArray<ZodString>>
              name: SField<ZodString>
              score: SField<ZodInt>
            }
          >
        >
      },
      FakeConn
    >
  } => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok([])))
    return { calls, client: orm(conn, { schema: tagSchema }) }
  }

  test("union + coalesce seeds a missing array (seed binds before the operand)", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { labels: { coalesce: [], union: ["b"] } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET labels = array::union(labels ?? $p0, $p1);",
      vars: { p0: [], p1: ["b"] },
    })
  })

  test("append + coalesce seeds a missing array with the compound effect", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { labels: { append: "b", coalesce: [] } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET labels = (labels ?? $p0) + [$p1];",
      vars: { p0: [], p1: "b" },
    })
  })

  test("when guards the effect and defaults the ELSE to the current value", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { score: { increment: 1, when: surql`score < 100` } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET score = IF score < 100 THEN score + $p0 ELSE score END;",
      vars: { p0: 1 },
    })

    await client.tagged.update({
      data: { labels: { append: "b", when: surql`score > 0` } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET labels = IF score > 0 THEN labels + [$p0] ELSE labels END;",
      vars: { p0: "b" },
    })

    await client.tagged.update({
      data: { labels: { remove: "b", when: surql`score > 0` } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET labels = IF score > 0 THEN labels - [$p0] ELSE labels END;",
      vars: { p0: "b" },
    })
  })

  test("else: value renders a bind; else: 'throw' aborts with the field name", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { score: { decrement: 1, else: 0, when: surql`score > 0` } },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: "UPDATE tagged:1 SET score = IF score > 0 THEN score - $p0 ELSE $p1 END;",
      vars: { p0: 1, p1: 0 },
    })

    await client.tagged.update({
      data: {
        labels: {
          coalesce: [],
          else: "throw",
          union: ["b"],
          when: surql`score > 0`,
        },
      },
      where: { id: "tagged:1" },
    })
    expect(lastCall(calls)).toEqual({
      sql: 'UPDATE tagged:1 SET labels = IF score > 0 THEN array::union(labels ?? $p0, $p1) ELSE THROW s"adjustment guard failed on labels" END;',
      vars: { p0: [], p1: ["b"] },
    })
  })

  test("updateMany renders the guard after the WHERE bind", async () => {
    const { calls, client } = tagClient()
    await client.tagged.updateMany({
      data: { score: { increment: 1, when: surql`score < 10` } },
      where: { name: "x" },
    })
    expect(lastCall(calls).sql).toBe(
      "UPDATE tagged SET score = IF score < 10 THEN score + $p1 ELSE score END WHERE name = $p0;",
    )
  })

  test("a guard fragment keeps its own binds (merged, not interpolated)", async () => {
    const { calls, client } = tagClient()
    await client.tagged.update({
      data: { score: { increment: 1, when: surql`score < ${MAGIC_10}` } },
      where: { id: "tagged:1" },
    })
    expect(stable(lastCall(calls).sql, lastCall(calls).vars)).toEqual({
      sql: "UPDATE tagged:1 SET score = IF score < $frag0 THEN score + $p0 ELSE score END;",
      vars: { frag0: 10, p0: 1 },
    })
  })

  test("the distinct create/update upsert branch lowers the guard through LET/IF", async () => {
    const { calls, client } = makeClient([ROW])
    await client.users.upsert({
      create: { id: "user:1", ...data },
      onMissing: "create",
      update: { age: { increment: 1, when: surql`age < 100` } },
      where: { id: "user:1" },
    })
    const sql = lastCall(calls).sql
    expect(sql).toContain("SET age = IF age < 100 THEN age + ")
    expect(sql).toContain("ELSE age END")
  })
})

describe("adjustment operand classification — the decision table", () => {
  const T = table("operand", {
    labels: s.array(s.string()),
    name: s.string(),
    score: s.int(),
  })
  const row = {
    id: new RecordId("operand", 1),
    labels: [],
    name: "n",
    score: 1,
  }

  const code = (field: string, marker: unknown): "OK" | OrmErrorCode => {
    const { conn } = fakeConn((sql) => sql.split("\n").map(() => ok([row])))
    const client = orm(conn, { schema: schema({ t: T }) })
    try {
      void client.t.update({
        data: { [field]: marker },
        where: { id: "operand:1" },
      })
      return "OK"
    } catch (error) {
      return (error as OrmError).code
    }
  }

  test("the numeric family accepts number/bigint/Decimal/fragment and nothing else", () => {
    expect(code("score", { increment: 1 })).toBe("OK")
    expect(code("score", { increment: 1n })).toBe("OK")
    expect(code("score", { increment: new Decimal(1) })).toBe("OK")
    expect(code("score", { increment: surql`1` })).toBe("OK")
    expect(code("score", { increment: "1" })).toBe("ValidationError")
    expect(code("score", { increment: true })).toBe("ValidationError")
    expect(code("score", { increment: null })).toBe("ValidationError")
  })

  test("the array family accepts a plain value, an array, a record and a date", () => {
    expect(code("labels", { append: "x" })).toBe("OK")
    expect(code("labels", { append: ["x"] })).toBe("OK")
    expect(code("labels", { append: { a: 1 } })).toBe("OK")
    expect(code("labels", { append: new Date() })).toBe("OK")
    expect(code("labels", { append: surql`[]` })).toBe("OK")
    expect(code("labels", { append: null })).toBe("OK")
    // a function is not a value the server can bind
    expect(code("labels", { append: () => 1 })).toBe("ValidationError")
  })

  test("`at` needs a non-negative integer index and a value", () => {
    expect(code("labels", { at: { index: 0, value: "x" } })).toBe("OK")
    expect(code("labels", { at: { index: -1, value: "x" } })).toBe("ValidationError")
    expect(code("labels", { at: { index: 1.5, value: "x" } })).toBe("ValidationError")
    expect(code("labels", { at: { index: 0 } })).toBe("ValidationError")
    expect(code("labels", { at: "x" })).toBe("ValidationError")
    expect(code("labels", { at: 0 })).toBe("ValidationError")
  })

  test("the wrong family for the field is a teaching error, not a wrong write", () => {
    expect(code("name", { increment: 1 })).toBe("ValidationError")
    expect(code("score", { append: "x" })).toBe("ValidationError")
    expect(code("id", { increment: 1 })).toBe("ValidationError")
    expect(code("nope", { increment: 1 })).toBe("ValidationError")
  })

  test("a schemaless delegate adjusts any field (no column metadata to check)", () => {
    const { calls, conn } = fakeConn((sql) => sql.split("\n").map(() => ok([row])))
    const client = orm(conn, { schema: schema({ t: "t" }) })
    void client.t.update({
      data: { anything: { increment: 1 } },
      where: { id: "t:1" },
    })
    expect(calls[0]?.sql).toContain("anything += $p0")
  })
})
