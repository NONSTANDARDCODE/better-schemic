import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Geometry — bare and the 7 kinds",
  ddl: `DEFINE TABLE geo TYPE NORMAL SCHEMAFULL;
DEFINE FIELD any ON TABLE geo TYPE geometry;
DEFINE FIELD pt ON TABLE geo TYPE geometry<point>;
DEFINE FIELD ln ON TABLE geo TYPE geometry<line>;
DEFINE FIELD poly ON TABLE geo TYPE geometry<polygon>;
DEFINE FIELD mpt ON TABLE geo TYPE geometry<multipoint>;
DEFINE FIELD mln ON TABLE geo TYPE geometry<multiline>;
DEFINE FIELD mpoly ON TABLE geo TYPE geometry<multipolygon>;
DEFINE FIELD coll ON TABLE geo TYPE geometry<collection>;`,
  def: defineTable("geo", {
    id: s.string(),
    any: s.geometry(),
    pt: s.geometry("point"),
    ln: s.geometry("line"),
    poly: s.geometry("polygon"),
    mpt: s.geometry("multipoint"),
    mln: s.geometry("multiline"),
    mpoly: s.geometry("multipolygon"),
    coll: s.geometry("collection"),
  }),
});
