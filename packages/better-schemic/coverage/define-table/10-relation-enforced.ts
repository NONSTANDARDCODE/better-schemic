import { relation, table, s } from "better-schemic";
import { cover } from "../_kit";

const Person = table("person", { id: s.string() });
const Product = table("product", { id: s.string() });

export default cover(import.meta.url, {
  title: "TYPE RELATION … ENFORCED — require both endpoints to exist",
  note: ".enforced() — RELATE fails unless both the in and out records exist.",
  ddl: `DEFINE TABLE likes TYPE RELATION FROM person TO product ENFORCED SCHEMAFULL;`,
  def: relation("likes").from(Person).to(Product).enforced(),
});
