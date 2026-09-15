import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

/** A domain type with no wire representation of its own — the codec below maps it to/from a string. */
class Money {
  constructor(readonly cents: number) {}
  toString() {
    return (this.cents / 100).toFixed(2);
  }
}

export default example(import.meta.url, {
  title: ".$surreal(wire, codec) — store an instanceof type as a string",
  note: "App type = Money, wire/DDL type = string; the codec maps both ways. Clears the no-DDL brand.",
  ddl: `DEFINE TABLE wallet TYPE NORMAL SCHEMAFULL;
DEFINE FIELD price ON TABLE wallet TYPE string;`,
  def: defineTable("wallet", {
    id: s.string(),
    price: s.instanceof(Money).$surreal(s.string(), {
      encode: (m) => m.toString(),
      decode: (v) => new Money(Math.round(Number(v) * 100)),
    }),
  }),
});
