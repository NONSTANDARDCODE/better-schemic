// Write projections (`select`/`omit` riding `RETURN <projection>`) and numeric adjustments
// (`{ increment }`/`{ decrement }` → `SET f ±= $p`): the server-vs-client lowering, the decode,
// And the teaching guards. Core write goldens live in `orm-writes.test.ts`.
import { describe, expect, test } from "bun:test"

import { Decimal, RecordId } from "surrealdb"

import { surql } from "../../../src/surreal"
import { adjustmentOf, stripAdjustments } from "../../../src/surreal/orm/arithmetic"
import { betterSchemic } from "../../../src/surreal/orm/client"
import { buildSchemaIndex, defineSchema } from "../../../src/surreal/orm/schema"
import { defineTable, s } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

import { ROW, codeOf, data, lastCall, makeClient, schema } from "./orm-writes-fixtures"

import type { Client } from "../../../src/surreal/orm/client"
import type { BetterSchemicError } from "../../../src/surreal/orm/errors"
import type { TableMeta } from "../../../src/surreal/orm/meta"

describe("write projections — server-side RETURN", () => {
  test("update/create/insert tail carry the projection", async () => {
    const { client, calls } = makeClient([{ name: "A" }]),
      updated = await client.users.update({
        where: { id: "user:1" },
        data: { age: 2 },
        select: { name: true },
      })
    expect(updated).toEqual({ name: "A" })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN name;")

    await client.users.create({
      data,
      select: { name: true, age: true },
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
    const { client, calls } = makeClient([{ address: { city: "SP" } }])
    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { address: { city: true }, city: "address.city" },
    })
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 MERGE $p0 RETURN address.city, address.city AS city;",
    )

    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { upper: surql`string::uppercase(name)`.as<string>() },
    })
    expect(calls.at(-1)?.sql).toContain("AS upper")
  })

  test("`*` + extra entries and ONLY forms", async () => {
    const { client, calls } = makeClient([ROW])
    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { "*": true, age: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN *, age;")
  })

  test("upsert (strict), upsertMany and updateEach tail the projection", async () => {
    const { client, calls } = makeClient([{ name: "A" }])
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { name: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0 RETURN name;")

    await client.users.upsertMany({
      data: [{ id: "user:1", ...data }],
      select: { name: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN name;")

    await client.users.updateEach({
      data: [{ id: "user:1", age: 2 }],
      select: { age: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p1 WHERE id = $p0 RETURN age;")
  })

  test("relate carries the projection in the same statement", async () => {
    const { client, calls } = makeClient([{ score: 5 }]),
      edge = await client.likes.relate({
        from: "user:1",
        to: "post:1",
        data: { score: 5 },
        select: { score: true },
      })
    expect(edge).toEqual({ score: 5 })
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN score;")
  })

  test("patch / unset / onDuplicate also carry the projection", async () => {
    const { client, calls } = makeClient([{ tags: ["a"] }])
    await client.users.patch({
      where: { id: "user:1" },
      patches: [{ op: "add", path: "/tags/-", value: "b" }],
      select: { tags: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 PATCH $p0 RETURN tags;")

    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      unset: ["active"],
      select: { age: true },
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
    const { client, calls } = makeClient([{ name: "A" }]),
      many = await client.users.createMany({
        data: [{ ...data }],
        select: { name: true },
      })
    expect(many.data).toEqual([{ name: "A" }])
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN name;',
    )
  })

  test("skipDuplicates, insert and return:'before' create tails", async () => {
    const { client, calls } = makeClient([])

    await client.users.createMany({
      data: [{ id: "user:a", ...data }],
      skipDuplicates: true,
      select: { name: true },
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
    const { client, calls } = makeClient([ROW]),
      row = await client.users.update({
        where: { id: "user:1" },
        data: { age: 2 },
        select: { "*": true },
      })
    expect(row).toEqual(ROW)
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;")
    // `omit: []` projects nothing either — even with RETURN DIFF (which rejects real projections).
    const ops = [{ op: "replace", path: "/age", value: 3 }],
      { client: diffClient } = makeClient([ops])
    await diffClient.users.update({
      where: { id: "user:1" },
      data: { age: 3 },
      omit: [],
      return: "diff",
    })
  })

  test("insert diff+select is rejected; relate before/relateMany project", async () => {
    const { client, calls } = makeClient([])
    expect(
      codeOf(async () =>
        client.users.insert({
          data: { id: "user:a", ...data },
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(async () =>
        client.users.insertMany({
          data: [{ id: "user:a", ...data }],
          return: "diff",
          omit: ["email"],
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(async () =>
        client.likes.relate({
          from: "user:1",
          to: "post:1",
          return: "diff",
          select: { score: true },
        }),
      ),
    ).toBe("ReturnNotSupported")

    const before = await client.likes.relate({
      from: "user:1",
      to: "post:1",
      data: { score: 5 },
      return: "before",
      select: { score: true },
    })
    expect(before).toBeNull()
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN BEFORE;")

    await client.likes.relateMany({
      data: [{ from: "user:1", to: "post:1", data: { score: 1 } }],
      select: { score: true },
    })
    expect(lastCall(calls).sql).toBe("RELATE user:1->likes->post:1 SET score = $p0 RETURN score;")
  })
})

describe("write projections — client-side (before/delete/omit)", () => {
  test("return:'before' keeps RETURN BEFORE and decodes the projection client-side", async () => {
    const { client, calls } = makeClient([ROW]),
      before = await client.users.update({
        where: { id: "user:1" },
        data: { age: 31 },
        return: "before",
        select: { name: true, city: "address.city" },
      })
    expect(before).toEqual({ name: "A", city: "SP" })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN BEFORE;")
  })

  test("delete projects the removed row client-side", async () => {
    const { client, calls } = makeClient([ROW]),
      removed = await client.users.delete({
        where: { id: "user:1" },
        select: { name: true },
      })
    expect(removed).toEqual({ name: "A" })
    expect(lastCall(calls).sql).toBe("DELETE user:1 RETURN BEFORE;")
  })

  test("omit strips fields client-side (RETURN … OMIT is a parse error)", async () => {
    const { client, calls } = makeClient([ROW]),
      row = await client.users.update({
        where: { id: "user:1" },
        data: { age: 2 },
        omit: ["email", "tags"],
      })
    expect(row).toEqual({
      id: ROW.id,
      name: "A",
      age: 30,
      active: true,
      address: { city: "SP" },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;")
  })

  test("upsertDelta + select projects record/before (and the delta covers those fields)", async () => {
    const envelope = {
        before: ROW,
        after: { ...ROW, age: 31 },
      },
      { conn } = fakeConn(() => [ok([envelope])]),
      client = betterSchemic(conn, { schema }) as Client<typeof schema>,
      out = await client.users.upsertDelta({
        where: { id: "user:1" },
        data: { age: 31 },
        select: { age: true },
      })
    expect(out).toEqual({
      record: { age: 31 },
      created: false,
      before: { age: 30 },
      delta: { old: { age: 30 }, new: { age: 31 } },
      changed: ["age"],
    })
  })

  test("omit applies client-side to upsertDelta and updateEach too", async () => {
    const envelope = { before: ROW, after: { ...ROW, age: 31 } },
      { conn } = fakeConn(() => [ok([envelope])]),
      client = betterSchemic(conn, { schema }) as Client<typeof schema>,
      out = await client.users.upsertDelta({
        where: { id: "user:1" },
        data: { age: 31 },
        omit: ["email"],
      })
    expect(out.record).not.toHaveProperty("email")
    expect(out.record?.age).toBe(31)

    const each = makeClient([ROW]),
      result = await each.client.users.updateEach({
        data: [{ id: "user:1", age: 2 }],
        omit: ["email"],
      })
    expect(result.data?.[0]).not.toHaveProperty("email")
    expect(result.data?.[0]).toMatchObject({ age: 30, name: "A" })
  })

  test("expression entries are rejected when only the client can project", () => {
    const { client, calls } = makeClient([ROW]),
      expression = { upper: surql`string::uppercase(name)`.as<string>() }
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: 2 },
          return: "before",
          select: expression,
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(async () =>
        client.users.upsertDelta({
          where: { id: "user:1" },
          data: { age: 2 },
          select: expression,
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(calls).toHaveLength(0)
  })

  test("RETURN DIFF rejects select/omit with a teaching error", () => {
    const { client } = makeClient()
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: 2 },
          return: "diff",
          select: { age: true },
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(async () =>
        client.users.create({
          data,
          return: "diff",
          omit: ["email"],
        }),
      ),
    ).toBe("ReturnNotSupported")
    expect(
      codeOf(async () =>
        client.users.createMany({
          data: [{ ...data }],
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported")
  })

  test("create.relate sugar projects client-side", async () => {
    const { client, calls } = makeClient([{ name: "A" }])
    await client.users.create({
      data,
      relate: [{ from: "user:1", edge: "likes", to: "post:1" }],
      select: { name: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN $__created;")
  })
})

describe("projections across the upsert lowerings", () => {
  test("strict upsert targets project (unique field, before → client)", async () => {
    const { client, calls } = makeClient([{ age: 30 }])
    await client.users.upsert({
      where: { email: "a@x" },
      data: { age: 30 },
      select: { age: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user MERGE $p0 WHERE email = $p1 RETURN age;")

    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 30 },
      return: "before",
      select: { age: true },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 MERGE $p0 RETURN BEFORE;")
  })

  test("create-mode upsert lowerings carry the projection", async () => {
    const { client, calls } = makeClient([{ age: 30 }])
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 30 },
      onMissing: "create",
      select: { age: true },
    })
    expect(lastCall(calls).sql).toContain("UPSERT user:1 MERGE $p0 RETURN age;")

    await client.users.upsert({
      where: { email: "a@x" },
      data: { email: "a@x", age: 30 },
      onMissing: "create",
      select: { age: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")

    await client.users.upsert({
      where: { email: "a@x" },
      data: { id: "user:1", email: "a@x", age: 30 },
      onMissing: "create",
      select: { age: true },
    })
    expect(lastCall(calls).sql).toContain("RETURN age;")
  })

  test("expression upserts project EACH LET/IF branch", async () => {
    const { client, calls } = makeClient([{ age: 30 }])
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: surql`age + 1`.as<number>() },
      onMissing: "create",
      select: { age: true },
    })
    const { sql } = lastCall(calls)
    expect(sql).toContain("RETURN age ELSE")
    expect(sql).toContain("RETURN age END;")
  })

  test("upsertMany, targetless upsert and upsertDelta project", async () => {
    const { client, calls } = makeClient([ROW])
    await client.users.upsertMany({
      data: [{ ...data }],
      conflict: "email",
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

    const envelope = { before: ROW, after: { ...ROW, age: 31 } },
      { conn } = fakeConn(() => [ok([envelope])]),
      deltaClient = betterSchemic(conn, {
        schema,
      }) as Client<typeof schema>,
      created = await deltaClient.users.upsertDelta({
        data: { ...data },
        select: { age: true },
      })
    expect(created.record).toEqual({ age: 31 })
  })
})

describe("arithmetic adjustments — lowering", () => {
  test("merge mode compiles SET with += / -= (and flattens nested objects)", async () => {
    const { client, calls } = makeClient()
    await client.users.update({
      where: { id: "user:1" },
      data: { age: { increment: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;")

    await client.users.update({
      where: { id: "user:1" },
      data: { name: "B", age: { decrement: 2 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET name = $p0, age -= $p1;")

    await client.users.update({
      where: { id: "user:1" },
      data: { address: { city: "X" }, age: { increment: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET address.city = $p0, age += $p1;")

    // An empty nested object is a MERGE no-op — it contributes NO assignment.
    await client.users.update({
      where: { id: "user:1" },
      data: { address: {}, age: { increment: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;")
  })

  test("mode set keeps top-level assignments; content/replace reject adjustments", async () => {
    const { client, calls } = makeClient()
    await client.users.update({
      where: { id: "user:1" },
      mode: "set",
      data: { name: "B", age: { increment: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET name = $p0, age += $p1;")

    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          mode: "content",
          data: { ...data, age: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("updateMany/updateEach/strict upsert lower adjustments", async () => {
    const { client, calls } = makeClient()
    await client.users.updateMany({
      where: { active: true },
      data: { age: { increment: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE user SET age += $p1 WHERE active = $p0;")

    await client.users.updateEach({
      data: [
        { id: "user:1", age: { increment: 1 } },
        { id: "user:2", age: { decrement: 3 } },
      ],
    })
    expect(lastCall(calls).sql).toContain("SET age += $p1 WHERE id = $p0;")
    expect(lastCall(calls).sql).toContain("SET age -= $p3 WHERE id = $p2;")

    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: { decrement: 1 } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 SET age -= $p0;")
  })

  test("distinct create/update: the update branch adjusts through LET/IF", async () => {
    const { client, calls } = makeClient([ROW])
    await client.users.upsert({
      where: { id: "user:1" },
      onMissing: "create",
      create: { id: "user:1", ...data },
      update: { age: { increment: 1 } },
    })
    const { sql } = lastCall(calls)
    expect(sql).toContain("LET $__existing")
    expect(sql).toContain("SET age += ")
  })

  test("expression operands splice; fragments work in merge mode", async () => {
    const { client, calls } = makeClient()
    await client.users.update({
      where: { id: "user:1" },
      data: { age: { increment: surql`2`.as<number>() } },
    })
    expect(lastCall(calls).sql).toContain("SET age += ")
  })

  test("Decimal operands bind; replace/patch modes reject adjustments", async () => {
    const Ledger = defineTable("ledger", { balance: s.decimal() }),
      { conn, calls } = fakeConn(() => [ok([])]),
      ledger = betterSchemic(conn, {
        schema: defineSchema({ ledgers: Ledger }),
      })
    await ledger.ledgers.update({
      where: { id: "ledger:1" },
      data: { balance: { increment: new Decimal("1.5") } },
    })
    const call = calls.at(-1)
    expect(call?.sql).toBe("UPDATE ledger:1 SET balance += $p0;")
    expect(call?.vars?.p0).toBeInstanceOf(Decimal)

    const { client } = makeClient()
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          mode: "replace",
          data: { ...data, age: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError")
  })
})

describe("arithmetic adjustments — guards", () => {
  test("create-shaped writes reject markers with a teaching error", () => {
    const { client, calls } = makeClient(),
      bad = { ...data, age: { increment: 1 } }
    expect(codeOf(async () => client.users.create({ data: bad as never }))).toBe("ValidationError")
    expect(codeOf(async () => client.users.createMany({ data: [bad as never] }))).toBe(
      "ValidationError",
    )
    expect(codeOf(async () => client.users.insert({ data: bad as never }))).toBe("ValidationError")
    expect(codeOf(async () => client.users.insertMany({ data: [bad as never] }))).toBe(
      "ValidationError",
    )
    expect(codeOf(async () => client.users.upsert({ data: bad as never }))).toBe("ValidationError")
    expect(
      codeOf(async () =>
        client.users.upsert({
          where: { id: "user:1" },
          onMissing: "create",
          data: { age: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(async () =>
        client.users.upsert({
          where: { id: "user:1" },
          onMissing: "create",
          create: { id: "user:1", ...bad } as never,
          update: { age: 1 },
        }),
      ),
    ).toBe("ValidationError")
    expect(codeOf(async () => client.users.upsertMany({ data: [bad as never] }))).toBe(
      "ValidationError",
    )
    expect(calls).toHaveLength(0)
  })

  test("the upsertMany update map rejects adjustments", () => {
    const { client } = makeClient()
    expect(
      codeOf(async () =>
        client.users.upsertMany({
          data: [{ id: "user:1", ...data }],
          update: { age: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("bad targets and operands fail eagerly", () => {
    const { client, calls } = makeClient()
    // Non-numeric field
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { name: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError")
    // Unknown field
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { ghost: { increment: 1 } } as never,
        }),
      ),
    ).toBe("ValidationError")
    // Identity
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { id: { increment: 1 } } as never,
        }),
      ),
    ).toBe("ValidationError")
    // Non-numeric operand
    expect(
      codeOf(async () =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: { increment: "x" } as never },
        }),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("relate edge data rejects adjustments (the edge is created anew)", () => {
    const { client } = makeClient()
    expect(
      codeOf(async () =>
        client.likes.relate({
          from: "user:1",
          to: "post:1",
          data: { score: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError")
  })

  test("a schemaless delegate adjusts any field (no column metadata to check)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]),
      client = betterSchemic(conn, {
        schema: defineSchema({ loose: "loose_table" }),
      })
    await client.loose.update({
      where: { id: "loose_table:1" },
      data: { counter: { increment: 1 } },
    })
    const call = calls.at(-1)
    expect(call?.sql).toBe("UPDATE loose_table:1 SET counter += $p0;")
  })
})

describe("adjustment markers — parsing and stripping", () => {
  test("adjustmentOf recognizes exactly-one-key plain markers", () => {
    expect(adjustmentOf({ increment: 1 })).toEqual({
      op: "+",
      family: "number",
      value: 1,
      kind: "increment",
    })
    expect(adjustmentOf({ decrement: 0 })).toEqual({
      op: "-",
      family: "number",
      value: 0,
      kind: "decrement",
    })
    // The array family: same one-key reserved shape, a different target field.
    expect(adjustmentOf({ append: "x" })).toEqual({
      op: "+",
      family: "array",
      value: "x",
      kind: "append",
    })
    expect(adjustmentOf({ remove: "x" })).toEqual({
      op: "-",
      family: "array",
      value: "x",
      kind: "remove",
    })
    expect(adjustmentOf({ union: ["x"] })).toEqual({
      op: "+",
      family: "array",
      value: ["x"],
      kind: "union",
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
      op: "+",
      family: "number",
      value: 2,
      kind: "increment",
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
    // A Decimal operand survives substitution (the schema can validate the exact class).
    const balance = new Decimal("1.50")
    expect(stripAdjustments({ balance: { increment: balance } })).toEqual({
      balance,
    })
    // A bigint operand survives too.
    expect(stripAdjustments({ balance: { decrement: 2n } })).toEqual({
      balance: 2n,
    })
    // A payload that IS a marker is passed through untouched (nonsensical as a table payload).
    expect(stripAdjustments({ increment: 5 })).toEqual({ increment: 5 })
  })
})

describe("array adjustments — append/remove/union/at", () => {
  const Tag = defineTable("tagged", {
      name: s.string(),
      score: s.int(),
      labels: s.array(s.string()),
    }),
    tagSchema = defineSchema({ tagged: Tag }),
    tagClient = (
      result: unknown = [{ id: new RecordId("tagged", "1"), name: "x", score: 0, labels: ["a"] }],
    ) => {
      const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok(result)))
      return { client: betterSchemic(conn, { schema: tagSchema }), calls }
    }

  test("append/remove lower to the compound assignment forms", async () => {
    const { client, calls } = tagClient()
    await client.tagged.update({
      where: { id: "tagged:1" },
      data: { labels: { append: "b" } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels += $p0;")
    expect(lastCall(calls).vars).toEqual({ p0: "b" })

    await client.tagged.update({
      where: { id: "tagged:1" },
      data: { labels: { append: ["b", "c"] } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels += $p0;")

    await client.tagged.update({
      where: { id: "tagged:1" },
      data: { labels: { remove: "b" } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels -= $p0;")
  })

  test("union uses array::union (the only DEDUPING merge) and at assigns an index", async () => {
    const { client, calls } = tagClient()
    await client.tagged.update({
      where: { id: "tagged:1" },
      data: { labels: { union: ["b"] } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels = array::union(labels, $p0);")

    await client.tagged.update({
      where: { id: "tagged:1" },
      data: { labels: { at: { index: 0, value: "z" } } },
    })
    expect(lastCall(calls).sql).toBe("UPDATE tagged:1 SET labels[0] = $p0;")
    expect(lastCall(calls).vars).toEqual({ p0: "z" })
  })

  test("an array marker on a non-array field teaches the family", async () => {
    const { client, calls } = tagClient(),
      code = codeOf(async () =>
        client.tagged.update({
          where: { id: "tagged:1" },
          data: { name: { append: "b" } },
        } as never),
      )
    expect(code).toBe("ValidationError")
    expect(calls).toHaveLength(0)
    // A numeric marker on an array field is the mirror-image error.
    expect(
      codeOf(async () =>
        client.tagged.update({
          where: { id: "tagged:1" },
          data: { labels: { increment: 1 } },
        } as never),
      ),
    ).toBe("ValidationError")
  })

  test("a malformed `at` operand is refused before the round-trip", () => {
    const { client, calls } = tagClient()
    expect(
      codeOf(async () =>
        client.tagged.update({
          where: { id: "tagged:1" },
          data: { labels: { at: { index: -1, value: "z" } } },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(
      codeOf(async () =>
        client.tagged.update({
          where: { id: "tagged:1" },
          data: { labels: { at: "z" } },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("an array marker on a create-shaped payload is refused like a numeric one", () => {
    const { client, calls } = tagClient()
    expect(
      codeOf(async () =>
        client.tagged.create({
          data: { name: "x", labels: { append: "b" } },
        } as never),
      ),
    ).toBe("ValidationError")
    expect(calls).toHaveLength(0)
  })

  test("stripAdjustments substitutes the array operand for the zod plugin", () => {
    expect(
      stripAdjustments({
        name: "x",
        labels: { append: "b" },
        tags: { union: ["a"] },
        note: surql`"kept"`,
      }),
    ).toEqual({ name: "x", labels: "b", tags: ["a"], note: surql`"kept"` })
  })
})

describe("adjustment operand classification — the decision table", () => {
  const T = defineTable("operand", {
      name: s.string(),
      score: s.int(),
      labels: s.array(s.string()),
    }),
    meta = buildSchemaIndex({ t: T }).tables.get("t")!,
    row = { id: new RecordId("operand", 1), name: "n", score: 1, labels: [] },
    code = (field: string, marker: unknown) => {
      const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([row]))),
        client = betterSchemic(conn, { schema: defineSchema({ t: T }) })
      try {
        void client.t.update({ where: { id: "operand:1" }, data: { [field]: marker } as never })
        calls.length
        return "OK"
      } catch (error) {
        return (error as BetterSchemicError).code
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
    // A function is not a value the server can bind
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
    const { conn, calls } = fakeConn((sql) => sql.split("\n").map(() => ok([row]))),
      client = betterSchemic(conn, { schema: defineSchema({ t: "t" }) })
    void client.t.update({ where: { id: "t:1" }, data: { anything: { increment: 1 } } })
    expect(calls[0]?.sql).toContain("anything += $p0")
  })
})
