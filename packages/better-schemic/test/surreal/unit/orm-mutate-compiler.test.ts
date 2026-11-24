const MAGIC_2 = 2
const MAGIC_5 = 5
// The mutation compiler in isolation: the update/patch/upsert/delete/updateEach guards and the
// branchy lowering (return indexes, LET/IF, ON DUPLICATE). Direct calls pin each failure code.

import { describe, expect, test } from "bun:test"

import { surql } from "../../../src/surreal"
import { orm } from "../../../src/surreal/orm/client"
import {
  compileDelete,
  compileDeleteMany,
  compilePatch,
  compileUpdate,
  compileUpdateEach,
  compileUpdateMany,
  compileUpsert,
  compileUpsertMany,
} from "../../../src/surreal/orm/compiler/mutate"
import { type Binds, createBinds } from "../../../src/surreal/orm/compiler/shared"
import { required } from "../../required"
import { fakeConn, ok } from "../orm-fixtures"

import { schemaDef } from "./orm-writes-fixtures"

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

const { conn } = fakeConn(() => [ok([])])
const client = orm(conn, { schema: schemaDef })
const meta = required(client.$index.tables.get("users"))
const b = (): Binds => createBinds()
const sql = (plan: { statements: readonly string[] }): string => plan.statements.join("\n")

describe("compileUpdate / compileUpdateMany / compilePatch", () => {
  test("defaults and the update guards", () => {
    expect(
      sql(compileUpdate(meta, { data: { name: "B" }, where: { id: "user:1" } }, b())),
    ).toContain("UPDATE")
    // `before` reads the first statement.
    expect(
      compileUpdate(meta, { data: { name: "B" }, return: "before", where: { id: "user:1" } }, b())
        .resultIndexes,
    ).toEqual([0])
    // mode "patch" without patches (but with unset) rejects it.
    expect(
      code(() =>
        compileUpdate(meta, { mode: "patch", unset: ["name"], where: { id: "user:1" } }, b()),
      ),
    ).toBe("ValidationError")
    // patches without mode "patch" rejects it.
    expect(
      code(() =>
        compileUpdate(
          meta,
          {
            mode: "merge",
            patches: [{ op: "remove", path: "/a" }],
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toBe("ValidationError")
    // a non-object payload fails in the id guard's false branch, then in encodeData.
    expect(code(() => compileUpdate(meta, { data: 5, where: { id: "user:1" } }, b()))).toBe(
      "ValidationError",
    )
    // data + patches rejects it.
    expect(
      code(() =>
        compileUpdate(meta, { data: { name: "B" }, patches: [], where: { id: "user:1" } }, b()),
      ),
    ).toBe("ValidationError")
  })

  test("updateMany defaults; patch defaults and lowers PATCH", () => {
    expect(sql(compileUpdateMany(meta, { data: { name: "B" } }, b()))).toContain("UPDATE")
    expect(
      sql(
        compilePatch(
          meta,
          { patches: [{ op: "remove", path: "/a" }], where: { id: "user:1" } },
          b(),
        ),
      ),
    ).toContain("PATCH")
  })
})

describe("compileUpsert", () => {
  test("defaults (strict), only, and the XOR/mode guards", () => {
    // STRICT is the default: a plain UPDATE, never a create-or-update.
    expect(
      sql(compileUpsert(meta, { data: { email: "b@x", name: "B" }, where: { email: "b@x" } }, b())),
    ).toBe("UPDATE user MERGE $p0 WHERE email = $p1")
    expect(
      sql(compileUpsert(meta, { data: { name: "B" }, only: true, where: { id: "user:1" } }, b())),
    ).toBe("UPDATE ONLY user:1 MERGE $p0")
    // `onMissing: "create"` opts back into create-or-update.
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: { email: "b@x", name: "B" },
            onMissing: "create",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toContain("UPSERT")
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: { name: "B" },
            only: true,
            onMissing: "create",
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toContain("UPSERT ONLY")
    // create without update.
    expect(
      code(() => compileUpsert(meta, { create: { name: "B" }, where: { email: "b@x" } }, b())),
    ).toBe("ValidationError")
    // data + update.
    expect(
      code(() =>
        compileUpsert(
          meta,
          {
            data: { name: "B" },
            update: { name: "B" },
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toBe("ValidationError")
    // mode "patch" is not part of upsert.
    expect(
      code(() =>
        compileUpsert(meta, { data: { name: "B" }, mode: "patch", where: { email: "b@x" } }, b()),
      ),
    ).toBe("ValidationError")
    // mode "content" encodes for create (both strict and create modes).
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: { email: "b@x", name: "B" },
            mode: "content",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toContain("CONTENT")
  })

  test("id-target create/update: id guard, mismatch, ON DUPLICATE", () => {
    expect(
      code(() =>
        compileUpsert(
          meta,
          {
            create: {},
            onMissing: "create",
            update: { name: "B" },
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toBe("ValidationError")
    expect(
      code(() =>
        compileUpsert(
          meta,
          {
            create: { id: "user:2" },
            onMissing: "create",
            update: { name: "B" },
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toBe("ValidationError")
    expect(
      sql(
        compileUpsert(
          meta,
          {
            create: { id: "user:1", name: "B" },
            onMissing: "create",
            update: { name: "B" },
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE")
  })

  test("expressions route through LET/IF with return-aware tails (create mode)", () => {
    const expr = { email: "b@x", name: surql`"B"` }
    expect(
      sql(compileUpsert(meta, { data: expr, onMissing: "create", where: { email: "b@x" } }, b())),
    ).toContain("LET $__existing")
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: expr,
            onMissing: "create",
            return: "none",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toContain("RETURN NONE")
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: expr,
            onMissing: "create",
            return: "before",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toContain("RETURN BEFORE")
    expect(
      code(() =>
        compileUpsert(
          meta,
          {
            data: expr,
            onMissing: "create",
            return: "diff",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toBe("ReturnNotSupported")
    // STRICT (the default) needs no branch: the direct UPDATE evaluates the expression.
    expect(sql(compileUpsert(meta, { data: expr, where: { email: "b@x" } }, b()))).toBe(
      'UPDATE user MERGE { email: $b0, name: "B" } WHERE email = $p0',
    )
  })
})

describe("compileUpsertMany", () => {
  test("all-ids ON DUPLICATE, mixed ids, and the empty-update guard", () => {
    expect(
      sql(
        compileUpsertMany(
          meta,
          {
            data: [
              { id: "user:1", name: "A" },
              { id: "user:2", name: "B" },
            ],
          },
          b(),
        ),
      ),
    ).toContain("ON DUPLICATE")
    // explicit update map on the all-ids path.
    expect(
      sql(compileUpsertMany(meta, { data: [{ id: "user:1" }], update: { name: "B" } }, b())),
    ).toContain("ON DUPLICATE")
    // mixed ids.
    expect(
      code(() =>
        compileUpsertMany(meta, { data: [{ id: "user:1", name: "A" }, { name: "B" }] }, b()),
      ),
    ).toBe("ValidationError")
    // all-ids but no updatable fields (payload is id-).
    expect(code(() => compileUpsertMany(meta, { data: [{ id: "user:1" }] }, b()))).toBe(
      "ValidationError",
    )
  })

  test("conflict path: LET/IF, empty update map, diff guard", () => {
    expect(
      sql(compileUpsertMany(meta, { conflict: "email", data: [{ email: "a@x", name: "A" }] }, b())),
    ).toContain("UPSERT")
    expect(
      sql(
        compileUpsertMany(
          meta,
          {
            conflict: "email",
            data: [{ email: "a@x" }],
            update: { name: "B" },
          },
          b(),
        ),
      ),
    ).toContain("LET $__e0")
    expect(
      sql(
        compileUpsertMany(
          meta,
          {
            conflict: "email",
            data: [{ email: "a@x" }],
            return: "none",
            update: { name: "B" },
          },
          b(),
        ),
      ),
    ).toContain("RETURN NONE")
    expect(
      sql(
        compileUpsertMany(
          meta,
          {
            conflict: "email",
            data: [{ email: "a@x" }],
            return: "before",
            update: { name: "B" },
          },
          b(),
        ),
      ),
    ).toContain("RETURN BEFORE")
    expect(
      code(() =>
        compileUpsertMany(
          meta,
          {
            conflict: "email",
            data: [{ email: "a@x" }],
            return: "diff",
            update: { name: "B" },
          },
          b(),
        ),
      ),
    ).toBe("ReturnNotSupported")
    // empty update map.
    expect(
      code(() =>
        compileUpsertMany(meta, { conflict: "email", data: [{ email: "a@x" }], update: {} }, b()),
      ),
    ).toBe("ValidationError")
    // non-unique conflict field.
    expect(
      code(() => compileUpsertMany(meta, { conflict: "name", data: [{ name: "A" }] }, b())),
    ).toBe("UniqueTargetRequired")
  })
})

describe("compileDelete / compileDeleteMany", () => {
  test("defaults, id vs field targets, and the unsafe-all guard", () => {
    expect(sql(compileDelete(meta, { where: { id: "user:1" } }, b()))).toContain("DELETE")
    expect(sql(compileDelete(meta, { where: { email: "a@x" } }, b()))).toContain("DELETE FROM")
    expect(compileDelete(meta, { return: "none", where: { id: "user:1" } }, b()).result).toBe(
      "none",
    )
    expect(sql(compileDeleteMany(meta, { where: { name: "A" } }, b()))).toContain("DELETE FROM")
    expect(code(() => compileDeleteMany(meta, {}, b()))).toBe("UnsafeMutation")
    expect(sql(compileDeleteMany(meta, { all: true }, b()))).toContain("DELETE")
  })
})

describe("compileUpdateEach", () => {
  test("defaults, guards, and patch vs merge lowering", () => {
    expect(sql(compileUpdateEach(meta, { data: [{ id: "user:1", name: "B" }] }, b()))).toContain(
      "UPDATE",
    )
    // a non-object item.
    expect(code(() => compileUpdateEach(meta, { data: [MAGIC_5] }, b()))).toBe("ValidationError")
    // bad onEmpty.
    expect(
      code(() =>
        compileUpdateEach(meta, { data: [{ id: "user:1", name: "B" }], onEmpty: "skip" }, b()),
      ),
    ).toBe("ValidationError")
    // return none + onEmpty throw.
    expect(
      code(() =>
        compileUpdateEach(
          meta,
          {
            data: [{ id: "user:1", name: "B" }],
            onEmpty: "throw",
            return: "none",
          },
          b(),
        ),
      ),
    ).toBe("ValidationError")
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
    ).toBe("ValidationError")
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
    ).toContain("PATCH")
    // `id` cannot be a plain updated field when `by` is another column.
    expect(
      code(() =>
        compileUpdateEach(meta, { by: "email", data: [{ email: "a@x", id: "user:1" }] }, b()),
      ),
    ).toBe("ValidationError")
  })
})

describe("mutate — remaining reachable branches", () => {
  test("update RETURN DIFF spans every statement", () => {
    const plan = compileUpdate(
      meta,
      {
        data: { name: "B" },
        return: "diff",
        unset: ["age"],
        where: { id: "user:1" },
      },
      b(),
    )
    expect(plan.resultIndexes).toEqual([0, 1])
  })

  test("upsert mode replace encodes for create", () => {
    expect(
      sql(
        compileUpsert(
          meta,
          {
            data: { email: "b@x", name: "B" },
            mode: "replace",
            where: { email: "b@x" },
          },
          b(),
        ),
      ),
    ).toContain("REPLACE")
  })

  test("upsert id-target with a non-object create throws the id guard", () => {
    expect(
      code(() =>
        compileUpsert(meta, { create: 5, update: { name: "B" }, where: { id: "user:1" } }, b()),
      ),
    ).toBe("ValidationError")
  })

  test("upsertMany: update 'all', a non-object update, an empty conflict and diff-without-map", () => {
    expect(
      sql(compileUpsertMany(meta, { data: [{ id: "user:1", name: "A" }], update: "all" }, b())),
    ).toContain("ON DUPLICATE")
    expect(
      code(() =>
        compileUpsertMany(meta, { conflict: "email", data: [{ email: "a@x" }], update: 5 }, b()),
      ),
    ).toBe("ValidationError")
    expect(code(() => compileUpsertMany(meta, { conflict: "", data: [{ name: "A" }] }, b()))).toBe(
      "ValidationError",
    )
    // diff WITHOUT an explicit update map stays on the UPSERT-per-item path.
    expect(
      sql(
        compileUpsertMany(
          meta,
          { conflict: "email", data: [{ email: "a@x" }], return: "diff" },
          b(),
        ),
      ),
    ).toContain("UPSERT")
  })

  test("deleteMany RETURN NONE", () => {
    expect(compileDeleteMany(meta, { all: true, return: "none" }, b()).result).toBe("none")
  })

  test("updateEach: onEmpty 'return', select, and a non-record by", () => {
    expect(
      sql(compileUpdateEach(meta, { data: [{ id: "user:1", name: "B" }], onEmpty: "return" }, b())),
    ).toContain("UPDATE")
    expect(
      compileUpdateEach(meta, { data: [{ id: "user:1", name: "B" }], select: { name: true } }, b())
        .select,
    ).toBeDefined()
    expect(
      sql(compileUpdateEach(meta, { by: "email", data: [{ email: "a@x", name: "B" }] }, b())),
    ).toContain("WHERE email")
    // return none + onEmpty return allows it (no throw).
    expect(
      sql(
        compileUpdateEach(
          meta,
          {
            data: [{ id: "user:1", name: "B" }],
            onEmpty: "return",
            return: "none",
          },
          b(),
        ),
      ),
    ).toContain("UPDATE")
  })
})

// --- plugin scope (Operation.scope) --------------------------------------------------------------
// The internal channel `plugins/tenant` uses to scope a SINGULAR target (id/unique) without
// joining `uniqueTarget`: the scope ands it into the WHERE of every statement.

const scope = { org_id: { equals: "org:1" } }

describe("plugin scope — singular targets", () => {
  test("update by id appends WHERE <scope> (target resolution untouched)", () => {
    const plan = compileUpdate(meta, { data: { name: "B" }, scope, where: { id: "user:1" } }, b())
    expect(sql(plan)).toContain("UPDATE user:1 MERGE")
    expect(sql(plan)).toContain("WHERE org_id = ")
  })

  test("update by a unique field ANDs scope with the unique predicate", () => {
    const plan = compileUpdate(meta, { data: { name: "B" }, scope, where: { email: "a@x" } }, b())
    expect(sql(plan)).toContain("email = ")
    expect(sql(plan)).toContain("org_id = ")
  })

  test("patch, delete (id + unique) and deleteMany carry the scope", () => {
    expect(
      sql(
        compilePatch(
          meta,
          {
            patches: [{ op: "remove", path: "/name" }],
            scope,
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toContain("WHERE org_id = ")
    expect(sql(compileDelete(meta, { scope, where: { id: "user:1" } }, b()))).toContain(
      "DELETE user:1 WHERE org_id = ",
    )
    const unique = sql(compileDelete(meta, { scope, where: { email: "a@x" } }, b()))
    expect(unique).toContain("email = ")
    expect(unique).toContain("org_id = ")
    expect(sql(compileDeleteMany(meta, { scope, where: { active: true } }, b()))).toContain(
      "org_id = ",
    )
    // A scope alone still satisfies the destructive-write guard.
    expect(sql(compileDeleteMany(meta, { scope }, b()))).toContain(
      "DELETE FROM user WHERE org_id = ",
    )
  })

  test("updateMany ANDs scope with the caller's where", () => {
    const plan = compileUpdateMany(
      meta,
      { data: { name: "B" }, scope, where: { active: true } },
      b(),
    )
    expect(sql(plan)).toContain("active = ")
    expect(sql(plan)).toContain("org_id = ")
  })

  test("updateEach appends the scope to every per-item WHERE", () => {
    const plan = compileUpdateEach(
      meta,
      {
        data: [
          { id: "user:1", name: "B" },
          { id: "user:2", name: "C" },
        ],
        scope,
      },
      b(),
    )
    expect(plan.statements).toHaveLength(MAGIC_2)
    plan.statements.forEach((statement) => {
      expect(statement).toContain("WHERE id = ")
      expect(statement).toContain("org_id = ")
    })
  })

  test("upsert appends the scope to the resolved id/unique target", () => {
    // STRICT (default): the scope rides the UPDATE  WHERE.
    const strictById = sql(
      compileUpsert(meta, { data: { name: "B" }, scope, where: { id: "user:1" } }, b()),
    )
    expect(strictById).toContain("UPDATE ONLY user:1 MERGE")
    expect(strictById).toContain("WHERE org_id = ")
    // Create mode: the same scope on the UPSERT lowering.
    const byId = sql(
      compileUpsert(
        meta,
        {
          data: { name: "B" },
          onMissing: "create",
          scope,
          where: { id: "user:1" },
        },
        b(),
      ),
    )
    expect(byId).toContain("UPSERT user:1 MERGE")
    expect(byId).toContain("WHERE org_id = ")
    const byEmail = sql(
      compileUpsert(
        meta,
        {
          data: { name: "B" },
          onMissing: "create",
          scope,
          where: { email: "a@x" },
        },
        b(),
      ),
    )
    expect(byEmail).toContain("email = ")
    expect(byEmail).toContain("org_id = ")
  })

  test("upsert with distinct branches and an expression scopes the LET/IF WHERE", () => {
    const plan = compileUpsert(
      meta,
      {
        create: { id: "user:1", name: "B" },
        onMissing: "create",
        scope,
        update: { name: surql`"C"` },
        where: { id: "user:1" },
      },
      b(),
    )
    const sqlText = sql(plan)
    expect(sqlText).toContain("LET")
    expect(sqlText).toContain("org_id = ")
  })

  test("upsertMany by conflict scopes each per-item WHERE", () => {
    const plan = compileUpsertMany(
      meta,
      {
        conflict: "email",
        data: [
          { email: "a@x", name: "B" },
          { email: "b@x", name: "C" },
        ],
        scope,
      },
      b(),
    )
    expect(plan.statements).toHaveLength(MAGIC_2)
    plan.statements.forEach((statement) => {
      expect(statement).toContain("email = ")
      expect(statement).toContain("org_id = ")
    })
  })

  test("ON DUPLICATE lowerings without a WHERE refuse the scope", () => {
    expect(
      code(() => compileUpsertMany(meta, { data: [{ id: "user:1", name: "B" }], scope }, b())),
    ).toBe("UnsupportedCapability")
    expect(
      code(() =>
        compileUpsert(
          meta,
          {
            create: { id: "user:1", name: "B" },
            onMissing: "create",
            scope,
            update: { name: "B" },
            where: { id: "user:1" },
          },
          b(),
        ),
      ),
    ).toBe("UnsupportedCapability")
  })

  test("where: null and empty scope bags never produce an empty AND branch", () => {
    // `null` is a valid "no filter" for `where` — the scope alone must compile (regression: it
    // used to become `AND[null, scope]` and throw "empty filter").
    expect(
      sql(compileUpdateMany(meta, { data: { name: "B" }, scope, where: null }, b())),
    ).toContain("WHERE org_id = ")
    expect(sql(compileDeleteMany(meta, { all: true, scope, where: null }, b()))).toContain(
      "DELETE FROM user WHERE org_id = ",
    )
    // A -created EMPTY scope bag is a no-op, not an empty AND branch.
    expect(
      sql(
        compileUpdateMany(meta, { data: { name: "B" }, scope: {}, where: { active: true } }, b()),
      ),
    ).toContain("active = ")
  })

  test("without a scope the emitted SQL is unchanged", () => {
    expect(sql(compileUpdate(meta, { data: { name: "B" }, where: { id: "user:1" } }, b()))).toBe(
      "UPDATE user:1 MERGE $p0",
    )
    expect(sql(compileDelete(meta, { where: { id: "user:1" } }, b()))).toBe(
      "DELETE user:1 RETURN BEFORE",
    )
  })
})
