import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "DEFAULT and DEFAULT ALWAYS",
  note: "Literals stay bare; wrap an expression in surql`…`. ALWAYS re-applies on every update.",
  ddl: `DEFINE TABLE d TYPE NORMAL SCHEMAFULL;
DEFINE FIELD role ON TABLE d TYPE string DEFAULT "member";
DEFINE FIELD seen ON TABLE d TYPE int DEFAULT 0;
DEFINE FIELD touched ON TABLE d TYPE datetime DEFAULT ALWAYS time::now();`,
  def: defineTable("d", {
    id: s.string(),
    role: s.string().$default("member"),
    seen: s.int().$default(0),
    touched: s.datetime().$defaultAlways(surql`time::now()`),
  }),
});
