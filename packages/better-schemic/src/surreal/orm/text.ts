/**
 * Text coercion helpers for opaque values crossing the ORM boundary.
 *
 * `String(value)` on a plain object produces `Object.prototype.toString`'s `[object Object]`, while
 * a value with a custom `toString` (a `RecordId`, a `Duration`) renders as that custom text. The two
 * helpers keep those semantics explicit for the type-aware linter: one mirrors `String`, the other
 * prefers JSON before falling back to coercion.
 */

/** `String(value)` semantics without losing the type-aware lint check. */
export const stringCoerce = (value: unknown): string => {
  if (typeof value === "string") return value
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  )
    return String(value)
  return (value as { toString(): string }).toString()
}

/** `JSON.stringify` with its real (nullable) return type. */
export const stringifyJson = (value: unknown): string | undefined => JSON.stringify(value)

/** Prefer JSON, then fall back to the value's own text (never `[object Object]` for plain objects). */
export const stringifyOpaque = (value: unknown): string =>
  stringifyJson(value) ?? stringCoerce(value)
