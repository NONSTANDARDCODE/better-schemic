import { group } from "../_kit";
import e0 from "./analyzer-with-tokenizers-filters";
import e1 from "./analyzer-with-tokenizers-only";

export const analyzers = group(
  "analyzers",
  "DEFINE ANALYZER — tokenizers + optional filters",
  [e0, e1],
);
