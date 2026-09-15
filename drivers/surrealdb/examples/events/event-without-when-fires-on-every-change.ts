import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Event without WHEN (fires on every change)",
  ddl: `DEFINE TABLE doc TYPE NORMAL SCHEMAFULL;
DEFINE EVENT touch ON TABLE doc THEN UPDATE audit SET at = time::now();`,
  def: defineTable("doc", { id: s.string() }).event("touch", {
    // biome-ignore lint/suspicious/noThenProperty: event DSL "then" clause, not a thenable.
    then: surql`UPDATE audit SET at = time::now()`,
  }),
});
