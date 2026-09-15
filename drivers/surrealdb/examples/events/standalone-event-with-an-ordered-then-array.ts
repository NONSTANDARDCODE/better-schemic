import { defineEvent, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Standalone event with an ordered THEN array",
  note: "defineEvent declares an event apart from its table; pull regenerates it inline.",
  ddl: `DEFINE EVENT onCreate ON TABLE account WHEN $event = "CREATE" THEN (CREATE log SET account = $after.id), (UPDATE stats SET count += 1);`,
  def: defineEvent("account", "onCreate", {
    when: surql`$event = "CREATE"`,
    // biome-ignore lint/suspicious/noThenProperty: event DSL "then" clause, not a thenable.
    then: [
      surql`CREATE log SET account = $after.id`,
      surql`UPDATE stats SET count += 1`,
    ],
  }),
});
