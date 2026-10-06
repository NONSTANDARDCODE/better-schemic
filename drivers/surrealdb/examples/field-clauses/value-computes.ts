import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "VALUE computes — a parent mapping fills nested keys",
  note: "`computes` marks the nested keys the parent `$value` fills as create-optional PER ITEM (ORM/type metadata only — it emits no extra DDL).",
  ddl: `DEFINE TABLE order TYPE NORMAL SCHEMAFULL;
DEFINE FIELD products ON TABLE order TYPE array<object> VALUE $value.map(|$p| { RETURN { product: $p.product, quantity: $p.quantity, sellingPriceAtOrder: $p.product.sellingPrice, costPriceAtOrder: $p.product.costPrice } });
DEFINE FIELD products.*.product ON TABLE order TYPE string;
DEFINE FIELD products.*.quantity ON TABLE order TYPE int;
DEFINE FIELD products.*.sellingPriceAtOrder ON TABLE order TYPE number;
DEFINE FIELD products.*.costPriceAtOrder ON TABLE order TYPE number;`,
  def: defineTable("order", {
    id: s.string(),
    products: s
      .array(
        s.object({
          product: s.string(),
          quantity: s.int(),
          sellingPriceAtOrder: s.number(),
          costPriceAtOrder: s.number(),
        }),
      )
      .$value(
        surql`$value.map(|$p| { RETURN { product: $p.product, quantity: $p.quantity, sellingPriceAtOrder: $p.product.sellingPrice, costPriceAtOrder: $p.product.costPrice } })`,
        {
          optional: true,
          computes: ["sellingPriceAtOrder", "costPriceAtOrder"],
        },
      ),
  }),
});
