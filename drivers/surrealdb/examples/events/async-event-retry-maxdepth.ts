import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Async event with RETRY + MAXDEPTH",
  note: "`async: true` emits a bare `ASYNC`; `{ retry, maxDepth }` tune it (Retry 1 / MaxDepth 3 are SurrealDB's defaults and are stripped, so an omitted value round-trips).",
  ddl: `DEFINE TABLE job TYPE NORMAL SCHEMAFULL;
DEFINE FIELD status ON TABLE job TYPE string;
DEFINE EVENT recompute ON TABLE job ASYNC RETRY 3 MAXDEPTH 5 THEN UPDATE $after.id SET status = 'queued';`,
  def: defineTable("job", { id: s.string(), status: s.string() }).event(
    "recompute",
    {
      async: { retry: 3, maxDepth: 5 },
      // biome-ignore lint/suspicious/noThenProperty: event DSL "then" clause, not a thenable.
      then: surql`UPDATE $after.id SET status = 'queued'`,
    },
  ),
});
