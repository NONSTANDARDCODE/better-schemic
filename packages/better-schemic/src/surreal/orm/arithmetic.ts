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
 * Markers are reserved shapes: a plain object with exactly ONE of these keys is an adjustment — an
 * object literal with that exact shape can't be written as a payload value directly (wrap it in a
 * `surql` fragment when a record genuinely stores that object).
 */
import { Decimal } from "surrealdb"

import { isLowerableValue } from "./compiler/shared"

/** The adjustment marker keys (all reserved in a write payload). */
const ARITHMETIC_KINDS = new Set(["increment", "decrement", "append", "remove", "union", "at"]),
  /** Markers that carry a number/bigint/Decimal (or an expression) — not an array value. */
  NUMERIC_KINDS = new Set(["increment", "decrement"])

/** One parsed adjustment marker: the operator and the operand to bind. */
export interface Adjustment {
  /** `+` (increment/append/union) or `-` (decrement/remove). */
  readonly op: "+" | "-"
  /** The marker key (`increment` | `decrement` | `append` | `remove` | `union` | `at`). */
  readonly kind: string
  /** The family of target field the marker may touch. */
  readonly family: "number" | "array"
  /** The operand (validated by the compiler; a number/bigint/Decimal, an array value, or an expression). */
  readonly value: unknown
}

/** Is this value a plain object with exactly one adjustment-marker key? */
export function adjustmentOf(value: unknown): Adjustment | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined

  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1) return undefined
  const kind = keys[0]
  if (!ARITHMETIC_KINDS.has(kind)) return undefined
  const operand = (value as Record<string, unknown>)[kind]
  if (operand === undefined) return undefined
  const numeric = NUMERIC_KINDS.has(kind)
  return {
    op: kind === "decrement" || kind === "remove" ? "-" : "+",
    kind,
    family: numeric ? "number" : "array",
    value: operand,
  }
}

/**
 * Is this operand a plain value (schema-checkable) rather than a server-side expression? A
 * fragment/`$ref`/`$range` computes its value in the database, so the validator can only drop the
 * marker and skip the field.
 */
export function literalOperand(value: unknown): boolean {
  return value !== undefined && !isLowerableValue(value)
}

/**
 * A copy of a write payload with every TOP-LEVEL adjustment replaced by its operand (or dropped
 * when the operand is an expression the validator can't check). Arrays of payloads are mapped.
 * Used by the `zod` plugin so app-level schemas validate the literal operand, not the wrapper.
 */
export function stripAdjustments(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => stripAdjustments(item))
  if (data === null || typeof data !== "object") return data
  const adjustment = adjustmentOf(data)
  if (adjustment) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const marker = adjustmentOf(value)
    if (marker) {
      if (literalOperand(marker.value)) out[key] = marker.value
      continue // An expression operand can't be schema-validated
    }
    out[key] = value
  }
  return out
}
