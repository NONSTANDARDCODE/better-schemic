/**
 * The `upsertDelta` runtime — compares the DECODED before/after rows (never wire strings) and
 * assembles the field-level delta. Both sides come from the SAME statement's
 * `RETURN VALUE { before: $before, after: $after }`, so the comparison is one atomic snapshot
 * (no read-then-write race).
 *
 * `equalAppValue` is deliberately stricter than a structural deep-equal: it knows the SurrealDB
 * codec values (`RecordId`/`Decimal`/`Duration`/… expose `.equals()`), `Date` timestamps and
 * `Uint8Array` bytes, so "changed" means an APP-value change. (`cli/struct.ts#deepEqual` is NOT
 * reusable here: it treats every two key-less objects — every `Date` — as equal.)
 */
import { isPlainObject } from "./compiler/shared";
import type { FieldDelta } from "./types/write";

/** A computed field delta plus the changed key list (stable order). */
export interface ComputedDelta {
  /** `null` when nothing changed (a diff against the same values is noise). */
  readonly delta: FieldDelta<Record<string, unknown>> | null;
  /** The changed field names — the same keys as `delta.old`/`delta.new`, in order. */
  readonly changed: string[];
}

/**
 * Diff two decoded rows: the union of own keys (`after`'s order first, then `before`-only keys),
 * keeping only fields whose decoded values differ. A field REMOVED by `content`/`replace` is
 * present in both parts — `delta.new[key]` is `undefined` — and in `changed`.
 */
export function computeFieldDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ComputedDelta {
  const keys = Object.keys(after);
  for (const key of Object.keys(before))
    if (!Object.hasOwn(after, key)) keys.push(key);
  const oldPart: Record<string, unknown> = {};
  const newPart: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const key of keys) {
    if (equalAppValue(before[key], after[key])) continue;
    oldPart[key] = before[key];
    newPart[key] = after[key];
    changed.push(key);
  }
  if (changed.length === 0) return { delta: null, changed };
  return { delta: { old: oldPart, new: newPart }, changed };
}

/**
 * Are two decoded app values equal? `Object.is` first (NaN, `undefined`), then `Date` timestamps,
 * codec values exposing `.equals()` (`RecordId`, `Decimal`, `Duration`, `Uuid`, `Geometry`, …),
 * `Uint8Array` bytes, arrays element-wise and plain objects recursively. Anything else is unequal.
 */
export function equalAppValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date)
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  if (hasEquals(a) && hasEquals(b)) return a.equals(b) === true;
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return bytesEqual(a, b);
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((value, i) => equalAppValue(value, b[i]))
    );
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.hasOwn(b, key) && equalAppValue(a[key], b[key]),
    );
  }
  return false;
}

/** A value exposing the SurrealDB `Value#equals` protocol. */
function hasEquals(
  value: unknown,
): value is { equals(other: unknown): boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { equals?: unknown }).equals === "function"
  );
}

/** Byte-wise `Uint8Array` equality (the `bytes` codec decodes to it). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
