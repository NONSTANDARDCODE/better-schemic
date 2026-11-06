import { describe, expect, test } from "bun:test";
import { table, s } from "../../../src/surreal/pure";
import { RecordId } from "surrealdb";
import { orm } from "../../../src/surreal/orm/client";
import { buildSchemaIndex } from "../../../src/surreal/orm/schema";
import { fakeConn, ok } from "../orm-fixtures";

const Person = table("person", { name: s.string() });
const Product = table("product", { name: s.string(), price: s.number() });
const Bought = (require("../../../src/surreal/pure").relation as any)("bought", { createdAt: s.datetime() })
  .from(Person).to(Product);

const schema = { persons: Person, products: Product, bought: Bought };

describe("orm graph", () => {
  test("multi-hop object select + distinct", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([{ id: new RecordId("product", "1"), name: "P", price: 10 }])]);
    const client: any = orm(conn, { schema } as any);
    const res = await client.persons.from("person:B").graph((g: any) =>
      g.out(Bought).in(Bought).out(Bought).select({ id: true, name: true, price: true }).distinct()
    );
    expect(calls[0]?.sql).toBe(
      "SELECT DISTINCT VALUE ->bought->product<-bought<-person->bought->product.{id, name, price} FROM ONLY $p0;",
    );
    // wait: direction chain order? .out then .in then .out => bought->product <-bought<-person ->bought->product
    // Actually .out(Bought) from person -> product; .in(Bought) from product <- person; .out(Bought) -> product
  });

  test("powerful variant", async () => {
    const { conn, calls } = fakeConn((sql) => [ok([{ id: new RecordId("product", "1"), name: "P", price: 10 }])]);
    const client: any = orm(conn, { schema } as any);
    const lastMonth = new Date("2025-01-01");
    await client.persons.from("person:B").graph((g: any) =>
      g
        .out(Bought, { where: { createdAt: { gte: lastMonth } } })
        .in(Bought)
        .out(Bought)
        .where((product: any) => product.price.lt(500))
        .select((p: any) => ({ id: p.id, name: p.name, price: p.price }))
        .distinct()
    );
    expect(calls[0]?.sql).toContain("->(bought WHERE createdAt >= $p0)->product");
    expect(calls[0]?.sql).toContain("DISTINCT");
    expect(calls[0]?.sql).toContain("(product WHERE price < $b1)");
  });
});