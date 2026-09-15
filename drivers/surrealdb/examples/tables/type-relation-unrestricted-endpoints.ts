import { defineRelation } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE RELATION — unrestricted endpoints",
  note: "Endpoints are optional; a bare relation links any record to any record.",
  ddl: `DEFINE TABLE touches TYPE RELATION SCHEMAFULL;`,
  def: defineRelation("touches", {}),
});
