import { defineAnalyzer } from "better-schemic"

import { example } from "../_kit"

export default example(import.meta.url, {
  title: "Analyzer with tokenizers + filters",
  ddl: `DEFINE ANALYZER english TOKENIZERS BLANK, CLASS FILTERS LOWERCASE, SNOWBALL(ENGLISH);`,
  def: defineAnalyzer("english")
    .tokenizers("blank", "class")
    .filters((f) => [f.lowercase, f.snowball("english")]),
})
