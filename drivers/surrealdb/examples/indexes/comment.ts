import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "COMMENT",
  ddl: `DEFINE TABLE cm TYPE NORMAL SCHEMAFULL;
DEFINE FIELD email ON TABLE cm TYPE string;
DEFINE INDEX uq ON TABLE cm FIELDS email UNIQUE COMMENT "email is unique";`,
  def: defineTable("cm", { id: s.string(), email: s.string() }).index(
    "uq",
    ["email"],
    { unique: true, comment: "email is unique" },
  ),
});
