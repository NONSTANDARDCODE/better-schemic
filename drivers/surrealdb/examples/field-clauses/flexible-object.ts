import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "FLEXIBLE object",
  note: ".flexible() (alias .loose()) lets a typed object also carry undeclared keys.",
  ddl: `DEFINE TABLE fx TYPE NORMAL SCHEMAFULL;
DEFINE FIELD meta ON TABLE fx TYPE object FLEXIBLE;
DEFINE FIELD meta.k ON TABLE fx TYPE string;`,
  def: defineTable("fx", {
    id: s.string(),
    meta: s.object({ k: s.string() }).flexible(),
  }),
});
