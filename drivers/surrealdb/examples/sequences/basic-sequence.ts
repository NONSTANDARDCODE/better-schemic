import { defineSequence } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Sequence — a monotonic counter",
  note: "Read the next value with `sequence::nextval('invoice')`. SurrealDB's BATCH 1000 / START 0 defaults are stripped, so a bare `defineSequence` round-trips.",
  ddl: `DEFINE SEQUENCE invoice;`,
  def: defineSequence("invoice"),
});
