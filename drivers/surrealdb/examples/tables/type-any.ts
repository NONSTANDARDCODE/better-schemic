import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE ANY",
  note: "Accept any record shape (.typeAny()).",
  ddl: `DEFINE TABLE misc TYPE ANY SCHEMAFULL;`,
  def: defineTable("misc", { id: s.string() }).typeAny(),
});
