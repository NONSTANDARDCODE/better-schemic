import { s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "SCHEMAFULL (the default)",
  note: "table is SCHEMAFULL by default — fields are constrained to the declared shape.",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL;
DEFINE FIELD name ON TABLE account TYPE string;`,
  def: table("account", { id: s.string(), name: s.string() }),
});
