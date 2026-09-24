// The create/insert lowering in isolation: the default operations, the singleton id, the
// skipDuplicates id guard and the insert/insertMany shape guards.
import { describe, expect, test } from "bun:test";
import { RecordId } from "surrealdb";
import { defineSingleton, s } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import {
  compileCreate,
  compileCreateMany,
  compileInsert,
  compileInsertMany,
} from "../../src/orm/compiler/write";
import { createBinds } from "../../src/orm/compiler/shared";
import { defineSchema } from "../../src/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";
import { schema } from "./orm-writes-fixtures";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

const { conn } = fakeConn(() => [ok([])]);
const client = betterSchemic(conn, { schema });
const meta = client.$index.tables.get("users")!;
const b = () => createBinds();
const sql = (plan: { statements: readonly string[] }): string =>
  plan.statements.join("\n");

describe("compileCreate / compileCreateMany", () => {
  test("default operations and an explicit RecordId", () => {
    expect(
      sql(compileCreate(meta, { data: { name: "A", email: "a@x" } }, b())),
    ).toContain("CREATE");
    expect(
      sql(
        compileCreate(
          meta,
          { data: { id: new RecordId("user", "1"), name: "A" } },
          b(),
        ),
      ),
    ).toContain("CREATE user");
    expect(
      sql(compileCreateMany(meta, { data: [{ name: "A" }] }, b())),
    ).toContain("CREATE");
  });

  test("skipDuplicates requires an id on every item", () => {
    expect(
      code(() => compileCreateMany(meta, { data: [5], skipDuplicates: true }, b())),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileCreateMany(meta, { data: [{ name: "A" }], skipDuplicates: true }, b()),
      ),
    ).toBe("ValidationError");
    expect(
      sql(
        compileCreateMany(
          meta,
          { data: [{ id: "user:1", name: "A" }], skipDuplicates: true },
          b(),
        ),
      ),
    ).toContain("INSERT IGNORE");
  });
});

describe("compileInsert / compileInsertMany", () => {
  test("default operations; array/single shape guards", () => {
    expect(
      sql(compileInsert(meta, { data: { name: "A", email: "a@x" } }, b())),
    ).toContain("INSERT");
    expect(
      code(() => compileInsert(meta, { data: [{ name: "A" }] }, b())),
    ).toBe("ValidationError");
    expect(sql(compileInsertMany(meta, { data: [{ name: "A" }] }, b()))).toContain(
      "INSERT",
    );
    expect(
      code(() => compileInsertMany(meta, { data: { name: "A" } }, b())),
    ).toBe("ValidationError");
    expect(code(() => compileInsertMany(meta, {}, b()))).toBe(
      "ValidationError",
    );
  });
});

describe("create — singleton tables", () => {
  test("a singleton delegate targets its fixed id", () => {
    const Config = defineSingleton("config", { value: s.string() });
    const c = betterSchemic(fakeConn(() => [ok([])]).conn, {
      schema: defineSchema({ config: Config }),
    });
    const configMeta = c.$index.tables.get("config")!;
    expect(
      sql(compileCreate(configMeta, { data: { value: "x" } }, b())),
    ).toContain("config:default");
  });
});
