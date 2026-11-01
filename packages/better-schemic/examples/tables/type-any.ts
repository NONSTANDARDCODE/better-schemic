import { s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE ANY",
  note: "Accept any record shape (.typeAny()).",
  ddl: `DEFINE TABLE misc TYPE ANY SCHEMAFULL;`,
  def: table("misc", { id: s.string() }).typeAny(),
});
