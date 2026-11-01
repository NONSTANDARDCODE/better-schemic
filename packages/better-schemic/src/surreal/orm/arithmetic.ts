/**
 * Write-payload adjustments — the markers a write `data` accepts on a field it must CHANGE in
 * place, lowered by the compiler to a server-side read-modify-write in ONE round-trip.
 *
 * Two families, one parser:
 *
 * - **numeric** — `{ increment: n }` / `{ decrement: n }` → `SET f += $p` / `SET f -= $p`
 *   (live-probed on 3.2.x: compound assignment is one server-side read-modify-write, so a
 *   concurrent writer can't slip between the read and the write of a `f = f + $p` pair);
 * - **array** — `{ append: v }` / `{ remove: v }` / `{ union: arr }` / `{ at: … }` →
 *   `SET f += $p` / `SET f -= $p` / `SET f = array::union(f, $p)` / `SET f[n] = $p`
 *   (each form live-probed: `+=` APPENDS without dedup — `["a"] += ["a"]` is `["a", "a"]` — so the
 *   union marker is the only deduping one; `-=` removes EVERY occurrence; and the server maintains
 *   the field's UNIQUE index on a full-array swap, which is what makes `remove` correct).
 *
 * This module is runtime-neutral on purpose: the compiler uses {@link adjustmentOf} to detect and
 * validate markers, and the official `zod` plugin uses {@link stripAdjustments} to validate the
 * payload WITHOUT tripping on the wrappers (the operand substitutes the marker).
 *
 * Markers are reserved shapes: a plain object with exactly ONE marker key (and only the modifier
 * keys besides it) is an adjustment — an object literal with that exact shape can't be written as
 * a payload value directly (wrap it in a `surql` fragment when a record genuinely stores that
 * object). The MODIFIERS (`when`/`else`/`coalesce`) ride the same wrapper; this module only
 * recognises them — the compiler validates and lowers them, because the guard/seed is server-side.
 */
import { isLowerableValue } from "./compiler/shared";

/** The adjustment marker keys (all reserved in a write payload). */
const ARITHMETIC_KINDS = new Set([
  "increment",
  "decrement",
  "append",
  "remove",
  "union",
  "at",
]);

/** Modifier keys that may sit beside the ONE marker key (validated by the compiler). */
const MODIFIER_KEYS = new Set(["when", "else", "coalesce"]);

/** Markers that carry a number/bigint/Decimal (or an expression) — not an array value. */
const NUMERIC_KINDS = new Set(["increment", "decrement"]);

/** One parsed adjustment marker: the operator and the operand to bind. */
export interface Adjustment {
  /** `+` (increment/append/union) or `-` (decrement/remove). */
  readonly op: "+" | "-";
  /** The marker key (`increment` | `decrement` | `append` | `remove` | `union` | `at`). */
  readonly kind: string;
  /** The family of target field the marker may touch. */
  readonly family: "number" | "array";
  /** The operand (validated by the compiler; a number/bigint/Decimal, an array value, or an expression). */
  readonly value: unknown;
  /** RAW `when` guard — the compiler validates it as a `Surql` (and rejects it on `at`). */
  readonly when?: unknown;
  /** RAW `else` branch — the compiler validates `"keep"`/`"throw"`/a renderable value. */
  readonly else?: unknown;
  /** RAW `coalesce` seed — the compiler validates it (only `union`/`append` accept it). */
  readonly coalesce?: unknown;
}

/** Is this value a plain object with exactly ONE adjustment-marker key (plus modifiers)? */
export function adjustmentOf(value: unknown): Adjustment | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return undefined;
  let kind: string | undefined;
  for (const key of Object.keys(value as object)) {
    if (ARITHMETIC_KINDS.has(key)) {
      // Two markers in one wrapper is NOT a marker (it stays a literal value, as before).
      if (kind !== undefined) return undefined;
      kind = key;
    } else if (!MODIFIER_KEYS.has(key)) return undefined;
  }
  if (kind === undefined) return undefined;
  const marker = value as Record<string, unknown>;
  const operand = marker[kind];
  if (operand === undefined) return undefined;
  const numeric = NUMERIC_KINDS.has(kind);
  return {
    op: kind === "decrement" || kind === "remove" ? "-" : "+",
    kind,
    family: numeric ? "number" : "array",
    value: operand,
    ...(marker.when !== undefined ? { when: marker.when } : {}),
    ...(marker.else !== undefined ? { else: marker.else } : {}),
    ...(marker.coalesce !== undefined ? { coalesce: marker.coalesce } : {}),
  };
}

/**
 * Is this operand a plain value (schema-checkable) rather than a server-side expression? A
 * fragment/`$ref`/`$range` computes its value in the database, so the validator can only drop the
 * marker and skip the field.
 */
export function literalOperand(value: unknown): boolean {
  return value !== undefined && !isLowerableValue(value);
}

/**
 * A copy of a write payload with every TOP-LEVEL adjustment replaced by its operand (or dropped
 * when the operand is an expression the validator can't check). Arrays of payloads are mapped.
 * Used by the `zod` plugin so app-level schemas validate the literal operand, not the wrapper.
 *
 * The MODIFIERS are deliberately ignored in the substitution: the plugin validates only the operand
 * (the value the app is putting into the field), while `when`/`else`/`coalesce` are evaluated by
 * the server and have no literal counterpart to check.
 */
export function stripAdjustments(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => stripAdjustments(item));
  if (data === null || typeof data !== "object") return data;
  const adjustment = adjustmentOf(data);
  if (adjustment) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const marker = adjustmentOf(value);
    if (marker) {
      if (literalOperand(marker.value)) out[key] = marker.value;
      continue; // an expression operand can't be schema-validated
    }
    out[key] = value;
  }
  return out;
}
