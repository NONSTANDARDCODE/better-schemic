import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Vector DISKANN (single field, inline via field.$diskann())",
  ddl: `DEFINE TABLE vd2 TYPE NORMAL SCHEMAFULL;
DEFINE FIELD emb ON TABLE vd2 TYPE array<float>;
DEFINE INDEX vd2_emb_idx ON TABLE vd2 FIELDS emb DISKANN DIMENSION 4;`,
  def: defineTable("vd2", {
    id: s.string(),
    emb: s.array(s.float()).$diskann({ dimension: 4 }),
  }),
});
