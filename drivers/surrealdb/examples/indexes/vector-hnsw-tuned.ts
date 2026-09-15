import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Vector HNSW — tuned",
  ddl: `DEFINE TABLE vh2 TYPE NORMAL SCHEMAFULL;
DEFINE FIELD emb ON TABLE vh2 TYPE array<float>;
DEFINE INDEX vec ON TABLE vh2 FIELDS emb HNSW DIMENSION 8 DIST COSINE TYPE F64 EFC 200 M 16;`,
  def: defineTable("vh2", { id: s.string(), emb: s.array(s.float()) }).index(
    "vec",
    ["emb"],
    { hnsw: { dimension: 8, dist: "cosine", type: "f64", efc: 200, m: 16 } },
  ),
});
