import { describe, expect, test } from "bun:test";
import { table, s } from "../../../src/surreal/pure";
import { orm } from "../../../src/surreal/orm/client";
import { buildSchemaIndex } from "../../../src/surreal/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";

const Person = table("person", { name: s.string() });
const Product = table("product", { name: s.string(), price: s.number() });
const Bought = (require("../../../src/surreal/pure").relation as any)("bought", {}).from(Person).to(Product);
const schema = { persons: Person, products: Product, bought: Bought };

describe("graph traverse", () => {
  test("tagged template", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([])]);
    const client: any = orm(conn, { schema } as any);
    await client.persons.from("person:B").traverse`->bought->product<-bought<-person`;
    console.log("TRAV:", calls[0]?.sql);
    expect(calls[0]?.sql).toContain("->bought->product");
  });
});