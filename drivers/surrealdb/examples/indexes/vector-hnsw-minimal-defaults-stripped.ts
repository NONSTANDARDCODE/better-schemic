import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Vector HNSW — minimal (defaults stripped)",
  note: "Only DIMENSION authored; SurrealDB materializes DIST/TYPE/EFC/M/M0/LM — all stripped so it round-trips.",
  ddl: `DEFINE TABLE vh TYPE NORMAL SCHEMAFULL;
DEFINE FIELD emb ON TABLE vh TYPE array<float>;
DEFINE INDEX vec ON TABLE vh FIELDS emb HNSW DIMENSION 4;`,
  def: defineTable("vh", { id: s.string(), emb: s.array(s.float()) }).index(
    "vec",
    ["emb"],
    { hnsw: { dimension: 4 } },
  ),
});
