import { group } from "../_kit";
import e1 from "./any-null";
import e3 from "./containers-array-set-with-max-object-tuple";
import e6 from "./geometry-bare-and-the-7-kinds";
import e4 from "./literals-enums-scalar-unions";
import e2 from "./optionality-option-t-vs-t-null-vs-option-t-null";
import e7 from "./range-interval-values";
import e5 from "./record-links-record-table-multi-table-array-reco";
import e0 from "./scalars";

export const fieldTypes = group(
  "field-types",
  "Field types — scalars, any/null, optionality, containers, literals/unions, record links, geometry, range",
  [e0, e1, e2, e3, e4, e5, e6, e7],
);
