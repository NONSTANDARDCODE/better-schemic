import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "COUNT (materialized row-count, no FIELDS)",
  ddl: `DEFINE TABLE ct TYPE NORMAL SCHEMAFULL;
DEFINE INDEX rows ON TABLE ct COUNT;`,
  def: defineTable("ct", { id: s.string() }).index("rows", [], { count: true }),
});
