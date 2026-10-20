/**
 * Write ADJUSTMENTS — `{ increment }` / `{ decrement }` on a number, `{ append }` / `{ remove }` /
 * `{ union }` / `{ at }` on an array or set.
 *
 * Two properties make this its own module rather than part of the `SET`-clause builder:
 * - the app-facing MARKERS and the SurrealQL each one lowers to are declared together in
 *   `../types/write.ts` (`AdjustmentLowering`), so a new marker cannot ship without its operator;
 * - every step is ONE server-side read-modify-write, which is what keeps a UNIQUE index over the
 *   whole array correct — the database swaps the key, the process never reads it first.
 */

import { Decimal, RecordId } from "surrealdb";
import { type Adjustment, adjustmentOf, literalOperand } from "../arithmetic";
import type { ColumnMeta, ModelMeta, TableMeta } from "../meta";
import type { AdjustmentLowering } from "../types/write";
import {
  type Binds,
  compileError,
  describeValue,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  renderPath,
  renderValue,
} from "./shared";
import { flattenAssignments } from "./write-shared";


/**
 * How one lowered STEP renders in the `SET` clause. `=` is the internal whole-value replacement
 * (`array::union` is built as a replacement, not a compound assignment).
 */
export type StepOp = "+=" | "-=" | "union" | "at" | "=";

/** One field adjustment to lower inside the `SET` clause. */
export interface ArithmeticStep {
  /** The top-level field (raw app name; `updateBody` escapes it). */
  readonly field: string;
  /** The operator (`+=`, `-=`, `union`, `at`, `=`). */
  readonly op: StepOp;
  /** The operand(s) to bind (`at` carries `[index, value]`). */
  readonly value: unknown;
}

const NO_STEPS: readonly ArithmeticStep[] = [];

/**
 * Split a write payload into its adjustment STEPS and the CLEAN payload the codec validates.
 * Adjustments are a TOP-LEVEL concern (each operand substitutes its field in the clean copy).
 * `allow: false` (create-shaped writes) rejects any marker with a teaching error; every
 * adjustment is validated against the schema (numeric field, known name, non-id) at THIS point,
 * so a typo fails before any query runs.
 */
export function extractArithmetic(
  meta: ModelMeta,
  data: unknown,
  operation: string,
  allow: boolean,
): { clean: unknown; steps: readonly ArithmeticStep[] } {
  if (!isPlainObject(data)) return { clean: data, steps: NO_STEPS };
  // Nothing was accumulated → the payload had no marker at all and passes through untouched. Decided
  // ONCE, up front, so neither the accumulator nor the return needs a fallback.
  const found = Object.values(data).some((value) => adjustmentOf(value) !== undefined);
  if (!found) return { clean: data, steps: NO_STEPS };
  const steps: ArithmeticStep[] = [];
  const clean: Record<string, unknown> = { ...data };
  for (const [field, value] of Object.entries(data)) {
    const marker = adjustmentOf(value);
    if (!marker) continue;
    if (!allow)
      throw compileError(
        "ValidationError",
        `${operation}: "${field}" uses { ${marker.kind}: … } — an adjustment changes an EXISTING value, so it can't run in a create/insert (or the create branch of an upsert). Use update/updateMany/updateEach, or pass a plain value here.`,
        { operation, table: meta.name, field },
      );
    assertAdjustment(meta, field, marker, operation);
    steps.push(loweringOf(marker, field));
    delete clean[field];
  }
  return { clean, steps };
}

/** The `SET` lowering of one marker (`field` is filled by the caller). */
function loweringOf(marker: Adjustment, field: string): ArithmeticStep {
  switch (marker.kind) {
    case "decrement":
    case "remove":
      return { field, op: "-=", value: marker.value };
    case "union":
      return { field, op: "union", value: marker.value };
    case "at":
      return { field, op: "at", value: marker.value };
    default:
      return { field, op: "+=", value: marker.value };
  }
}

/** Validate one adjustment's target field + operand (known column of the right family, never `id`). */
function assertAdjustment(
  meta: ModelMeta,
  field: string,
  marker: Adjustment,
  operation: string,
): void {
  if (field === "id")
    throw compileError(
      "ValidationError",
      `${operation}: "id" can't be adjusted — it is the record identity.`,
      { operation, table: meta.name, field },
    );
  assertAdjustmentOperand(marker, operation, field);
  if (!isTableMeta(meta)) return;
  const column: ColumnMeta | undefined = (meta as TableMeta).columns.get(field);
  if (!column)
    throw compileError(
      "ValidationError",
      `${operation}: "${field}" is not a field of "${meta.name}". Known fields: ${[...meta.columns.keys()].join(", ")}.`,
      { operation, table: meta.name, field },
    );
  const wantsArray = marker.family === "array";
  const right = wantsArray
    ? column.family === "array" || column.family === "set"
    : column.family === "number";
  if (right) return;
  throw compileError(
    "ValidationError",
    wantsArray
      ? `${operation}: "${field}" is a ${column.family} field — { ${marker.kind}: … } adjusts an array field (array/set). Use a plain value, a numeric { increment }/{ decrement }, or a surql fragment.`
      : `${operation}: "${field}" is a ${column.family} field — { ${marker.kind}: … } needs a numeric field (int/float/decimal). Use a plain value or a surql fragment for other sweeps.`,
    { operation, table: meta.name, field },
  );
}

/** The operand shape each marker family accepts (a literal or a server-side expression). */
function assertAdjustmentOperand(
  marker: Adjustment,
  operation: string,
  field: string,
): void {
  const operand = marker.value;
  if (isLowerableValue(operand)) return;
  if (marker.kind === "at") {
    const pair = operand as { index?: unknown; value?: unknown };
    if (
      isPlainObject(operand) &&
      Number.isInteger(pair.index) &&
      (pair.index as number) >= 0 &&
      pair.value !== undefined
    )
      return;
    throw compileError(
      "ValidationError",
      `${operation}: { at: … } on "${field}" must be { index: <non-negative int>, value: <the new element> } (got ${describeValue(operand)}).`,
      { operation, field },
    );
  }
  if (isLiteralOperand(marker.family, operand)) return;
  throw compileError(
    "ValidationError",
    marker.family === "number"
      ? `${operation}: { ${marker.kind}: … } needs a number, bigint, Decimal or expression operand (got ${describeValue(operand)}).`
      : `${operation}: { ${marker.kind}: … } needs a value or an array operand (the element, or an array to append/union) or an expression (got ${describeValue(operand)}).`,
    { operation, field },
  );
}

/**
 * A NUMERIC marker takes a number/bigint/Decimal; an ARRAY marker takes any plain value (the
 * element, the whole array, a record, a date) — the element type is the SCHEMA's business, so the
 * marker parser only rejects what the server could never bind.
 */
function isLiteralOperand(family: Adjustment["family"], value: unknown): boolean {
  if (family === "number")
    return (
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Decimal
    );
  if (typeof value === "function") return false;
  if (value === null || typeof value !== "object") return true;
  return (
    Array.isArray(value) ||
    isPlainObject(value) ||
    value instanceof Date ||
    value instanceof RecordId ||
    value instanceof Decimal
  );
}


/**
 * One adjustment assignment. `+=`/`-=` are the compound-assignment forms (numeric arithmetic, array
 * append and array remove — the server keeps the field's UNIQUE index correct on both). `union` is
 * the only DEDUPING array merge (`array::union` — `+=` appends blindly, live-verified:
 * `["a"] += ["a"]` is `["a","a"]`), and `at` assigns a single index.
 */
function renderStep(step: ArithmeticStep, binds: Binds): string {
  const field = renderPath(step.field);
  if (step.op === "union")
    return `${field} = array::union(${field}, ${renderValue(step.value, binds, binds.ctx())})`;
  if (step.op === "at") {
    const pair = step.value as { index: number; value: unknown };
    return `${field}[${nonNegativeIndex(pair.index)}] = ${renderValue(pair.value, binds, binds.ctx())}`;
  }
  return `${field} ${step.op} ${renderValue(step.value, binds, binds.ctx())}`;
}

/** An array index in a `SET f[n]` assignment (the compiler already validated it as an integer). */
function nonNegativeIndex(index: number): number {
  return index;
}

export function setBody(
  encoded: unknown,
  steps: readonly ArithmeticStep[],
  binds: Binds,
  deep: boolean,
): string {
  const parts: string[] = [];
  if (isPlainObject(encoded)) {
    for (const [field, value] of Object.entries(encoded)) {
      if (value === undefined) continue;
      if (deep && isPlainObject(value)) {
        flattenAssignments(value, [field], parts, binds);
        continue;
      }
      parts.push(
        `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`,
      );
    }
  }
  for (const step of steps) parts.push(renderStep(step, binds));
  return `SET ${parts.join(", ")}`;
}
