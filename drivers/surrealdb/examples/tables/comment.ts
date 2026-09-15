import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "COMMENT",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL COMMENT "billing accounts";`,
  def: defineTable("account", { id: s.string() }).comment("billing accounts"),
});
