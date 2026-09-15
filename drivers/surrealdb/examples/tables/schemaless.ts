import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "SCHEMALESS",
  note: "Opt out with .schemaless() — records may carry undeclared fields.",
  ddl: `DEFINE TABLE blob TYPE NORMAL SCHEMALESS;`,
  def: defineTable("blob", { id: s.string() }).schemaless(),
});
