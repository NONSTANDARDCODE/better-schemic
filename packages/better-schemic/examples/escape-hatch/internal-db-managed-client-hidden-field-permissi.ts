import { s, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: ".$internal() — DB-managed, client-hidden field (PERMISSIONS NONE)",
  ddl: `DEFINE TABLE account TYPE NORMAL SCHEMAFULL;
DEFINE FIELD passhash ON TABLE account TYPE string PERMISSIONS NONE;`,
  def: table("account", {
    id: s.string(),
    passhash: s.string().$internal(),
  }),
});
