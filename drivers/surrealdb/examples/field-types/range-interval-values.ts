import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Range — interval values",
  note: "`s.range()` is SurrealDB's `range` value type (an interval like `1..=10`). Build values with the SDK's `new Range(new BoundIncluded(1), new BoundExcluded(10))`. SurrealDB's `range<T>` element syntax does not parse on 3.x, so the builder takes no argument.",
  ddl: `DEFINE TABLE window TYPE NORMAL SCHEMAFULL;
DEFINE FIELD span ON TABLE window TYPE range;`,
  def: defineTable("window", {
    id: s.string(),
    span: s.range(),
  }),
});
