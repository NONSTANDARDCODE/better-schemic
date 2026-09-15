import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Record links — record<table>, multi-table, array<record<…>>",
  ddl: `DEFINE TABLE links TYPE NORMAL SCHEMAFULL;
DEFINE FIELD author ON TABLE links TYPE record<user>;
DEFINE FIELD owner ON TABLE links TYPE record<user | org>;
DEFINE FIELD tags ON TABLE links TYPE array<record<tag>>;`,
  def: defineTable("links", {
    id: s.string(),
    author: s.recordId("user"),
    owner: s.recordId(["user", "org"]),
    tags: s.array(s.recordId("tag")),
  }),
});
