import { s, surql, table } from "better-schemic";
import { example } from "../_kit";

export default example(import.meta.url, {
  title: "VALUE and COMPUTED",
  note: "VALUE computes/coerces on write; COMPUTED is a derived (virtual) value.",
  ddl: `DEFINE TABLE c TYPE NORMAL SCHEMAFULL;
DEFINE FIELD email ON TABLE c TYPE string VALUE string::lowercase($value);
DEFINE FIELD full ON TABLE c TYPE string COMPUTED name.first + ' ' + name.last;`,
  def: table("c", {
    id: s.string(),
    email: s.string().$value(surql`string::lowercase($value)`, {
      optional: false,
    }),
    full: s.string().$computed(surql`name.first + ' ' + name.last`),
  }),
});
