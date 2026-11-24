// The RELATE lowering in isolation: the default operations, endpoint validation, named/empty edge
// ids and the `create.relate` sugar guards. Direct calls pin the failure codes.

import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import {
  compileRelate,
  compileRelateMany,
  compileUnrelate,
  compileUnrelateMany,
  relateStatement,
  relateSugar,
} from "../../../src/surreal/orm/compiler/relate"
import { type Binds, createBinds } from "../../../src/surreal/orm/compiler/shared"
import { schema } from "../../../src/surreal/orm/schema"
import { relation } from "../../../src/surreal/pure"
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
const likes = required(client.$index.tables.get("likes"))
const user = required(client.$index.tables.get("users"))
const b = (): Binds => createBinds()

describe("relate / unrelate — defaults and guards", () => {
  test("default operations; named and empty edge ids", () => {
    expect(compileRelate(likes, { from: "user:1", to: "post:1" }, b()).statements[0]).toContain(
      "RELATE",
    )
    expect(
      compileRelateMany(likes, { data: [{ from: "user:1", to: "post:1" }] }, b()).statements[0],
    ).toContain("RELATE")
    expect(compileUnrelate(likes, { from: "user:1", to: "post:1" }, b()).statements[0]).toContain(
      "DELETE",
    )
    expect(compileUnrelateMany(likes, { all: true }, b()).statements[0]).toContain("DELETE")
    expect(
      compileRelate(likes, { from: "user:1", id: "likes:1", to: "post:1" }, b()).statements[0],
    ).toContain("likes:1")
    expect(code(() => compileRelate(likes, { from: "user:1", id: "", to: "post:1" }, b()))).toBe(
      "ValidationError",
    )
  })

  test("relateMany: missing from, per-item return; unrelate missing from", () => {
    expect(code(() => compileRelateMany(likes, { data: [{ to: "post:1" }] }, b()))).toBe(
      "ValidationError",
    )
    expect(
      code(() =>
        compileRelateMany(likes, { data: [{ from: "user:1", return: "none", to: "post:1" }] }, b()),
      ),
    ).toBe("ValidationError")
    expect(
      compileRelateMany(likes, { data: [{ from: "user:1", return: "after", to: "post:1" }] }, b())
        .statements,
    ).toHaveLength(1)
    expect(code(() => compileUnrelate(likes, { to: "post:1" }, b()))).toBe("ValidationError")
  })

  test("endpoints: a TO mismatch, an undefined endpoint, and no meta", () => {
    expect(code(() => compileRelate(likes, { from: "user:1", to: "user:1" }, b()))).toBe(
      "ValidationError",
    )
    const stmt = relateStatement(
      {
        data: { score: 1 },
        edge: "likes",
        from: "user:1",
        ret: "after",
        to: "post:1",
      },
      b(),
      "relate",
    )
    expect(stmt).toContain("SET")
    expect(
      code(() =>
        relateStatement(
          { edge: "likes", from: undefined, ret: "after", to: "post:1" },
          b(),
          "relate",
        ),
      ),
    ).toBe("ValidationError")
  })

  test("a relation with no declared endpoints accepts any table", () => {
    const Bare = relation("bare", {})
    const c = orm(fakeConn(() => [ok([])]).conn, {
      schema: schema({ bare: Bare }),
    })
    const bare = required(c.$index.tables.get("bare"))
    expect(compileRelate(bare, { from: "x:1", to: "y:1" }, b()).statements[0]).toContain("x:1")
  })
})

describe("relateSugar", () => {
  test("def edge, missing keys, unknown/table edges, no resolver", () => {
    expect(
      relateSugar([{ edge: { name: "likes" }, from: "user:1", to: "post:1" }], "create", likes)[0]
        ?.edge,
    ).toContain("likes")
    expect(code(() => relateSugar([{ edge: "likes", to: "post:1" }], "create", likes))).toBe(
      "ValidationError",
    )
    expect(code(() => relateSugar([{ from: "user:1", to: "post:1" }], "create", likes))).toBe(
      "ValidationError",
    )
    expect(
      code(() =>
        relateSugar(
          [{ edge: "ghost", from: "user:1", to: "post:1" }],
          "create",
          likes,
          () => undefined,
        ),
      ),
    ).toBe("ValidationError")
    expect(
      code(() => relateSugar([{ edge: 5, from: "user:1", to: "post:1" }], "create", likes)),
    ).toBe("ValidationError")
    expect(
      code(() =>
        relateSugar([{ edge: "user", from: "user:1", to: "post:1" }], "create", likes, () => user),
      ),
    ).toBe("ValidationError")
    const entries = relateSugar(
      [{ data: { score: 1 }, edge: "likes", from: "user:1", to: "post:1" }],
      "create",
      likes,
    )
    expect(entries[0]?.meta).toBeUndefined()
  })
})
