/**
 * `better-schemic/driver` — the engine surface: the SurrealDB `Driver` implementation, the
 * SurrealQL DDL emitters, and the `registerDriver` SIDE-EFFECT (registers `surrealDriver` with the
 * engine registry on import, so the CLI's `getDriver("surrealdb")` resolves). CLI/engine-only —
 * kept OUT of the side-effect-free authoring index (`better-schemic`) so `s.*` never drags the
 * emit/diff engine into an app bundle. The CLI imports this subpath once to register the driver.
 */

// Side-effect: register `surrealDriver` with the core registry on import. Kept in the BARREL (not
// `driver/surreal.ts`) so importing the driver runtime for `connect` never registers the driver —
// the ORM's `clientFromConfig` imports the runtime, not this CLI/engine entry.
import { type Driver, registerDriver } from "../core";
import { surrealDriver } from "./driver/surreal";

registerDriver(surrealDriver as Driver<unknown>);

/** The registry name of the built-in driver. */
export const DRIVER_NAME = "surrealdb";

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
