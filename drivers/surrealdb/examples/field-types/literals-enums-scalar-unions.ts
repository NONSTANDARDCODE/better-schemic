import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Literals, enums, scalar unions",
  ddl: `DEFINE TABLE choice TYPE NORMAL SCHEMAFULL;
DEFINE FIELD kind ON TABLE choice TYPE "a";
DEFINE FIELD status ON TABLE choice TYPE "draft" | "live" | "archived";
DEFINE FIELD idOrName ON TABLE choice TYPE int | string;`,
  def: defineTable("choice", {
    id: s.string(),
    kind: s.literal("a"),
    status: s.enum(["draft", "live", "archived"]),
    idOrName: s.union([s.int(), s.string()]),
  }),
});
