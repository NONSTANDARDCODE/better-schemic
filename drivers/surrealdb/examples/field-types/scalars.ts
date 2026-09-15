import { defineTable, s } from "@better-schemic/surrealdb";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "Scalars",
  note: "Plus aliases: s.int32/uint32/bigint, s.date (datetime).",
  ddl: `DEFINE TABLE scalars TYPE NORMAL SCHEMAFULL;
DEFINE FIELD str ON TABLE scalars TYPE string;
DEFINE FIELD i ON TABLE scalars TYPE int;
DEFINE FIELD f ON TABLE scalars TYPE float;
DEFINE FIELD dec ON TABLE scalars TYPE decimal;
DEFINE FIELD num ON TABLE scalars TYPE number;
DEFINE FIELD b ON TABLE scalars TYPE bool;
DEFINE FIELD when ON TABLE scalars TYPE datetime;
DEFINE FIELD uid ON TABLE scalars TYPE uuid;
DEFINE FIELD raw ON TABLE scalars TYPE bytes;
DEFINE FIELD dur ON TABLE scalars TYPE duration;
DEFINE FIELD doc ON TABLE scalars TYPE file;`,
  def: defineTable("scalars", {
    id: s.string(),
    str: s.string(),
    i: s.int(),
    f: s.float(),
    dec: s.decimal(),
    num: s.number(),
    b: s.boolean(),
    when: s.datetime(),
    uid: s.uuid(),
    raw: s.bytes(),
    dur: s.duration(),
    doc: s.file(),
  }),
});
