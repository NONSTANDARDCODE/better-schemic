import { table } from "better-schemic";
import { cover } from "../_kit";

export default cover(import.meta.url, {
  title: "Base — DEFINE TABLE <name>",
  note: "table defaults to TYPE NORMAL SCHEMAFULL; the bare form carries both.",
  ddl: `DEFINE TABLE thing TYPE NORMAL SCHEMAFULL;`,
  def: table("thing"),
});
