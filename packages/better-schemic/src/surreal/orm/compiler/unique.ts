/**
 * The `findUnique` target resolution — which `where` shapes prove uniqueness (`id` or a single-field
 * UNIQUE index). Which fields are unique is RUNTIME schema metadata (`TableDef.config.indexes`), so
 * this validation can  live here, not in the type system.
 */
import type { ModelMeta } from "../meta"

import { compileError, isPlainObject, isTableMeta, recordIdParts, uniqueFields } from "./shared"

/** The resolved target of a `findUnique` where. */
export type UniqueTarget =
  | {
      readonly entries: readonly (readonly [string, unknown])[]
      readonly index: string
      readonly kind: "index"
    }
  | { readonly field: string; readonly kind: "field"; readonly value: unknown }
  /**
   * A COMPOSITE unique target — a `where` that covers every field of one multi-field UNIQUE index
   * (`[tenant_id, name]`).  as unique as a single column: the conjunction matches at most one
   * record, which is  what an update-by-target promises. `entries` is in the index's own
   * field order so the compiled `WHERE` reads like the index.
   */
  | { readonly id: string; readonly kind: "id" }

/**
 * Resolve a `findUnique` where to its unique target (or throw `UniqueTargetRequired`).
 *
 * Three shapes qualify, each proving at most ONE record: the `id`, a single-field UNIQUE
 * column, or a conjunction covering a composite UNIQUE index (`{ tenant_id, name }`).
 */
export function uniqueTarget(
  meta: ModelMeta,
  where: unknown,
  operation = "findUnique",
): UniqueTarget {
  if (!isPlainObject(where)) {
    throw uniqueError(
      meta,
      "the where must target the id, a unique column, or every field of a composite UNIQUE index",
      where,
      operation,
    )
  }
  const entries = Object.entries<unknown>(where).filter(([, v]) => v !== undefined)
  if (entries.length === 0) {
    throw uniqueError(
      meta,
      "the where must target the id, a unique column, or every field of a composite UNIQUE index",
      where,
      operation,
    )
  }
  if (entries.length === 1) {
    const [key, value] = entries[0]
    if (key === "id") return { id: idText(meta, value, operation), kind: "id" }

    if (uniqueFields(meta).includes(key)) {
      return {
        field: key,
        kind: "field",
        value: pureValue(meta, key, value, operation),
      }
    }
    throw uniqueError(meta, `"${key}" is not unique`, where, operation)
  }
  const group = compositeTarget(meta, entries)
  if (group) return group

  // Not a composite match: teach the closest thing that would work.
  const partial = entries
    .map(([key]) => key)
    .filter((key) => uniqueGroupContaining(meta, key) !== undefined)
  if (partial.length > 0) {
    throw uniqueError(
      meta,
      `${entries.length} fields are not a unique target on their own${compositeHint(partial, entries)}`,
      where,
      operation,
    )
  }
  throw uniqueError(
    meta,
    "the where must target exactly one field (id or a unique column)",
    where,
    operation,
  )
}

/** The suffix naming a composite index when EVERY provided field belongs to one. */
function compositeHint(
  partial: readonly string[],
  entries: readonly (readonly [string, unknown])[],
): string {
  return partial.length === entries.length ? " — they belong to a COMPOSITE unique index" : ""
}

/** The composite UNIQUE group these entries cover , or `undefined`. */
function compositeTarget(
  meta: ModelMeta,
  entries: readonly (readonly [string, unknown])[],
): undefined | UniqueTarget {
  if (!isTableMeta(meta)) return undefined

  const keys = new Set(entries.map(([key]) => key))
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const group of meta.uniqueGroups) {
    const covers = group.length === entries.length && group.every((f) => keys.has(f))
    if (!covers) continue

    const byName = new Map(entries)
    return {
      entries: group.map((field) => {
        const value = byName.get(field)
        return [field, pureValue(meta, field, value, "unique target")] as const
      }),
      index: group.join("_"),
      kind: "index",
    }
  }
  return undefined
}

/** The composite UNIQUE group a field belongs to (used for the teaching message). */
function uniqueGroupContaining(meta: ModelMeta, field: string): readonly string[] | undefined {
  if (!isTableMeta(meta)) return undefined

  return meta.uniqueGroups.find((group) => group.includes(field))
}

/** Require `field` to be a single-field UNIQUE index (upsert/upsertMany conflict targets). */
export function requireUniqueField(meta: ModelMeta, field: string, operation: string): void {
  if (uniqueFields(meta).includes(field)) return

  throw uniqueError(meta, `"${field}" is not unique`, { [field]: true }, operation)
}

/** A `UniqueTargetRequired` with a consistent teaching message. */
function uniqueError(
  meta: ModelMeta,
  reason: string,
  where: unknown,
  operation: string,
): ReturnType<typeof compileError> {
  const targets = ["id", ...uniqueFields(meta)]
  // A field that is unique TOGETHER with others is the most common near-miss (a
  // `[tenant_id, name]` index), so the message names the composite group instead of leaving the
  // caller to guess that a compound index would have made their `where` a valid target.
  const groups = isTableMeta(meta) ? meta.uniqueGroups : []
  const composite = groups.map((group) => `[${group.join(", ")}]`).join(", ")
  const suffix = composite
    ? ` Available unique targets: ${targets.join(", ")}. Composite UNIQUE index: ${composite} — pass EVERY field of one group in "where".`
    : ` Available unique targets: ${targets.join(", ")}.`
  return compileError(
    "UniqueTargetRequired",
    `${operation} on "${meta.name}": ${reason}.${suffix}`,
    { details: where, operation, table: meta.name },
  )
}

/** The `<id>` text of an id filter (`user:aeon` / a bare id), validated against the table. */
function idText(meta: ModelMeta, value: unknown, operation: string): string {
  const unwrapped = isPlainObject(value) ? value.equals : value
  if (unwrapped === undefined || isPlainObject(unwrapped))
    throw uniqueError(meta, "where.id must be a record id value", value, operation)

  return recordIdParts(unwrapped, operation, {
    fallbackTable: meta.name,
    field: "id",
    table: meta.name,
    what: "where.id value",
  }).id
}

/** A pure equality value (an `equals` wrapper unwrapped; operators rejected). */
function pureValue(meta: ModelMeta, field: string, value: unknown, operation: string): unknown {
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    if (entries.length === 1 && entries[0]?.[0] === "equals") return entries[0][1]

    throw uniqueError(
      meta,
      `"${field}" must be compared for equality (operators can't prove uniqueness)`,
      value,
      operation,
    )
  }
  return value
}
