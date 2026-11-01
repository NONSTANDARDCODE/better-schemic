import { s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "CHANGEFEED",
  note: "Retain a change feed for the table; INCLUDE ORIGINAL via the option.",
  ddl: `DEFINE TABLE audited TYPE NORMAL SCHEMAFULL CHANGEFEED 7d INCLUDE ORIGINAL;`,
  def: table("audited", { id: s.string() }).changefeed("7d", {
    includeOriginal: true,
  }),
});
