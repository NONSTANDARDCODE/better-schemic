import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Composite index via renameable field refs (callback form)",
  note: '`(t) => [t.a, t.b]` references fields as real symbols, so LSP rename + go-to-definition follow them (a `["a","b"]` string array can\'t). Emits identically to the array form.',
  ddl: `DEFINE TABLE pr TYPE NORMAL SCHEMAFULL;
DEFINE FIELD a ON TABLE pr TYPE string;
DEFINE FIELD b ON TABLE pr TYPE string;
DEFINE INDEX ab ON TABLE pr FIELDS a, b;`,
  def: defineTable("pr", {
    id: s.string(),
    a: s.string(),
    b: s.string(),
  }).index("ab", (t) => [t.a, t.b]),
});
