import { relation } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "TYPE RELATION — unrestricted endpoints",
  note: "Endpoints are optional; a bare relation links any record to any record.",
  ddl: `DEFINE TABLE touches TYPE RELATION SCHEMAFULL;`,
  def: relation("touches", {}),
});
