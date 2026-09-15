import { defineRelation, defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE RELATION (edge table) with FROM / TO / ENFORCED",
  note: "defineRelation + .from()/.to() restrict endpoints; .enforced() requires both to exist on RELATE.",
  ddl: `DEFINE TABLE likes TYPE RELATION FROM user TO post ENFORCED SCHEMAFULL;
DEFINE FIELD since ON TABLE likes TYPE datetime;`,
  def: defineRelation("likes", { since: s.datetime() })
    .from(defineTable("user", { id: s.string() }))
    .to(defineTable("post", { id: s.string() }))
    .enforced(),
});
