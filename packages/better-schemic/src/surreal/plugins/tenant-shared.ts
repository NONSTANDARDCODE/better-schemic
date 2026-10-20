/**
 * Shared helpers of the `plugins/tenant` preset + runtime: the identifier guard that keeps tenant
 * column / event / index names canonical (and rename-safe) on both halves.
 */
import { BetterSchemicError } from "../orm/errors";

/** Letters/digits/underscore, not starting with a digit. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is `name` a plain column identifier? */
export function isIdent(name: unknown): name is string {
  return typeof name === "string" && IDENT.test(name);
}

/** Validate a column/event-name identifier — keeps names canonical and REFACTOR-visible. */
export function assertIdent(
  name: unknown,
  table: string,
  what: string,
): asserts name is string {
  if (!isIdent(name)) throw identError(name, table, what);
}

/** The teaching error for a bad identifier. */
export function identError(
  name: unknown,
  table: string,
  what: string,
): BetterSchemicError {
  return new BetterSchemicError(
    "SchemaInvalid",
    `plugins/tenant: ${what} ${JSON.stringify(name)} of "${table}" must be a plain identifier (letters/digits/underscore, not starting with a digit).`,
    { table, field: typeof name === "string" ? name : undefined },
  );
}
