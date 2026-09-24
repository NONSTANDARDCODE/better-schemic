/**
 * The @better-schemic/surrealdb REFERENCE example cookbook — a folder of real, tsc-checked example files.
 * Each example is a `.ts` module under its group folder; `emit(defs) === ddl` is asserted by
 * test/examples/reference.test.ts. See packages/core/docs/EXAMPLE-COOKBOOK-CONVENTION.md.
 */
import type { ExampleGroup } from "./_kit";
import { access } from "./access";
import { analyzers } from "./analyzers";
import { escapeHatch } from "./escape-hatch";
import { events } from "./events";
import { fieldClauses } from "./field-clauses";
import { fieldTypes } from "./field-types";
import { functions } from "./functions";
import { indexes } from "./indexes";
import { sequences } from "./sequences";
import { tables } from "./tables";

export type { Definable, Example, ExampleGroup } from "./_kit";
export { emit, example, group } from "./_kit";

/** Every example group, in reading order. The reference test + manifest generator iterate this. */
export const allGroups: ExampleGroup[] = [
  tables,
  fieldTypes,
  fieldClauses,
  indexes,
  events,
  functions,
  sequences,
  access,
  analyzers,
  escapeHatch,
];
