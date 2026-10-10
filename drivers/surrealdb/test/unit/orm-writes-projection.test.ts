// Write projections (`select`/`omit` riding `RETURN <projection>`) and numeric adjustments
// (`{ increment }`/`{ decrement }` → `SET f ±= $p`): the server-vs-client lowering, the decode,
// and the teaching guards. Core write goldens live in `orm-writes.test.ts`.
import { describe, expect, test } from "bun:test";
import { Decimal } from "surrealdb";
import { surql } from "../../src/index";
import { adjustmentOf, stripAdjustments } from "../../src/orm/arithmetic";
import { betterSchemic, type Client } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { defineTable, s } from "../../src/pure";
import { fakeConn, ok } from "../orm-fixtures";
import {
  codeOf,
  data,
  lastCall,
  makeClient,
  ROW,
  schema,
} from "./orm-writes-fixtures";

describe("write projections — server-side RETURN", () => {
  test("update/create/insert tail carry the projection", async () => {
    const { client, calls } = makeClient([{ name: "A" }]);
    const updated = await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { name: true },
    });
    expect(updated).toEqual({ name: "A" });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN name;");

    await client.users.create({
      data,
      select: { name: true, age: true },
    });
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN name, age;',
    );

    await client.users.insert({
      data: { id: "user:a", ...data },
      select: { name: true },
    });
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0 RETURN name;");
  });

  test("nested paths, aliases and expression entries render like reads", async () => {
    const { client, calls } = makeClient([{ address: { city: "SP" } }]);
    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { address: { city: true }, city: "address.city" },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 MERGE $p0 RETURN address.city, address.city AS city;",
    );

    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { upper: surql`string::uppercase(name)`.as<string>() },
    });
    expect(calls[calls.length - 1]?.sql).toContain("AS upper");
  });

  test("`*` + extra entries and ONLY forms", async () => {
    const { client, calls } = makeClient([ROW]);
    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { "*": true, age: true },
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN *, age;");
  });

  test("upsert (strict), upsertMany and updateEach tail the projection", async () => {
    const { client, calls } = makeClient([{ name: "A" }]);
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { name: true },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE ONLY user:1 MERGE $p0 RETURN name;",
    );

    await client.users.upsertMany({
      data: [{ id: "user:1", ...data }],
      select: { name: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN name;");

    await client.users.updateEach({
      data: [{ id: "user:1", age: 2 }],
      select: { age: true },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user MERGE $p1 WHERE id = $p0 RETURN age;",
    );
  });

  test("relate carries the projection in the same statement", async () => {
    const { client, calls } = makeClient([{ score: 5 }]);
    const edge = await client.likes.relate({
      from: "user:1",
      to: "post:1",
      data: { score: 5 },
      select: { score: true },
    });
    expect(edge).toEqual({ score: 5 });
    expect(lastCall(calls).sql).toBe(
      "RELATE user:1->likes->post:1 SET score = $p0 RETURN score;",
    );
  });

  test("patch / unset / onDuplicate also carry the projection", async () => {
    const { client, calls } = makeClient([{ tags: ["a"] }]);
    await client.users.patch({
      where: { id: "user:1" },
      patches: [{ op: "add", path: "/tags/-", value: "b" }],
      select: { tags: true },
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 PATCH $p0 RETURN tags;");

    await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      unset: ["active"],
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain("UNSET active RETURN age;");

    await client.users.insert({
      data: { id: "user:a", ...data },
      onDuplicate: "update",
      select: { name: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN name;");
  });

  test("batch (createMany) projects every statement", async () => {
    const { client, calls } = makeClient([{ name: "A" }]);
    const many = await client.users.createMany({
      data: [{ ...data }],
      select: { name: true },
    });
    expect(many.data).toEqual([{ name: "A" }]);
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN name;',
    );
  });

  test("skipDuplicates, insert and return:'before' create tails", async () => {
    const { client, calls } = makeClient([]);

    await client.users.createMany({
      data: [{ id: "user:a", ...data }],
      skipDuplicates: true,
      select: { name: true },
    });
    expect(lastCall(calls).sql).toBe(
      "INSERT IGNORE INTO user $p0 RETURN name;",
    );

    await client.users.insertMany({
      data: [{ id: "user:a", ...data }],
      select: { name: true },
    });
    expect(lastCall(calls).sql).toBe("INSERT INTO user $p0 RETURN name;");

    const created = await client.users.create({
      data,
      return: "before",
      select: { name: true },
    });
    expect(created).toBeNull();
    expect(lastCall(calls).sql).toBe(
      'CREATE type::record(s"user", rand::ulid()) CONTENT $p0 RETURN BEFORE;',
    );
  });

  test("a star-only select is a no-op (no RETURN clause, full decode)", async () => {
    const { client, calls } = makeClient([ROW]);
    const row = await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      select: { "*": true },
    });
    expect(row).toEqual(ROW);
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;");
    // `omit: []` projects nothing either — even with RETURN DIFF (which rejects real projections).
    const ops = [{ op: "replace", path: "/age", value: 3 }];
    const { client: diffClient } = makeClient([ops]);
    await diffClient.users.update({
      where: { id: "user:1" },
      data: { age: 3 },
      omit: [],
      return: "diff",
    });
  });

  test("insert diff+select is rejected; relate before/relateMany project", async () => {
    const { client, calls } = makeClient([]);
    expect(
      codeOf(() =>
        client.users.insert({
          data: { id: "user:a", ...data },
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.users.insertMany({
          data: [{ id: "user:a", ...data }],
          return: "diff",
          omit: ["email"],
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.likes.relate({
          from: "user:1",
          to: "post:1",
          return: "diff",
          select: { score: true },
        }),
      ),
    ).toBe("ReturnNotSupported");

    const before = await client.likes.relate({
      from: "user:1",
      to: "post:1",
      data: { score: 5 },
      return: "before",
      select: { score: true },
    });
    expect(before).toBeNull();
    expect(lastCall(calls).sql).toBe(
      "RELATE user:1->likes->post:1 SET score = $p0 RETURN BEFORE;",
    );

    await client.likes.relateMany({
      data: [{ from: "user:1", to: "post:1", data: { score: 1 } }],
      select: { score: true },
    });
    expect(lastCall(calls).sql).toBe(
      "RELATE user:1->likes->post:1 SET score = $p0 RETURN score;",
    );
  });
});

describe("write projections — client-side (before/delete/omit)", () => {
  test("return:'before' keeps RETURN BEFORE and decodes the projection client-side", async () => {
    const { client, calls } = makeClient([ROW]);
    const before = await client.users.update({
      where: { id: "user:1" },
      data: { age: 31 },
      return: "before",
      select: { name: true, city: "address.city" },
    });
    expect(before).toEqual({ name: "A", city: "SP" });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0 RETURN BEFORE;");
  });

  test("delete projects the removed row client-side", async () => {
    const { client, calls } = makeClient([ROW]);
    const removed = await client.users.delete({
      where: { id: "user:1" },
      select: { name: true },
    });
    expect(removed).toEqual({ name: "A" });
    expect(lastCall(calls).sql).toBe("DELETE user:1 RETURN BEFORE;");
  });

  test("omit strips fields client-side (RETURN … OMIT is a parse error)", async () => {
    const { client, calls } = makeClient([ROW]);
    const row = await client.users.update({
      where: { id: "user:1" },
      data: { age: 2 },
      omit: ["email", "tags"],
    });
    expect(row).toEqual({
      id: ROW.id,
      name: "A",
      age: 30,
      active: true,
      address: { city: "SP" },
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 MERGE $p0;");
  });

  test("upsertDelta + select projects record/before (and the delta covers those fields)", async () => {
    const envelope = {
      before: ROW,
      after: { ...ROW, age: 31 },
    };
    const { conn } = fakeConn(() => [ok([envelope])]);
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const out = await client.users.upsertDelta({
      where: { id: "user:1" },
      data: { age: 31 },
      select: { age: true },
    });
    expect(out).toEqual({
      record: { age: 31 },
      created: false,
      before: { age: 30 },
      delta: { old: { age: 30 }, new: { age: 31 } },
      changed: ["age"],
    });
  });

  test("omit applies client-side to upsertDelta and updateEach too", async () => {
    const envelope = { before: ROW, after: { ...ROW, age: 31 } };
    const { conn } = fakeConn(() => [ok([envelope])]);
    const client = betterSchemic(conn, { schema }) as Client<typeof schema>;
    const out = await client.users.upsertDelta({
      where: { id: "user:1" },
      data: { age: 31 },
      omit: ["email"],
    });
    expect(out.record).not.toHaveProperty("email");
    expect(out.record?.age).toBe(31);

    const each = makeClient([ROW]);
    const result = await each.client.users.updateEach({
      data: [{ id: "user:1", age: 2 }],
      omit: ["email"],
    });
    expect(result.data?.[0]).not.toHaveProperty("email");
    expect(result.data?.[0]).toMatchObject({ age: 30, name: "A" });
  });

  test("expression entries are rejected when only the client can project", () => {
    const { client, calls } = makeClient([ROW]);
    const expression = { upper: surql`string::uppercase(name)`.as<string>() };
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: 2 },
          return: "before",
          select: expression,
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.users.upsertDelta({
          where: { id: "user:1" },
          data: { age: 2 },
          select: expression,
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(calls).toHaveLength(0);
  });

  test("RETURN DIFF rejects select/omit with a teaching error", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: 2 },
          return: "diff",
          select: { age: true },
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.users.create({
          data,
          return: "diff",
          omit: ["email"],
        }),
      ),
    ).toBe("ReturnNotSupported");
    expect(
      codeOf(() =>
        client.users.createMany({
          data: [{ ...data }],
          return: "diff",
          select: { name: true },
        }),
      ),
    ).toBe("ReturnNotSupported");
  });

  test("create.relate sugar projects client-side", async () => {
    const { client, calls } = makeClient([{ name: "A" }]);
    await client.users.create({
      data,
      relate: [{ from: "user:1", edge: "likes", to: "post:1" }],
      select: { name: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN $__created;");
  });
});

describe("projections across the upsert lowerings", () => {
  test("strict upsert targets project (unique field, before → client)", async () => {
    const { client, calls } = makeClient([{ age: 30 }]);
    await client.users.upsert({
      where: { email: "a@x" },
      data: { age: 30 },
      select: { age: true },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user MERGE $p0 WHERE email = $p1 RETURN age;",
    );

    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 30 },
      return: "before",
      select: { age: true },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE ONLY user:1 MERGE $p0 RETURN BEFORE;",
    );
  });

  test("create-mode upsert lowerings carry the projection", async () => {
    const { client, calls } = makeClient([{ age: 30 }]);
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: 30 },
      onMissing: "create",
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain(
      "UPSERT user:1 MERGE $p0 RETURN age;",
    );

    await client.users.upsert({
      where: { email: "a@x" },
      data: { email: "a@x", age: 30 },
      onMissing: "create",
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN age;");

    await client.users.upsert({
      where: { email: "a@x" },
      data: { id: "user:1", email: "a@x", age: 30 },
      onMissing: "create",
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN age;");
  });

  test("expression upserts project EACH LET/IF branch", async () => {
    const { client, calls } = makeClient([{ age: 30 }]);
    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: surql`age + 1`.as<number>() },
      onMissing: "create",
      select: { age: true },
    });
    const sql = lastCall(calls).sql;
    expect(sql).toContain("RETURN age ELSE");
    expect(sql).toContain("RETURN age END;");
  });

  test("upsertMany, targetless upsert and upsertDelta project", async () => {
    const { client, calls } = makeClient([ROW]);
    await client.users.upsertMany({
      data: [{ ...data }],
      conflict: "email",
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN age;");

    await client.users.upsert({
      data: { ...data },
      select: { age: true },
    });
    expect(lastCall(calls).sql).toContain("RETURN age;");

    await client.users.upsert({ data: { ...data }, return: "before" });
    expect(lastCall(calls).sql).toContain("RETURN BEFORE;");

    const envelope = { before: ROW, after: { ...ROW, age: 31 } };
    const { conn } = fakeConn(() => [ok([envelope])]);
    const deltaClient = betterSchemic(conn, {
      schema,
    }) as Client<typeof schema>;
    const created = await deltaClient.users.upsertDelta({
      data: { ...data },
      select: { age: true },
    });
    expect(created.record).toEqual({ age: 31 });
  });
});

describe("arithmetic adjustments — lowering", () => {
  test("merge mode compiles SET with += / -= (and flattens nested objects)", async () => {
    const { client, calls } = makeClient();
    await client.users.update({
      where: { id: "user:1" },
      data: { age: { increment: 1 } },
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;");

    await client.users.update({
      where: { id: "user:1" },
      data: { name: "B", age: { decrement: 2 } },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 SET name = $p0, age -= $p1;",
    );

    await client.users.update({
      where: { id: "user:1" },
      data: { address: { city: "X" }, age: { increment: 1 } },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 SET address.city = $p0, age += $p1;",
    );

    // An empty nested object is a MERGE no-op — it contributes NO assignment.
    await client.users.update({
      where: { id: "user:1" },
      data: { address: {}, age: { increment: 1 } },
    });
    expect(lastCall(calls).sql).toBe("UPDATE user:1 SET age += $p0;");
  });

  test("mode set keeps top-level assignments; content/replace reject adjustments", async () => {
    const { client, calls } = makeClient();
    await client.users.update({
      where: { id: "user:1" },
      mode: "set",
      data: { name: "B", age: { increment: 1 } },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user:1 SET name = $p0, age += $p1;",
    );

    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          mode: "content",
          data: { ...data, age: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError");
  });

  test("updateMany/updateEach/strict upsert lower adjustments", async () => {
    const { client, calls } = makeClient();
    await client.users.updateMany({
      where: { active: true },
      data: { age: { increment: 1 } },
    });
    expect(lastCall(calls).sql).toBe(
      "UPDATE user SET age += $p1 WHERE active = $p0;",
    );

    await client.users.updateEach({
      data: [
        { id: "user:1", age: { increment: 1 } },
        { id: "user:2", age: { decrement: 3 } },
      ],
    });
    expect(lastCall(calls).sql).toContain("SET age += $p1 WHERE id = $p0;");
    expect(lastCall(calls).sql).toContain("SET age -= $p3 WHERE id = $p2;");

    await client.users.upsert({
      where: { id: "user:1" },
      data: { age: { decrement: 1 } },
    });
    expect(lastCall(calls).sql).toBe("UPDATE ONLY user:1 SET age -= $p0;");
  });

  test("distinct create/update: the update branch adjusts through LET/IF", async () => {
    const { client, calls } = makeClient([ROW]);
    await client.users.upsert({
      where: { id: "user:1" },
      onMissing: "create",
      create: { id: "user:1", ...data },
      update: { age: { increment: 1 } },
    });
    const sql = lastCall(calls).sql;
    expect(sql).toContain("LET $__existing");
    expect(sql).toContain("SET age += ");
  });

  test("expression operands splice; fragments work in merge mode", async () => {
    const { client, calls } = makeClient();
    await client.users.update({
      where: { id: "user:1" },
      data: { age: { increment: surql`2`.as<number>() } },
    });
    expect(lastCall(calls).sql).toContain("SET age += ");
  });

  test("Decimal operands bind; replace/patch modes reject adjustments", async () => {
    const Ledger = defineTable("ledger", { balance: s.decimal() });
    const { conn, calls } = fakeConn(() => [ok([])]);
    const ledger = betterSchemic(conn, {
      schema: defineSchema({ ledgers: Ledger }),
    });
    await ledger.ledgers.update({
      where: { id: "ledger:1" },
      data: { balance: { increment: new Decimal("1.5") } },
    });
    const call = calls[calls.length - 1];
    expect(call?.sql).toBe("UPDATE ledger:1 SET balance += $p0;");
    expect(call?.vars?.p0).toBeInstanceOf(Decimal);

    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          mode: "replace",
          data: { ...data, age: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError");
  });
});

describe("arithmetic adjustments — guards", () => {
  test("create-shaped writes reject markers with a teaching error", () => {
    const { client, calls } = makeClient();
    const bad = { ...data, age: { increment: 1 } };
    expect(codeOf(() => client.users.create({ data: bad as never }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() => client.users.createMany({ data: [bad as never] })),
    ).toBe("ValidationError");
    expect(codeOf(() => client.users.insert({ data: bad as never }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() => client.users.insertMany({ data: [bad as never] })),
    ).toBe("ValidationError");
    expect(codeOf(() => client.users.upsert({ data: bad as never }))).toBe(
      "ValidationError",
    );
    expect(
      codeOf(() =>
        client.users.upsert({
          where: { id: "user:1" },
          onMissing: "create",
          data: { age: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() =>
        client.users.upsert({
          where: { id: "user:1" },
          onMissing: "create",
          create: { id: "user:1", ...bad } as never,
          update: { age: 1 },
        }),
      ),
    ).toBe("ValidationError");
    expect(
      codeOf(() => client.users.upsertMany({ data: [bad as never] })),
    ).toBe("ValidationError");
    expect(calls).toHaveLength(0);
  });

  test("the upsertMany update map rejects adjustments", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.users.upsertMany({
          data: [{ id: "user:1", ...data }],
          update: { age: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError");
  });

  test("bad targets and operands fail eagerly", () => {
    const { client, calls } = makeClient();
    // non-numeric field
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { name: { increment: 1 } as never },
        }),
      ),
    ).toBe("ValidationError");
    // unknown field
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { ghost: { increment: 1 } } as never,
        }),
      ),
    ).toBe("ValidationError");
    // identity
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { id: { increment: 1 } } as never,
        }),
      ),
    ).toBe("ValidationError");
    // non-numeric operand
    expect(
      codeOf(() =>
        client.users.update({
          where: { id: "user:1" },
          data: { age: { increment: "x" } as never },
        }),
      ),
    ).toBe("ValidationError");
    expect(calls).toHaveLength(0);
  });

  test("relate edge data rejects adjustments (the edge is created anew)", () => {
    const { client } = makeClient();
    expect(
      codeOf(() =>
        client.likes.relate({
          from: "user:1",
          to: "post:1",
          data: { score: { increment: 1 } },
        }),
      ),
    ).toBe("ValidationError");
  });

  test("a schemaless delegate adjusts any field (no column metadata to check)", async () => {
    const { conn, calls } = fakeConn(() => [ok([])]);
    const client = betterSchemic(conn, {
      schema: defineSchema({ loose: "loose_table" }),
    });
    await client.loose.update({
      where: { id: "loose_table:1" },
      data: { counter: { increment: 1 } },
    });
    const call = calls[calls.length - 1];
    expect(call?.sql).toBe("UPDATE loose_table:1 SET counter += $p0;");
  });
});

describe("adjustment markers — parsing and stripping", () => {
  test("adjustmentOf recognizes exactly-one-key plain markers", () => {
    expect(adjustmentOf({ increment: 1 })).toEqual({
      op: "+",
      value: 1,
      kind: "increment",
    });
    expect(adjustmentOf({ decrement: 0 })).toEqual({
      op: "-",
      value: 0,
      kind: "decrement",
    });
    expect(adjustmentOf({ increment: 1, other: 2 })).toBeUndefined();
    expect(adjustmentOf({ nope: 1 })).toBeUndefined();
    expect(adjustmentOf({ increment: undefined })).toBeUndefined();
    expect(adjustmentOf(null)).toBeUndefined();
    expect(adjustmentOf([1])).toBeUndefined();
    expect(adjustmentOf(new Date())).toBeUndefined();
    // A null-prototype object passes the plain-object guard (proto !== null is false).
    const bare = Object.assign(Object.create(null), { increment: 2 });
    expect(adjustmentOf(bare)).toEqual({
      op: "+",
      value: 2,
      kind: "increment",
    });
  });

  test("stripAdjustments substitutes numeric operands (arrays mapped, expressions dropped)", () => {
    expect(stripAdjustments({ age: { decrement: 2 }, name: "B" })).toEqual({
      age: 2,
      name: "B",
    });
    expect(
      stripAdjustments([
        { age: { increment: 1 } },
        { age: { increment: surql`1`.as<number>() } },
      ]),
    ).toEqual([{ age: 1 }, {}]);
    expect(stripAdjustments("x")).toBe("x");
    expect(stripAdjustments(null)).toBeNull();
    // A Decimal operand survives substitution (the schema can validate the exact class).
    const balance = new Decimal("1.50");
    expect(stripAdjustments({ balance: { increment: balance } })).toEqual({
      balance,
    });
    // A bigint operand survives too.
    expect(stripAdjustments({ balance: { decrement: 2n } })).toEqual({
      balance: 2n,
    });
    // A payload that IS a marker is passed through untouched (nonsensical as a table payload).
    expect(stripAdjustments({ increment: 5 })).toEqual({ increment: 5 });
  });
});
