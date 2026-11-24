/* eslint-disable perfectionist/sort-objects, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- Object key order mirrors expected serialized output and must stay as authored. Mock fixtures pass untyped values to exercise runtime SQL emission. Fixtures use any for duck-typed mocks. Type queries and callback signatures need fixture values. */
import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { relation, s, table } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

const Person = table("person", { name: s.string() })
const Product = table("product", { name: s.string(), price: s.number() })
const Bought = relation("bought", {}).from(Person).to(Product)
const schema = { persons: Person, products: Product, bought: Bought }

describe("graph traverse", () => {
  test("tagged template", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])])
    const client: any = orm(conn, { schema } as any)
    await client.persons.from("person:B").traverse`->bought->product<-bought<-person`
    console.log("TRAV:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("->bought->product")
  })
})
