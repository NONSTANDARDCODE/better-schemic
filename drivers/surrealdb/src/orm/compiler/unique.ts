/**
 * The `findUnique` target resolution — which `where` shapes prove uniqueness (`id` or a single-field
 * UNIQUE index). Which fields are unique is RUNTIME schema metadata (`TableDef.config.indexes`), so
 * this validation can only live here, not in the type system.
 */
import type { ModelMeta } from "../meta";
import { compileError, isPlainObject, uniqueFields } from "./shared";

/** The resolved target of a `findUnique` where. */
export type UniqueTarget =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "field"; readonly field: string; readonly value: unknown };

/** Resolve a `findUnique` where to its unique target (or throw `UniqueTargetRequired`). */
export function uniqueTarget(meta: ModelMeta, where: unknown): UniqueTarget {
  if (!isPlainObject(where) || countEntries(where) !== 1)
    throw uniqueError(
      meta,
      "the where must target exactly one field (id or a unique column)",
      where,
    );
  const [key, value] = Object.entries(where).find(
    ([, v]) => v !== undefined,
  ) as [string, unknown];
  if (key === "id") return { kind: "id", id: idText(meta, value) };
  if (uniqueFields(meta).includes(key)) {
    return { kind: "field", field: key, value: pureValue(meta, key, value) };
  }
  throw uniqueError(meta, `"${key}" is not unique`, where);
}

/** A `UniqueTargetRequired` with a consistent teaching message. */
function uniqueError(
  meta: ModelMeta,
  reason: string,
  where: unknown,
): ReturnType<typeof compileError> {
  const targets = ["id", ...uniqueFields(meta)];
  return compileError(
    "UniqueTargetRequired",
    `findUnique on "${meta.name}": ${reason}. Available unique targets: ${targets.join(", ")}.`,
    { table: meta.name, operation: "findUnique", details: where },
  );
}

/** The `<id>` text of an id filter (`user:aeon` / a bare id), validated against the table. */
function idText(meta: ModelMeta, value: unknown): string {
  const unwrapped = isPlainObject(value) ? value.equals : value;
  if (unwrapped === undefined || isPlainObject(unwrapped))
    throw uniqueError(meta, "where.id must be a record id value", value);
  const text = String(unwrapped);
  const colon = text.indexOf(":");
  if (colon === -1) return text;
  const table = text.slice(0, colon);
  if (table !== meta.name)
    throw compileError(
      "ValidationError",
      `findUnique: where.id is a "${table}" record id, but this delegate targets "${meta.name}".`,
      { table: meta.name, operation: "findUnique" },
    );
  return text.slice(colon + 1);
}

/** A pure equality value (an `equals` wrapper unwrapped; operators rejected). */
function pureValue(meta: ModelMeta, field: string, value: unknown): unknown {
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 1 && entries[0]?.[0] === "equals")
      return entries[0][1];
    throw uniqueError(
      meta,
      `"${field}" must be compared for equality (operators can't prove uniqueness)`,
      value,
    );
  }
  return value;
}

/** Count the defined entries of a plain object. */
function countEntries(value: Record<string, unknown>): number {
  return Object.values(value).filter((entry) => entry !== undefined).length;
}
