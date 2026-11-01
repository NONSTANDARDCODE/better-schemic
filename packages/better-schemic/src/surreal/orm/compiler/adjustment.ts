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

import { BoundQuery, Decimal, RecordId } from "surrealdb";
import type { Surql } from "../../frag";
import type { Ctx } from "../../pure";
import { type Adjustment, adjustmentOf } from "../arithmetic";
import type { ColumnMeta, ModelMeta, TableMeta } from "../meta";
import {
  type Binds,
  compileError,
  describeValue,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  renderBareFragment,
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
  /** The server-side guard of `when` (`SET f = IF <when> THEN … ELSE … END`). */
  readonly when?: Surql;
  /** The `ELSE` branch: `"keep"` (absent/`"keep"` → `ELSE f`), `"throw"`, or a value/fragment. */
  readonly else_?: unknown;
  /** The seed for a missing array on `union`/`append` (`f ?? $c`). */
  readonly coalesce?: unknown;
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
  const found = Object.values(data).some(
    (value) => adjustmentOf(value) !== undefined,
  );
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
  const step = (op: StepOp): ArithmeticStep => ({
    field,
    op,
    value: marker.value,
    ...(marker.when !== undefined ? { when: marker.when as Surql } : {}),
    ...(marker.else !== undefined ? { else_: marker.else } : {}),
    ...(marker.coalesce !== undefined ? { coalesce: marker.coalesce } : {}),
  });
  switch (marker.kind) {
    case "decrement":
    case "remove":
      return step("-=");
    case "union":
      return step("union");
    case "at":
      return step("at");
    default:
      return step("+=");
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
  assertModifiers(marker, operation, field);
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
 * Validate the MODIFIERS of one marker: `when` (a server-side `Surql` guard — never on `at`),
 * `else` (only with `when`; `"keep"`/`"throw"`/a renderable value) and `coalesce` (only on
 * `union`/`append`, where it seeds a missing array). `adjustmentOf` only recognises the shapes;
 * the teaching happens here, against the SAME field/operation context as the operand checks.
 */
function assertModifiers(
  marker: Adjustment,
  operation: string,
  field: string,
): void {
  const { when, coalesce } = marker;
  if (when !== undefined) {
    if (marker.kind === "at")
      throw compileError(
        "ValidationError",
        `${operation}: "when" can't guard { at: … } on "${field}" — SET f[n] assigns ONE index and has no field expression to put inside IF. Use { append }/{ union } with "when", or a surql fragment.`,
        { operation, field },
      );
    if (!(when instanceof BoundQuery))
      throw compileError(
        "ValidationError",
        `${operation}: "when" on "${field}" must be a surql\`…\` fragment — the guard is evaluated by the server (got ${describeValue(when)}).`,
        { operation, field },
      );
  }
  if (marker.else !== undefined) {
    if (when === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: "else" on "${field}" is the fallback of "when" — add a "when" guard or drop "else".`,
        { operation, field },
      );
    if (
      marker.else !== "keep" &&
      marker.else !== "throw" &&
      typeof marker.else === "function"
    )
      throw compileError(
        "ValidationError",
        `${operation}: "else" on "${field}" must be "keep", "throw", or a value/expression (got ${describeValue(marker.else)}).`,
        { operation, field },
      );
  }
  if (coalesce === undefined) return;
  if (marker.kind !== "union" && marker.kind !== "append")
    throw compileError(
      "ValidationError",
      marker.family === "number"
        ? `${operation}: { ${marker.kind}: … } doesn't take "coalesce" — a numeric adjustment already treats a missing value as the operand (NONE + n = n). "coalesce" seeds a missing ARRAY with { union }/{ append }.`
        : `${operation}: { ${marker.kind}: … } doesn't take "coalesce" — only { union }/{ append } can seed a missing array; "remove"/"at" don't.`,
      { operation, field },
    );
  if (
    marker.kind === "union" &&
    !Array.isArray(coalesce) &&
    !(coalesce instanceof BoundQuery)
  )
    throw compileError(
      "ValidationError",
      `${operation}: "coalesce" on { union } of "${field}" must be an array or a surql expression (got ${describeValue(coalesce)}).`,
      { operation, field },
    );
  if (
    marker.kind === "append" &&
    !(coalesce instanceof BoundQuery) &&
    !isLiteralOperand("array", coalesce)
  )
    throw compileError(
      "ValidationError",
      `${operation}: "coalesce" on { append } of "${field}" must be a value or a surql expression (got ${describeValue(coalesce)}).`,
      { operation, field },
    );
}

/**
 * A NUMERIC marker takes a number/bigint/Decimal; an ARRAY marker takes any plain value (the
 * element, the whole array, a record, a date) — the element type is the SCHEMA's business, so the
 * marker parser only rejects what the server could never bind.
 */
function isLiteralOperand(
  family: Adjustment["family"],
  value: unknown,
): boolean {
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
 *
 * MODIFIERS turn the step into a guarded replacement — `SET f = IF <when> THEN <effect> ELSE <else>
 * END` — where `<effect>` reproduces the operator on the CURRENT value (`f + $p`, `f - $p`,
 * `array::union(f ?? $c, $p)`), so it is still ONE server-side read-modify-write. Without
 * modifiers the output is byte-for-byte the historical statement.
 */
function renderStep(step: ArithmeticStep, binds: Binds): string {
  const field = renderPath(step.field);
  if (step.op === "at") {
    // `when`/`coalesce` are rejected for `at` before lowering (there is no field expression to
    // put inside IF, and the target is an index, not an array to seed).
    const pair = step.value as { index: number; value: unknown };
    return `${field}[${nonNegativeIndex(pair.index)}] = ${renderValue(pair.value, binds, binds.ctx())}`;
  }
  const ctx = binds.ctx();
  const guard =
    step.when === undefined
      ? undefined
      : (renderBareFragment(step.when, binds) ??
        renderValue(step.when, binds, ctx));
  // Seed BEFORE the operand: the emitted order (`f ?? $c, $p`) is also the bind order.
  const coalesce =
    step.coalesce === undefined
      ? undefined
      : renderValue(step.coalesce, binds, ctx);
  const operand = renderValue(step.value, binds, ctx);
  const rhs =
    step.op === "union"
      ? `array::union(${coalesce === undefined ? field : `${field} ?? ${coalesce}`}, ${operand})`
      : step.op === "+="
        ? `${coalesce === undefined ? field : `(${field} ?? ${coalesce})`} + ${operand}`
        : `${field} - ${operand}`;
  if (guard !== undefined)
    return `${field} = IF ${guard} THEN ${rhs} ELSE ${elseBranch(step.else_, field, binds, ctx)} END`;
  if (coalesce !== undefined) return `${field} = ${rhs}`;
  // No modifiers — the historical forms, unchanged.
  if (step.op === "union")
    return `${field} = array::union(${field}, ${operand})`;
  return `${field} ${step.op} ${operand}`;
}

/** The `ELSE` branch of a guarded step: keep the value, throw, or render the value/fragment. */
function elseBranch(
  value: unknown,
  field: string,
  binds: Binds,
  ctx: Ctx,
): string {
  if (value === undefined || value === "keep") return field;
  if (value === "throw")
    return `THROW s"adjustment guard failed on ${field.replace(/["\\]/g, "\\$&")}"`;
  return renderValue(value, binds, ctx);
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
