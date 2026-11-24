import { describe, expect, test } from "bun:test"

import { orm } from "../../../src/surreal/orm/client"
import { relation, s, table } from "../../../src/surreal/pure"
import { fakeConn, ok } from "../orm-fixtures"

const Person = table("person", { name: s.string() })
const Product = table("product", { name: s.string(), price: s.number() })
const Bought = relation("bought", {}).from(Person).to(Product)
const schema = { bought: Bought, persons: Person, products: Product }

describe("graph traverse", () => {
  test("tagged template", async () => {
    const { calls, conn } = fakeConn((_sql) => [ok([])])
    const client = orm(conn, { schema })
    await client.persons.from("person:B").traverse`->bought->product<-bought<-person`
    console.log("TRAV:", calls[0]?.sql)
    expect(calls[0]?.sql).toContain("->bought->product")
  })
})
