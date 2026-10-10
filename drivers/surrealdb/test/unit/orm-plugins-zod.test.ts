// M6.3 — the `zod` validation plugin: validate write `data` with user Zod schemas (path in the
// ValidationError), and skip unconfigured tables. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { z } from "zod";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { defineSchema } from "../../src/orm/schema";
import { zod } from "../../src/plugins/zod";
import { defineTable, s } from "../../src/pure";
import { fakeConn, lines, ok } from "../orm-fixtures";

const User = defineTable("user", { name: s.string() });
const schema = defineSchema({ users: User });

const clientWith = (schemas: Record<string, z.ZodType>) => {
  const { conn } = fakeConn((sql) =>
    lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
  );
  return betterSchemic(conn, { schema, plugins: [zod({ schemas })] });
};

const codeOf = async (fn: () => unknown): Promise<string | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe("zod — write validation", () => {
  const schemaFor = { user: z.object({ name: z.string().min(2) }) };

  test("accepts valid data and rejects invalid with a ValidationError", async () => {
    const client = clientWith(schemaFor);
    expect(
      await codeOf(() => client.users.create({ data: { name: "Aeon" } })),
    ).toBeUndefined();
    expect(
      await codeOf(() => client.users.create({ data: { name: "A" } })),
    ).toBe("ValidationError");
  });

  test("validates every item of a batch", async () => {
    const client = clientWith(schemaFor);
    expect(
      await codeOf(() =>
        client.users.createMany({ data: [{ name: "Aeon" }, { name: "B" }] }),
      ),
    ).toBe("ValidationError");
  });

  test("tables without a schema are skipped", async () => {
    const client = clientWith({});
    expect(
      await codeOf(() => client.users.create({ data: { name: "A" } })),
    ).toBeUndefined();
  });

  test("reads and relates are neither create nor update — skipped", async () => {
    const client = clientWith(schemaFor);
    expect(await codeOf(() => client.users.findMany())).toBeUndefined();
  });

  test("validate.create:false skips create validation", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [zod({ schemas: schemaFor, validate: { create: false } })],
    });
    expect(
      await codeOf(() => client.users.create({ data: { name: "A" } })),
    ).toBeUndefined();
  });

  test("validate.update:false skips update validation", async () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() => ok([{ id: new RecordId("user", 1), name: "A" }])),
    );
    const client = betterSchemic(conn, {
      schema,
      plugins: [zod({ schemas: schemaFor, validate: { update: false } })],
    });
    expect(
      await codeOf(() =>
        client.users.update({
          where: { id: new RecordId("user", 1) },
          data: { name: "A" },
        }),
      ),
    ).toBeUndefined();
  });

  test("a data-less update (patch) is skipped", async () => {
    const client = clientWith(schemaFor);
    expect(
      await codeOf(() =>
        client.users.patch({
          where: { id: new RecordId("user", 1) },
          patches: [{ op: "replace", path: "/name", value: "Aeon" }],
        }),
      ),
    ).toBeUndefined();
  });

  test("upsertDelta validates its payload (update family)", async () => {
    const client = clientWith(schemaFor);
    expect(
      await codeOf(() =>
        client.users.upsertDelta({
          where: { id: "user:1" },
          data: { name: "A" },
        }),
      ),
    ).toBe("ValidationError");
    expect(
      await codeOf(() => client.users.upsertDelta({ data: { name: "A" } })),
    ).toBe("ValidationError");

    const { conn } = fakeConn((sql) =>
      lines(sql).map((line) =>
        ok(
          line.startsWith("UPSERT") || line.startsWith("CREATE")
            ? [{ after: { id: new RecordId("user", 1), name: "Aeon" } }]
            : null,
        ),
      ),
    );
    const valid = betterSchemic(conn, {
      schema,
      plugins: [zod({ schemas: schemaFor })],
    });
    expect(
      await codeOf(() =>
        valid.users.upsertDelta({
          where: { id: "user:1" },
          data: { name: "Aeon" },
          onMissing: "create",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("zod — numeric adjustments", () => {
  const Acct = defineTable("acct", { balance: s.int(), name: s.string() });
  const acctSchema = defineSchema({ accounts: Acct });
  const rules = {
    acct: z.object({
      balance: z.number().min(0).optional(),
      name: z.string().optional(),
    }),
  };
  const acctClient = () => {
    const { conn } = fakeConn((sql) =>
      lines(sql).map(() =>
        ok([{ id: new RecordId("acct", 1), balance: 10, name: "A" }]),
      ),
    );
    return betterSchemic(conn, {
      schema: acctSchema,
      plugins: [zod({ schemas: rules })],
    });
  };

  test("the marker wrapper is substituted by its OPERAND for validation", async () => {
    const client = acctClient();
    expect(
      await codeOf(() =>
        client.accounts.update({
          where: { id: "acct:1" },
          data: { balance: { increment: 5 } },
        }),
      ),
    ).toBeUndefined();
    // The operand itself is what the app schema checks (`min(0)` rejects -5).
    expect(
      await codeOf(() =>
        client.accounts.update({
          where: { id: "acct:1" },
          data: { balance: { increment: -5 } },
        }),
      ),
    ).toBe("ValidationError");
  });

  test("expression operands are dropped from validation (the server enforces them)", async () => {
    const client = acctClient();
    expect(
      await codeOf(() =>
        client.accounts.update({
          where: { id: "acct:1" },
          data: { balance: { increment: surql`1`.as<number>() } },
        }),
      ),
    ).toBeUndefined();
  });
});
