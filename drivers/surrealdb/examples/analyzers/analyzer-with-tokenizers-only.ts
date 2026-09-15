import { defineAnalyzer } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Analyzer with tokenizers only",
  ddl: `DEFINE ANALYZER simple TOKENIZERS BLANK;`,
  def: defineAnalyzer("simple").tokenizers("blank"),
});
