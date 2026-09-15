import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "DROP",
  note: "A DROP table discards writes (TYPE NORMAL DROP) — useful to retire a table's data.",
  ddl: `DEFINE TABLE legacy TYPE NORMAL DROP SCHEMAFULL;`,
  def: defineTable("legacy", { id: s.string() }).drop(true),
});
