// M6.3 — the `zod` validation plugin: validate write `data` with user Zod schemas (path in the
// ValidationError), and skip unconfigured tables. Offline.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { z } from "zod";
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
});
