import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Vector HNSW (single field, inline via field.$hnsw())",
  ddl: `DEFINE TABLE vh3 TYPE NORMAL SCHEMAFULL;
DEFINE FIELD emb ON TABLE vh3 TYPE array<float>;
DEFINE INDEX vh3_emb_idx ON TABLE vh3 FIELDS emb HNSW DIMENSION 4 DIST COSINE;`,
  def: defineTable("vh3", {
    id: s.string(),
    emb: s.array(s.float()).$hnsw({ dimension: 4, dist: "cosine" }),
  }),
});
