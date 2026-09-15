import { defineTable, s, surql } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Field PERMISSIONS",
  note: "Field-level guards: select/create/update (no delete at field level, matching SurrealQL).",
  ddl: `DEFINE TABLE fp TYPE NORMAL SCHEMAFULL;
DEFINE FIELD secret ON TABLE fp TYPE string PERMISSIONS FOR select WHERE $auth.admin = true FOR update WHERE false;`,
  def: defineTable("fp", {
    id: s.string(),
    secret: s.string().$permissions({
      select: surql`$auth.admin = true`,
      update: surql`false`,
    }),
  }),
});
