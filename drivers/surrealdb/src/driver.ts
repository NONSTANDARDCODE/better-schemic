/**
 * `@better-schemic/surrealdb/driver` — the engine surface: the SurrealDB `Driver` implementation, the
 * SurrealQL DDL emitters, and the `registerDriver` SIDE-EFFECT (registers `surrealDriver` with the
 * `@better-schemic/core` registry on import, so the CLI's `getDriver("surrealdb")` resolves). CLI/engine-only
 * — kept OUT of the side-effect-free authoring index (`@better-schemic/surrealdb`) so `s.*` never drags the
 * emit/diff engine into an app bundle. The CLI loader imports this subpath to register the driver.
 */

// Side-effect: register `surrealDriver` with the core registry on import. Kept in the BARREL (not
// `driver/surreal.ts`) so importing the driver runtime for `connect` never registers the driver —
// the ORM's `clientFromConfig` imports the runtime, not this CLI/engine entry.
import { type Driver, registerDriver } from "@better-schemic/core";
import { surrealDriver } from "./driver/surreal";

registerDriver(surrealDriver as Driver<unknown>);

// Pretty-print SurrealQL for display/codegen (whitespace-only; normalize makes it drift-free).
export { formatSurql } from "./cli/format";
export type { DefineOptions, DefineStatement, FieldInfo } from "./ddl";
export {
  alterField,
  alterTable,
  assertExpr,
  braceBody,
  emitDefStatement,
  emitField,
  emitFieldStatements,
  emitStatements,
  emitTable,
  eventClause,
  fieldType,
  inferField,
  inline,
  overwriteStatement,
  removeStatement,
} from "./ddl";
export { surrealDriver } from "./driver/surreal";
