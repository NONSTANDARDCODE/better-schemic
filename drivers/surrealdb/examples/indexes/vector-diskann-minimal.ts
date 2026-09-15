import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Vector DISKANN — minimal",
  ddl: `DEFINE TABLE vd TYPE NORMAL SCHEMAFULL;
DEFINE FIELD emb ON TABLE vd TYPE array<float>;
DEFINE INDEX vec ON TABLE vd FIELDS emb DISKANN DIMENSION 4;`,
  def: defineTable("vd", { id: s.string(), emb: s.array(s.float()) }).index(
    "vec",
    ["emb"],
    { diskann: { dimension: 4 } },
  ),
});
