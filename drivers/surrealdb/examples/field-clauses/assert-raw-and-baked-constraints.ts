import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "ASSERT — raw and baked $-constraints",
  note: "$min/$max/$length/$gt/... bake into ASSERT; $assert(surql`…`) is the raw escape.",
  ddl: `DEFINE TABLE a TYPE NORMAL SCHEMAFULL;
DEFINE FIELD age ON TABLE a TYPE int ASSERT $value >= 0 AND $value <= 120;
DEFINE FIELD name ON TABLE a TYPE string ASSERT string::len($value) == 64;
DEFINE FIELD score ON TABLE a TYPE float ASSERT $value >= 0 AND $value <= 1;
DEFINE FIELD slug ON TABLE a TYPE string ASSERT $value = /^[a-z-]+$/;`,
  def: defineTable("a", {
    id: s.string(),
    age: s.int().$min(0).$max(120),
    name: s.string().$length(64),
    score: s.float().$gte(0).$lte(1),
    slug: s.string().$assert(surql`$value = /^[a-z-]+$/`),
  }),
});
