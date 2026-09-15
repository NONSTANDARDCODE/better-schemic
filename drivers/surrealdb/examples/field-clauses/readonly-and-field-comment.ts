import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "READONLY and field COMMENT",
  ddl: `DEFINE TABLE rc TYPE NORMAL SCHEMAFULL;
DEFINE FIELD createdAt ON TABLE rc TYPE datetime READONLY;
DEFINE FIELD note ON TABLE rc TYPE string COMMENT "free-form note";`,
  def: defineTable("rc", {
    id: s.string(),
    createdAt: s.datetime().$readonly(),
    note: s.string().$comment("free-form note"),
  }),
});
