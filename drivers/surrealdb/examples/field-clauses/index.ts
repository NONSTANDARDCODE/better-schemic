import { group } from "../_kit";
import e2 from "./assert-raw-and-baked-constraints";
import e0 from "./default-and-default-always";
import e6 from "./field-permissions";
import e5 from "./flexible-object";
import e4 from "./readonly-and-field-comment";
import e7 from "./reference-record-link-with-on-delete";
import e3 from "./string-format-builders-reverse-to-the-builder-on";
import e1 from "./value-and-computed";
import e8 from "./value-computes";

export const fieldClauses = group(
  "field-clauses",
  "Field clauses — default/value/computed/assert/$-constraints/string-formats/readonly/comment/flexible/permissions/reference",
  [e0, e1, e2, e3, e4, e5, e6, e7, e8],
);
