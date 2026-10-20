/**
 * The function-name grammar, shared by the ORM runtime (`fn.call`), the driver engine
 * (`callable.invoke`) and the authoring surface — a function name is SPLICED into SurrealQL, never
 * bound, so every caller validates against the same rule.
 *
 * Neutral module: no ORM/engine imports, so the driver can validate without pulling the runtime.
 */

/** A function name: `name` or `ns::name` segments (letters/digits/_, starting with a letter/_). */
export const FN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Validate + normalize a function name: `x` -> `fn::x`; `mod::x`/`fn::x` stay as written. Returns
 * `undefined` when the name is invalid (callers throw their own contextual error).
 */
export function normalizeFnName(name: string): string | undefined {
  if (typeof name !== "string" || !FN_NAME.test(name)) return undefined;
  return name.includes("::") ? name : `fn::${name}`;
}
