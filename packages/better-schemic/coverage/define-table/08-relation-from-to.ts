import { relation, table, s } from "better-schemic";
import { cover } from "../_kit";

const Person = table("person", { id: s.string() });
const Product = table("product", { id: s.string() });

export default cover(import.meta.url, {
  title: "TYPE RELATION FROM/TO — restricted endpoints",
  note: ".from(A).to(B) restricts the edge's in/out tables. Each accepts a TableDef, a SurrealDB Table, a bare name string, or an array mixing them. IN/OUT are SurrealQL synonyms for FROM/TO; the emitter renders FROM/TO.",
  ddl: `DEFINE TABLE likes TYPE RELATION FROM person TO product SCHEMAFULL;`,
  def: relation("likes").from(Person).to(Product),
});
