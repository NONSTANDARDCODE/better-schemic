/**
 * Identifier escaping, hardened over the SDK's `escapeIdent`.
 *
 * The SDK escapes `⟩` as `\⟩`, but SurrealDB 3.2 REJECTS that escape ("Invalid escape sequence"),
 * and a name like `x\⟩ OR true OR ⟨y` survives the rewrite as `⟨x\\⟩ OR true OR ⟨y⟩` — the
 * identifier terminates early and the rest executes as SQL. Backtick quoting handles every tested
 * case (`⟩`, `\`, backtick, spaces, newlines), so names containing `⟩` or `\` are backtick-quoted
 * (with `\` and the backtick itself escaped). Everything else keeps the SDK's canonical output, so
 * emitted SQL is unchanged for normal/weird-but-safe names.
 *
 * Neutral module: no ORM/engine imports, usable from the compiler, runtime and CLI.
 */
import { escapeIdent } from "surrealdb";

/** Backtick-quote an identifier (escapes `\` and the backtick itself; both round-trip live). */
function backtickIdent(name: string): string {
  return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

/** Escape a possibly-untrusted identifier for SurrealQL (see the module docs). */
export function escapeIdentSafe(name: string): string {
  if (typeof name !== "string") return escapeIdent(String(name));
  return name.includes("\\") || name.includes("⟩")
    ? backtickIdent(name)
    : escapeIdent(name);
}
