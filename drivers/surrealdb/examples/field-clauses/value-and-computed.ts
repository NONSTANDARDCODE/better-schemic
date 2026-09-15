import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "VALUE and COMPUTED",
  note: "VALUE computes/coerces on write; COMPUTED is a derived (virtual) value.",
  ddl: `DEFINE TABLE c TYPE NORMAL SCHEMAFULL;
DEFINE FIELD email ON TABLE c TYPE string VALUE string::lowercase($value);
DEFINE FIELD full ON TABLE c TYPE string COMPUTED name.first + ' ' + name.last;`,
  def: defineTable("c", {
    id: s.string(),
    email: s.string().$value(surql`string::lowercase($value)`),
    full: s.string().$computed(surql`name.first + ' ' + name.last`),
  }),
});
