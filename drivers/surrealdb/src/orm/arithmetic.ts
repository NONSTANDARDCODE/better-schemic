/**
 * Write-payload adjustments — the `{ increment: n }` / `{ decrement: n }` markers a write `data`
 * accepts on numeric fields, lowered by the compiler to `SET f += $p` / `SET f -= $p` (live-probed
 * on 3.2.x: compound assignment is one server-side read-modify-write, so a concurrent writer can't
 * slip between the read and the write of a `f = f + $p` pair).
 *
 * This module is runtime-neutral on purpose: the compiler uses {@link adjustmentOf} to detect and
 * validate markers, and the official `zod` plugin uses {@link stripAdjustments} to validate the
 * payload WITHOUT tripping on the wrappers (the operand substitutes the marker).
 *
 * Markers are reserved shapes: a plain object with exactly ONE key (`increment` or `decrement`) is
 * an adjustment — an object literal with that exact shape can't be written as a payload value
 * directly (wrap it in a `surql` fragment when a record genuinely stores that object).
 */
import { Decimal } from "surrealdb";

/** One parsed adjustment marker: the operator and the operand to bind. */
export interface Adjustment {
  /** `+` (increment) or `-` (decrement). */
  readonly op: "+" | "-";
  /** The operand (validated by the compiler; a number/bigint/Decimal or an expression). */
  readonly value: unknown;
  /** The marker key (`increment` | `decrement`) for teaching messages. */
  readonly kind: "increment" | "decrement";
}

/** Is this value a plain object with exactly one `increment`/`decrement` key? */
export function adjustmentOf(value: unknown): Adjustment | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const keys = Object.keys(value as object);
  if (keys.length !== 1) return undefined;
  const kind = keys[0];
  if (kind !== "increment" && kind !== "decrement") return undefined;
  const operand = (value as Record<string, unknown>)[kind];
  if (operand === undefined) return undefined;
  return { op: kind === "increment" ? "+" : "-", value: operand, kind };
}

/**
 * A copy of a write payload with every TOP-LEVEL adjustment replaced by its operand (or dropped
 * when the operand is an expression the validator can't check). Arrays of payloads are mapped.
 * Used by the `zod` plugin so app-level schemas validate the numeric operand, not the wrapper.
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
      if (
        typeof marker.value === "number" ||
        typeof marker.value === "bigint" ||
        marker.value instanceof Decimal
      )
        out[key] = marker.value;
      continue; // an expression operand can't be schema-validated
    }
    out[key] = value;
  }
  return out;
}
