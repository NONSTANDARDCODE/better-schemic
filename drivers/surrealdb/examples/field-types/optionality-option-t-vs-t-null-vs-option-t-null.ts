import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Optionality — option<T> vs T | null vs option<T | null>",
  note: "Kept distinct (absent vs present-null vs both), unlike SQL drivers that collapse them.",
  ddl: `DEFINE TABLE opt TYPE NORMAL SCHEMAFULL;
DEFINE FIELD maybe ON TABLE opt TYPE option<string>;
DEFINE FIELD nullable ON TABLE opt TYPE string | null;
DEFINE FIELD both ON TABLE opt TYPE option<string | null>;`,
  def: defineTable("opt", {
    id: s.string(),
    maybe: s.string().optional(),
    nullable: s.string().nullable(),
    both: s.string().nullish(),
  }),
});
