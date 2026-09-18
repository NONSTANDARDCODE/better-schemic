/**
 * The row decoder — turns the raw rows a read returns into app values, driven by the
 * {@link ProjectionSpec} the compiler produced:
 *
 * - full row (`*` / no `select`) -> `TableDef.decode` (the Zod codec: RecordId/Date/Duration/…);
 * - `omit` -> a shallow-partial decode (the omitted field is absent, the rest still validates);
 * - explicit projection -> each leaf is decoded with ITS field codec, at the path the server
 *   returned it (`SELECT address.city` nests, an alias flattens, `contacts[*].type` is an array);
 * - `value` -> the single leaf, decoded directly.
 *
 * A decode failure is a `ValidationError` with the table/field context — the DB returned something
 * the schema can't represent, which is a bug worth surfacing, never silently passing through.
 */
import { z } from "zod";
import type { ProjectedField, ProjectionSpec } from "./compiler/projection";
import { normalizeError } from "./errors";
import type { ModelMeta, TableMeta } from "./meta";

/** Decode every raw row of a read. */
export function decodeRows(
  rows: readonly unknown[],
  meta: ModelMeta,
  spec: ProjectionSpec,
): unknown[] {
  return rows.map((row) => decodeRow(row, meta, spec));
}

/** Decode a single raw row (or the raw value of a `SELECT VALUE`). */
export function decodeRow(
  row: unknown,
  meta: ModelMeta,
  spec: ProjectionSpec,
): unknown {
  if (spec.value) return decodeLeaf(row, spec.valueField, meta.name);
  if (!isTableMeta(meta)) return projectPassthrough(row, spec);
  if (spec.star) {
    const base = spec.starSchema
      ? decodeSchema(spec.starSchema, row, meta.name)
      : decodeFull(meta, row);
    for (const field of spec.omit)
      if (isObject(base)) delete (base as Record<string, unknown>)[field];
    for (const field of spec.fields)
      setAt(
        base,
        field.out,
        decodeLeaf(getAt(row, field.source), field, meta.name),
      );
    return base;
  }
  const out: Record<string, unknown> = {};
  for (const field of spec.fields)
    setAt(
      out,
      field.out,
      decodeLeaf(getAt(row, field.source), field, meta.name),
    );
  return out;
}

/** The full row through the table codec. */
function decodeFull(meta: TableMeta, row: unknown): unknown {
  if (!isObject(row)) return row;
  return decodeSchema(meta.def.object as unknown as z.ZodType, row, meta.name);
}

/** Decode a row with an arbitrary schema, attributing failures to the table. */
function decodeSchema(schema: z.ZodType, row: unknown, table: string): unknown {
  try {
    return z.decode(schema, row as never);
  } catch (e) {
    throw normalizeError(e, { table, operation: "decode" });
  }
}

/** Decode one projected leaf (array leaves decode element-wise). */
function decodeLeaf(
  value: unknown,
  field: ProjectedField | undefined,
  table: string,
): unknown {
  if (!field?.schema) return value;
  if (field.each) {
    if (!Array.isArray(value)) return decodeWith(value, field, table);
    return value.map((element) => decodeWith(element, field, table));
  }
  return decodeWith(value, field, table);
}

/** Decode a value with the field's codec, attributing failures to the table/field. */
function decodeWith(
  value: unknown,
  field: ProjectedField,
  table: string,
): unknown {
  if (value === undefined || value === null || !field.schema) return value;
  try {
    return z.decode(field.schema, value as never);
  } catch (e) {
    throw normalizeError(e, {
      table,
      field: field.out.join("."),
      operation: "decode",
    });
  }
}

/** Schemaless models have no codecs — explicit projections pass values through. */
function projectPassthrough(row: unknown, spec: ProjectionSpec): unknown {
  if (spec.star || spec.fields.length === 0) return row;
  const out: Record<string, unknown> = {};
  for (const field of spec.fields)
    setAt(out, field.out, getAt(row, field.source));
  return out;
}

/** Read a nested key path from a raw row. */
function getAt(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Write a nested key path (creating intermediate objects) into a decoded row. */
function setAt(target: unknown, path: readonly string[], value: unknown): void {
  if (!isObject(target) || path.length === 0) return;
  let current = target as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string;
    const next = current[key];
    if (!isObject(next)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1] as string] = value;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isTableMeta = (meta: ModelMeta): meta is TableMeta =>
  !("schemaless" in meta);
