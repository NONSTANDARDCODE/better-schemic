import { defineAnalyzer, defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "FULLTEXT search index + DEFINE ANALYZER",
  note: "A FULLTEXT index deps on its analyzer (emitted first). Default BM25(1.2,0.75) is stripped.",
  ddl: `DEFINE ANALYZER english TOKENIZERS BLANK FILTERS LOWERCASE, SNOWBALL(ENGLISH);

DEFINE TABLE doc TYPE NORMAL SCHEMAFULL;
DEFINE FIELD content ON TABLE doc TYPE string;
DEFINE INDEX ft ON TABLE doc FIELDS content FULLTEXT ANALYZER english HIGHLIGHTS;`,
  def: [
    defineAnalyzer("english")
      .tokenizers("blank")
      .filters("lowercase", "snowball(english)"),
    defineTable("doc", { id: s.string(), content: s.string() }).index(
      "ft",
      ["content"],
      {
        fulltext: { analyzer: "english", highlights: true },
      },
    ),
  ],
});
