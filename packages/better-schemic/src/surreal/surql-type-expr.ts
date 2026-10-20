// Lexical helpers for SurrealQL TYPE EXPRESSIONS — the one home for "split at top level, ignoring
// `<…>`". Shared by the emitter's union inference (`inferField`), the Struct-IR normalizer
// (`normalizeType`), `pull`'s type→`s.*` renderer, and the portable-type bridge (`parseSurqlType`),
// so all four agree on where a union/comma boundary is. Pure strings — no dialect model.

/** Split a type expression on its top-level `|` (ignoring `|` inside `<…>`). */
export function splitTopUnion(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of expr) {
    if (c === "<") depth++;
    else if (c === ">") depth--;
    if (c === "|" && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

/** Split `s` once on the first top-level `sep` (outside `<…>`), or null if absent. */
export function topLevelSplitOnce(
  s: string,
  sep: string,
): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === sep && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return null;
}
