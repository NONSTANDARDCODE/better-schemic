import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "String-format builders (reverse to the builder on pull)",
  note: "Each bakes an ASSERT; pull recovers the builder (s.email()) not the raw string ASSERT.",
  ddl: `DEFINE TABLE fmt TYPE NORMAL SCHEMAFULL;
DEFINE FIELD email ON TABLE fmt TYPE string ASSERT string::is_email($value);
DEFINE FIELD site ON TABLE fmt TYPE string ASSERT string::is_url($value);
DEFINE FIELD ip ON TABLE fmt TYPE string ASSERT string::is_ipv4($value);
DEFINE FIELD id2 ON TABLE fmt TYPE string ASSERT string::is_ulid($value);`,
  def: defineTable("fmt", {
    id: s.string(),
    email: s.email(),
    site: s.url(),
    ip: s.ipv4(),
    id2: s.ulid(),
  }),
});
