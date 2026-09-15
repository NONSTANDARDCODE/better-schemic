import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "any / null",
  ddl: `DEFINE TABLE loose TYPE NORMAL SCHEMAFULL;
DEFINE FIELD anything ON TABLE loose TYPE any;
DEFINE FIELD nothing ON TABLE loose TYPE null;`,
  def: defineTable("loose", {
    id: s.string(),
    anything: s.any(),
    nothing: s.null(),
  }),
});
