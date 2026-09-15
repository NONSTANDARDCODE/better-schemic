import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "SCHEMAFULL (the default)",
  note: "defineTable is SCHEMAFULL by default — fields are constrained to the declared shape.",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL;
DEFINE FIELD name ON TABLE account TYPE string;`,
  def: defineTable("account", { id: s.string(), name: s.string() }),
});
