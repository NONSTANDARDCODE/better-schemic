import { s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "COMMENT",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL COMMENT "billing accounts";`,
  def: table("account", { id: s.string() }).comment("billing accounts"),
});
