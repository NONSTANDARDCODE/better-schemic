import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "table PERMISSIONS",
  note: "Per-operation row guards; an omitted op defaults to NONE.",
  ddl: `DEFINE TABLE doc TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select WHERE true FOR create WHERE $auth.id != NONE FOR update WHERE $auth.id = id.owner FOR delete WHERE $auth.admin = true;`,
  def: defineTable("doc", { id: s.string() }).permissions({
    select: surql`true`,
    create: surql`$auth.id != NONE`,
    update: surql`$auth.id = id.owner`,
    delete: surql`$auth.admin = true`,
  }),
});
