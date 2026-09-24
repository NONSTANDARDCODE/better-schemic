// Tier 2 — a real MC/DC proof for a core decision (`inCat`): `on && (!names || names.has(name))`.
// Every operand must independently flip the outcome; a redundant `on` or an inverted name-set fails
// a named test even at 100% branch coverage.
import { describeMcdc } from "@better-schemic/core/testing";
import { inCat } from "../../src/cli-kit/filter";

describeMcdc({
  label: "inCat",
  conditions: ["on", "restricted", "allowed"],
  evaluate: ({ on, restricted, allowed }) =>
    inCat(
      { on, ...(restricted ? { names: new Set([allowed ? "x" : "y"]) } : {}) },
      "x",
    ),
});
