import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "FULLTEXT with no analyzer (SurrealDB's built-in `like`)",
  note: "The analyzer is optional — `.$fulltext()` (or `{ fulltext: {} }`) emits a bare `DEFINE INDEX … FULLTEXT`, which SurrealDB accepts and backs with its built-in `like` analyzer. Pass a `defineAnalyzer` for real tokenizing/stemming.",
  ddl: `DEFINE TABLE doc3 TYPE NORMAL SCHEMAFULL;
DEFINE FIELD body ON TABLE doc3 TYPE string;
DEFINE INDEX doc3_body_idx ON TABLE doc3 FIELDS body FULLTEXT;`,
  def: defineTable("doc3", { id: s.string(), body: s.string().$fulltext() }),
});
