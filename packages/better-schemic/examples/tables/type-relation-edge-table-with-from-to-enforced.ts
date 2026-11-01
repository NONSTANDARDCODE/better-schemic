import { relation, s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE RELATION (edge table) with FROM / TO / ENFORCED",
  note: "relation + .from()/.to() restrict endpoints; .enforced() requires both to exist on RELATE.",
  ddl: `DEFINE TABLE likes TYPE RELATION FROM user TO post ENFORCED SCHEMAFULL;
DEFINE FIELD since ON TABLE likes TYPE datetime;`,
  def: relation("likes", { since: s.datetime() })
    .from(table("user", { id: s.string() }))
    .to(table("post", { id: s.string() }))
    .enforced(),
});
