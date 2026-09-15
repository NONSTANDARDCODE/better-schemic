import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Containers — array / set (with max), object, tuple",
  ddl: `DEFINE TABLE containers TYPE NORMAL SCHEMAFULL;
DEFINE FIELD tags ON TABLE containers TYPE array<string>;
DEFINE FIELD top3 ON TABLE containers TYPE array<string, 3>;
DEFINE FIELD uniq ON TABLE containers TYPE set<int>;
DEFINE FIELD coords ON TABLE containers TYPE [float, float];
DEFINE FIELD meta ON TABLE containers TYPE object;
DEFINE FIELD meta.k ON TABLE containers TYPE string;
DEFINE FIELD meta.n ON TABLE containers TYPE int;`,
  def: defineTable("containers", {
    id: s.string(),
    tags: s.array(s.string()),
    top3: s.array(s.string(), { max: 3 }),
    uniq: s.set(s.int()),
    coords: s.tuple([s.float(), s.float()]),
    meta: s.object({ k: s.string(), n: s.int() }),
  }),
});
