/**
 * Identifier escaping, hardened over the SDK's `escapeIdent`, plus the record-id value parsing the
 * authoring codec and the ORM compiler share.
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

/**
 * Reverse an id-part escape, returning the RAW id value text. Handles the three spellings the SDK /
 * the driver emit for a record-id value part:
 *
 *   - `⟨a\⟩b⟩` (SDK `escapeIdent`) -> `a⟩b`;
 *   - `` `a\`b` `` (the driver's hardened `escapeIdentSafe`) -> `` a`b ``;
 *   - `u"…"` (a `Uuid` value part) -> the bare uuid text.
 *
 * Anything else passes through unchanged. The ONE unescape shared by the string-id codec and the
 * ORM's record-id parser, so `new RecordId(table, raw)` never re-escapes an already-escaped part.
 */
export function unescapeIdPart(text: string): string {
  if (text.length >= 2 && text.startsWith("⟨") && text.endsWith("⟩"))
    return text.slice(1, -1).replaceAll("\\⟩", "⟩");
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`"))
    return text.slice(1, -1).replaceAll("\\`", "`").replaceAll("\\\\", "\\");
  if (text.length >= 3 && text.startsWith('u"') && text.endsWith('"'))
    return text.slice(2, -1);
  return text;
}

/** A record-id value split into its table and id parts (the id part still ESCAPED). */
export interface RecordIdParts {
  readonly table: string;
  readonly id: string;
}

/**
 * Non-throwing record-id split: `"user:aeon"` / `RecordId` -> `{ table, id }`; anything without a
 * table prefix (bare ids, non-strings) resolves `undefined`. The ONE place `table:id` is parsed —
 * both the authoring codec and the ORM compiler build on it (unescape the id part with
 * {@link unescapeIdPart} to get the RAW value).
 */
export function splitRecordId(value: unknown): RecordIdParts | undefined {
  const text = String(value ?? "");
  const colon = text.indexOf(":");
  if (colon === -1) return undefined;
  return { table: text.slice(0, colon), id: text.slice(colon + 1) };
}
