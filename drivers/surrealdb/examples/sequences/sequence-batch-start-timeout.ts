import { defineSequence } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Sequence — BATCH / START / TIMEOUT",
  ddl: `DEFINE SEQUENCE ticket BATCH 50 START 1000 TIMEOUT 5s;`,
  def: defineSequence("ticket").batch(50).start(1000).timeout("5s"),
});
