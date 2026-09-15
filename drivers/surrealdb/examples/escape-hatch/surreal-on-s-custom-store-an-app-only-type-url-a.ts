import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: ".$surreal on s.custom — store an app-only type (URL) as a string",
  note: "URL has no native SurrealQL type, so it needs a wire type + codec. (A JS Set, by contrast, is native: use s.set() -> set<T>.)",
  ddl: `DEFINE TABLE site TYPE NORMAL SCHEMAFULL;
DEFINE FIELD homepage ON TABLE site TYPE string;`,
  def: defineTable("site", {
    id: s.string(),
    homepage: s.custom<URL>().$surreal(s.string(), {
      encode: (u) => u.href,
      decode: (v) => new URL(v),
    }),
  }),
});
