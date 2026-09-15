import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Inline event with WHEN + THEN",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL;
DEFINE FIELD balance ON TABLE account TYPE float;
DEFINE EVENT overdraft ON TABLE account WHEN $after.balance < 0 THEN CREATE alert SET account = $after.id, kind = 'overdraft';`,
  def: defineTable("account", { id: s.string(), balance: s.float() }).event(
    "overdraft",
    {
      when: surql`$after.balance < 0`,
      // biome-ignore lint/suspicious/noThenProperty: event DSL "then" clause, not a thenable.
      then: surql`CREATE alert SET account = $after.id, kind = 'overdraft'`,
    },
  ),
});
