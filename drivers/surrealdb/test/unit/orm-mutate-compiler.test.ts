// The mutation compiler in isolation: the update/patch/upsert/delete/updateEach guards and the
// branchy lowering (return indexes, LET/IF, ON DUPLICATE). Direct calls pin each failure code.
import { describe, expect, test } from "bun:test";
import { surql } from "../../src/index";
import { betterSchemic } from "../../src/orm/client";
import { createBinds } from "../../src/orm/compiler/shared";
import {
  compileDelete,
  compileDeleteMany,
  compilePatch,
  compileUpdate,
  compileUpdateEach,
  compileUpdateMany,
  compileUpsert,
  compileUpsertMany,
} from "../../src/orm/compiler/mutate";
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

describe("compileUpdate / compileUpdateMany / compilePatch", () => {
  test("defaults and the update guards", () => {
    expect(
      sql(compileUpdate(meta, { where: { id: "user:1" }, data: { name: "B" } }, b())),
    ).toContain("UPDATE");
    // `before` reads the first statement.
    expect(
      compileUpdate(
        meta,
        { where: { id: "user:1" }, data: { name: "B" }, return: "before" },
        b(),
      ).resultIndexes,
    ).toEqual([0]);
    // mode "patch" without patches (but with unset) is rejected.
    expect(
      code(() =>
        compileUpdate(
          meta,
          { where: { id: "user:1" }, mode: "patch", unset: ["name"] },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // patches without mode "patch" is rejected.
    expect(
      code(() =>
        compileUpdate(
          meta,
          { where: { id: "user:1" }, mode: "merge", patches: [{ op: "remove", path: "/a" }] },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // a non-object payload fails in the id guard's false branch, then in encodeData.
    expect(
      code(() => compileUpdate(meta, { where: { id: "user:1" }, data: 5 }, b())),
    ).toBe("ValidationError");
    // data + patches is rejected.
    expect(
      code(() =>
        compileUpdate(
          meta,
          { where: { id: "user:1" }, data: { name: "B" }, patches: [] },
          b(),
        ),
      ),
    ).toBe("ValidationError");
  });

  test("updateMany defaults; patch defaults and lowers PATCH", () => {
    expect(
      sql(compileUpdateMany(meta, { data: { name: "B" } }, b())),
    ).toContain("UPDATE");
    expect(
      sql(
        compilePatch(
          meta,
          { where: { id: "user:1" }, patches: [{ op: "remove", path: "/a" }] },
          b(),
        ),
      ),
    ).toContain("PATCH");
  });
});

describe("compileUpsert", () => {
  test("defaults, only, and the XOR/mode guards", () => {
    expect(
      sql(compileUpsert(meta, { where: { email: "b@x" }, data: { name: "B", email: "b@x" } }, b())),
    ).toContain("UPSERT");
    expect(
      sql(
        compileUpsert(
          meta,
          { where: { id: "user:1" }, data: { name: "B" }, only: true },
          b(),
        ),
      ),
    ).toContain("UPSERT ONLY");
    // create without update.
    expect(
      code(() => compileUpsert(meta, { where: { email: "b@x" }, create: { name: "B" } }, b())),
    ).toBe("ValidationError");
    // data + update.
    expect(
      code(() =>
        compileUpsert(
          meta,
          { where: { email: "b@x" }, data: { name: "B" }, update: { name: "B" } },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // mode "patch" is not part of upsert.
    expect(
      code(() =>
        compileUpsert(meta, { where: { email: "b@x" }, data: { name: "B" }, mode: "patch" }, b()),
      ),
    ).toBe("ValidationError");
    // mode "content" encodes for create.
    expect(
      sql(
        compileUpsert(
          meta,
          { where: { email: "b@x" }, data: { name: "B", email: "b@x" }, mode: "content" },
          b(),
        ),
      ),
    ).toContain("CONTENT");
  });

  test("id-target create/update: id guard, mismatch, ON DUPLICATE", () => {
    expect(
      code(() =>
        compileUpsert(meta, { where: { id: "user:1" }, create: {}, update: { name: "B" } }, b()),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileUpsert(
          meta,
          { where: { id: "user:1" }, create: { id: "user:2" }, update: { name: "B" } },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    expect(
      sql(
        compileUpsert(
          meta,
          { where: { id: "user:1" }, create: { id: "user:1", name: "B" }, update: { name: "B" } },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE");
  });

  test("expressions route through LET/IF with return-aware tails", () => {
    const expr = { name: surql`"B"`, email: "b@x" };
    expect(
      sql(compileUpsert(meta, { where: { email: "b@x" }, data: expr }, b())),
    ).toContain("LET $__existing");
    expect(
      sql(compileUpsert(meta, { where: { email: "b@x" }, data: expr, return: "none" }, b())),
    ).toContain("RETURN NONE");
    expect(
      sql(compileUpsert(meta, { where: { email: "b@x" }, data: expr, return: "before" }, b())),
    ).toContain("RETURN BEFORE");
    expect(
      code(() =>
        compileUpsert(meta, { where: { email: "b@x" }, data: expr, return: "diff" }, b()),
      ),
    ).toBe("ReturnNotSupported");
  });
});

describe("compileUpsertMany", () => {
  test("all-ids ON DUPLICATE, mixed ids, and the empty-update guard", () => {
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ id: "user:1", name: "A" }, { id: "user:2", name: "B" }] },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE");
    // explicit update map on the all-ids path.
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ id: "user:1" }], update: { name: "B" } },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE");
    // mixed ids.
    expect(
      code(() =>
        compileUpsertMany(
          meta,
          { data: [{ id: "user:1", name: "A" }, { name: "B" }] },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // all-ids but no updatable fields (payload is id-only).
    expect(
      code(() => compileUpsertMany(meta, { data: [{ id: "user:1" }] }, b())),
    ).toBe("ValidationError");
  });

  test("conflict path: LET/IF, empty update map, diff guard", () => {
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x", name: "A" }], conflict: "email" },
          b(),
        ),
      ),
    ).toContain("UPSERT");
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", update: { name: "B" } },
          b(),
        ),
      ),
    ).toContain("LET $__e0");
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", update: { name: "B" }, return: "none" },
          b(),
        ),
      ),
    ).toContain("RETURN NONE");
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", update: { name: "B" }, return: "before" },
          b(),
        ),
      ),
    ).toContain("RETURN BEFORE");
    expect(
      code(() =>
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", update: { name: "B" }, return: "diff" },
          b(),
        ),
      ),
    ).toBe("ReturnNotSupported");
    // empty update map.
    expect(
      code(() =>
        compileUpsertMany(meta, { data: [{ email: "a@x" }], conflict: "email", update: {} }, b()),
      ),
    ).toBe("ValidationError");
    // non-unique conflict field.
    expect(
      code(() =>
        compileUpsertMany(meta, { data: [{ name: "A" }], conflict: "name" }, b()),
      ),
    ).toBe("UniqueTargetRequired");
  });
});

describe("compileDelete / compileDeleteMany", () => {
  test("defaults, id vs field targets, and the unsafe-all guard", () => {
    expect(sql(compileDelete(meta, { where: { id: "user:1" } }, b()))).toContain("DELETE");
    expect(
      sql(compileDelete(meta, { where: { email: "a@x" } }, b())),
    ).toContain("DELETE FROM");
    expect(
      compileDelete(meta, { where: { id: "user:1" }, return: "none" }, b()).result,
    ).toBe("none");
    expect(
      sql(compileDeleteMany(meta, { where: { name: "A" } }, b())),
    ).toContain("DELETE FROM");
    expect(code(() => compileDeleteMany(meta, {}, b()))).toBe("UnsafeMutation");
    expect(sql(compileDeleteMany(meta, { all: true }, b()))).toContain("DELETE");
  });
});

describe("compileUpdateEach", () => {
  test("defaults, guards, and patch vs merge lowering", () => {
    expect(
      sql(compileUpdateEach(meta, { data: [{ id: "user:1", name: "B" }] }, b())),
    ).toContain("UPDATE");
    // a non-object item.
    expect(code(() => compileUpdateEach(meta, { data: [5] }, b()))).toBe(
      "ValidationError",
    );
    // bad onEmpty.
    expect(
      code(() =>
        compileUpdateEach(
          meta,
          { data: [{ id: "user:1", name: "B" }], onEmpty: "skip" },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // return none + onEmpty throw.
    expect(
      code(() =>
        compileUpdateEach(
          meta,
          { data: [{ id: "user:1", name: "B" }], return: "none", onEmpty: "throw" },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // patches length mismatch.
    expect(
      code(() =>
        compileUpdateEach(
          meta,
          {
            data: [{ id: "user:1" }],
            mode: "patch",
            patches: [
              { op: "remove", path: "/a" },
              { op: "remove", path: "/b" },
            ],
          },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    // patch mode happy path.
    expect(
      sql(
        compileUpdateEach(
          meta,
          {
            data: [{ id: "user:1" }],
            mode: "patch",
            patches: [[{ op: "remove", path: "/a" }]],
          },
          b(),
        ),
      ),
    ).toContain("PATCH");
    // `id` cannot be a plain updated field when `by` is another column.
    expect(
      code(() =>
        compileUpdateEach(
          meta,
          { data: [{ email: "a@x", id: "user:1" }], by: "email" },
          b(),
        ),
      ),
    ).toBe("ValidationError");
  });
});

describe("mutate — remaining reachable branches", () => {
  test("update RETURN DIFF spans every statement", () => {
    const plan = compileUpdate(
      meta,
      {
        where: { id: "user:1" },
        data: { name: "B" },
        unset: ["age"],
        return: "diff",
      },
      b(),
    );
    expect(plan.resultIndexes).toEqual([0, 1]);
  });

  test("upsert mode replace encodes for create", () => {
    expect(
      sql(
        compileUpsert(
          meta,
          { where: { email: "b@x" }, data: { name: "B", email: "b@x" }, mode: "replace" },
          b(),
        ),
      ),
    ).toContain("REPLACE");
  });

  test("upsert id-target with a non-object create throws the id guard", () => {
    expect(
      code(() =>
        compileUpsert(meta, { where: { id: "user:1" }, create: 5, update: { name: "B" } }, b()),
      ),
    ).toBe("ValidationError");
  });

  test("upsertMany: update 'all', a non-object update, an empty conflict and diff-without-map", () => {
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ id: "user:1", name: "A" }], update: "all" },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE");
    expect(
      code(() =>
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", update: 5 },
          b(),
        ),
      ),
    ).toBe("ValidationError");
    expect(
      code(() =>
        compileUpsertMany(meta, { data: [{ name: "A" }], conflict: "" }, b()),
      ),
    ).toBe("ValidationError");
    // diff WITHOUT an explicit update map stays on the UPSERT-per-item path.
    expect(
      sql(
        compileUpsertMany(
          meta,
          { data: [{ email: "a@x" }], conflict: "email", return: "diff" },
          b(),
        ),
      ),
    ).toContain("UPSERT");
  });

  test("deleteMany RETURN NONE", () => {
    expect(
      compileDeleteMany(meta, { all: true, return: "none" }, b()).result,
    ).toBe("none");
  });

  test("updateEach: onEmpty 'return', select, and a non-record by", () => {
    expect(
      sql(
        compileUpdateEach(
          meta,
          { data: [{ id: "user:1", name: "B" }], onEmpty: "return" },
          b(),
        ),
      ),
    ).toContain("UPDATE");
    expect(
      compileUpdateEach(
        meta,
        { data: [{ id: "user:1", name: "B" }], select: { name: true } },
        b(),
      ).select,
    ).toBeDefined();
    expect(
      sql(
        compileUpdateEach(
          meta,
          { data: [{ email: "a@x", name: "B" }], by: "email" },
          b(),
        ),
      ),
    ).toContain("WHERE email");
    // return none + onEmpty return is allowed (no throw).
    expect(
      sql(
        compileUpdateEach(
          meta,
          { data: [{ id: "user:1", name: "B" }], return: "none", onEmpty: "return" },
          b(),
        ),
      ),
    ).toContain("UPDATE");
  });
});
