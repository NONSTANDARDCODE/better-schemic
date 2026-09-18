/**
 * The `findUnique` target resolution — which `where` shapes prove uniqueness (`id` or a single-field
 * UNIQUE index). Which fields are unique is RUNTIME schema metadata (`TableDef.config.indexes`), so
 * this validation can only live here, not in the type system.
 */
import type { ModelMeta } from "../meta";
import {
  compileError,
  isPlainObject,
  recordIdParts,
  uniqueFields,
} from "./shared";

/** The resolved target of a `findUnique` where. */
export type UniqueTarget =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "field"; readonly field: string; readonly value: unknown };

/** Resolve a `findUnique` where to its unique target (or throw `UniqueTargetRequired`). */
export function uniqueTarget(
  meta: ModelMeta,
  where: unknown,
  operation = "findUnique",
): UniqueTarget {
  if (!isPlainObject(where) || countEntries(where) !== 1)
    throw uniqueError(
      meta,
      "the where must target exactly one field (id or a unique column)",
      where,
      operation,
    );
  const [key, value] = Object.entries(where).find(
    ([, v]) => v !== undefined,
  ) as [string, unknown];
  if (key === "id") return { kind: "id", id: idText(meta, value, operation) };
  if (uniqueFields(meta).includes(key)) {
    return {
      kind: "field",
      field: key,
      value: pureValue(meta, key, value, operation),
    };
  }
  throw uniqueError(meta, `"${key}" is not unique`, where, operation);
}

/** Require `field` to be a single-field UNIQUE index (upsert/upsertMany conflict targets). */
export function requireUniqueField(
  meta: ModelMeta,
  field: string,
  operation: string,
): void {
  if (uniqueFields(meta).includes(field)) return;
  throw uniqueError(
    meta,
    `"${field}" is not unique`,
    { [field]: true },
    operation,
  );
}

/** A `UniqueTargetRequired` with a consistent teaching message. */
function uniqueError(
  meta: ModelMeta,
  reason: string,
  where: unknown,
  operation: string,
): ReturnType<typeof compileError> {
  const targets = ["id", ...uniqueFields(meta)];
  return compileError(
    "UniqueTargetRequired",
    `${operation} on "${meta.name}": ${reason}. Available unique targets: ${targets.join(", ")}.`,
    { table: meta.name, operation, details: where },
  );
}

/** The `<id>` text of an id filter (`user:aeon` / a bare id), validated against the table. */
function idText(meta: ModelMeta, value: unknown, operation: string): string {
  const unwrapped = isPlainObject(value) ? value.equals : value;
  if (unwrapped === undefined || isPlainObject(unwrapped))
    throw uniqueError(
      meta,
      "where.id must be a record id value",
      value,
      operation,
    );
  return recordIdParts(unwrapped, operation, {
    fallbackTable: meta.name,
    table: meta.name,
    field: "id",
    what: "where.id value",
  }).id;
}

/** A pure equality value (an `equals` wrapper unwrapped; operators rejected). */
function pureValue(
  meta: ModelMeta,
  field: string,
  value: unknown,
  operation: string,
): unknown {
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 1 && entries[0]?.[0] === "equals")
      return entries[0][1];
    throw uniqueError(
      meta,
      `"${field}" must be compared for equality (operators can't prove uniqueness)`,
      value,
      operation,
    );
  }
  return value;
}

/** Count the defined entries of a plain object. */
function countEntries(value: Record<string, unknown>): number {
  return Object.values(value).filter((entry) => entry !== undefined).length;
}
