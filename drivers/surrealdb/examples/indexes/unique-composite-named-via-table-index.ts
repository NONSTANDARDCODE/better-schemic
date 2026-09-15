import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "UNIQUE (composite/named, via table.index)",
  ddl: `DEFINE TABLE u TYPE NORMAL SCHEMAFULL;
DEFINE FIELD email ON TABLE u TYPE string;
DEFINE INDEX uq ON TABLE u FIELDS email UNIQUE;`,
  def: defineTable("u", { id: s.string(), email: s.string() }).index(
    "uq",
    ["email"],
    { unique: true },
  ),
});
