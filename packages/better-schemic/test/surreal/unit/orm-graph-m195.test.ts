/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- Object key order mirrors expected serialized output and must stay as authored. Mock fixtures pass untyped values to exercise runtime SQL emission. Fixtures use any for duck-typed mocks. Type queries and callback signatures need fixture values. */
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { relation, s, table } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

const Person = table("person", { name: s.string() })
const Product = table("product", { name: s.string(), price: s.number() })
const Bought = relation("bought", {
  createdAt: s.datetime(),
})
  .from(Person)
  .to(Product)

const schema = { persons: Person, products: Product, bought: Bought }

describe("graph m19.5", () => {
  test("repeat", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.persons
      .from("person:B")
      .graph((g: any) => g.repeat({ min: 1, max: 2 }, (x: any) => x.out(Bought)).collect())
    console.log("REPEAT:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("{1..2+collect}(->bought->product)")
  })

  test("edge step + node", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.persons.from("person:B").graph((g: any) =>
      g
        .outEdges(Bought)
        .where((e: any) => e.createdAt.gte(new Date("2025-01-01")))
        .node()
        .select({ name: true }),
    )
    console.log("EDGE:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("->(bought WHERE createdAt >=")
    expect(calls[0]?.sql).toContain("->product.{name}")
  })

  test("edge only", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.persons
      .from("person:B")
      .graph((g: any) => g.outEdges(Bought).select({ createdAt: true }))
    console.log("EDGEONLY:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("->bought.{createdAt}")
  })
})
