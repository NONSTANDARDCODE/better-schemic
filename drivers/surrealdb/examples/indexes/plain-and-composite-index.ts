import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Plain and composite index",
  ddl: `DEFINE TABLE p TYPE NORMAL SCHEMAFULL;
DEFINE FIELD a ON TABLE p TYPE string;
DEFINE FIELD b ON TABLE p TYPE string;
DEFINE INDEX ab ON TABLE p FIELDS a, b;`,
  def: defineTable("p", { id: s.string(), a: s.string(), b: s.string() }).index(
    "ab",
    ["a", "b"],
  ),
});
