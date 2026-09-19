/**
 * The row decoder — turns the raw rows a read returns into app values, driven by the
 * {@link ProjectionSpec} the compiler produced:
 *
 * - full row (`*` / no `select`) -> `TableDef.decode` (the Zod codec: RecordId/Date/Duration/…);
 * - `omit` -> a shallow-partial decode (the omitted field is absent, the rest still validates);
 * - explicit projection -> each leaf is decoded with ITS field codec, at the path the server
 *   returned it (`SELECT address.city` nests, an alias flattens, `contacts[*].type` is an array);
 * - `value` -> the single leaf, decoded directly;
 * - `include` -> after the base decode, relation specs hydrate the fetched links (`FETCH`),
 *   remount projected links from their flat columns, decode graph subqueries per target table and
 *   assemble `_count`.
 *
 * A decode failure is a `ValidationError` with the table/field context — the DB returned something
 * the schema can't represent, which is a bug worth surfacing, never silently passing through.
 */
import { RecordId } from "surrealdb";
import { z } from "zod";
import type {
  EdgeIncludeSpec,
  IncludeSpec,
  LinkFetchSpec,
  LinkLeafSpec,
  LinkProjectionSpec,
  TargetProjection,
} from "./compiler/include";
import {
  type ProjectedField,
  type ProjectionSpec,
  resolveLeafCodec,
} from "./compiler/projection";
import { normalizeError } from "./errors";
import type { ModelMeta, SchemaIndex, TableMeta } from "./meta";

/** Decode every raw row of a read. */
export function decodeRows(
  rows: readonly unknown[],
  meta: ModelMeta,
  spec: ProjectionSpec,
  index?: SchemaIndex,
): unknown[] {
  return rows.map((row) => decodeRow(row, meta, spec, index));
}

/** Decode a single raw row (or the raw value of a `SELECT VALUE`). */
export function decodeRow(
  row: unknown,
  meta: ModelMeta,
  spec: ProjectionSpec,
  index?: SchemaIndex,
): unknown {
  const decoded = decodeBase(row, meta, spec);
  if (spec.includes.length === 0 || !index || !isObject(decoded))
    return decoded;
  for (const include of spec.includes)
    hydrateInclude(row, decoded, include, index);
  return decoded;
}

/** The un-hydrated decode (`*`/omit/projection/value). */
function decodeBase(
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

// --- include hydration ---------------------------------------------------------------------------

/** Hydrate one include entry into the decoded row. */
function hydrateInclude(
  rawRow: unknown,
  decoded: Record<string, unknown>,
  include: IncludeSpec,
  index: SchemaIndex,
): void {
  switch (include.kind) {
    case "link-fetch": {
      decoded[include.key] = decodeLinkFetch(
        getAt(rawRow, [include.key]),
        include,
        index,
      );
      return;
    }
    case "link-projection": {
      decoded[include.key] = decodeLinkProjection(rawRow, include, index);
      return;
    }
    case "edge": {
      decoded[include.key] = decodeEdge(
        getAt(rawRow, [include.key]),
        include,
        index,
      );
      return;
    }
    case "count": {
      const bucket = isObject(decoded._count) ? decoded._count : {};
      bucket[include.key] = getAt(rawRow, [include.source]);
      decoded._count = bucket;
      return;
    }
  }
}

/** Decode a FETCHed link (single object, array of objects, `null` on a missing link). */
function decodeLinkFetch(
  value: unknown,
  spec: LinkFetchSpec,
  index: SchemaIndex,
): unknown {
  if (value === null || value === undefined) return spec.list ? [] : null;
  const entries = spec.list && Array.isArray(value) ? value : [value];
  const out = entries.map((entry) => decodeLinkEntry(entry, spec, index));
  return spec.list ? out : (out[0] ?? null);
}

/** Decode one FETCHed link record with the TARGET codec + its nested link includes. */
function decodeLinkEntry(
  raw: unknown,
  spec: LinkFetchSpec,
  index: SchemaIndex,
): unknown {
  const meta = targetMetaFor(spec.targets, index, raw);
  if (!meta || !isObject(raw)) return raw;
  const nestedKeys = spec.nested.map((nested) => nested.key);
  const schema =
    nestedKeys.length === 0
      ? (meta.def.object as unknown as z.ZodType)
      : passthroughSchema(meta, nestedKeys);
  const decoded = decodeSchema(schema, raw, meta.name);
  if (!isObject(decoded)) return decoded;
  for (const nested of spec.nested)
    if (nested.kind === "link-fetch" || nested.kind === "link-projection")
      hydrateInclude(raw, decoded, nested, index);
  return decoded;
}

/** Remount a projected link from its flat columns (`author_id` -> `author: { id }`). */
function decodeLinkProjection(
  rawRow: unknown,
  spec: LinkProjectionSpec,
  index: SchemaIndex,
): unknown {
  const meta = targetMetaFor(
    spec.targets,
    index,
    findProjectedId(rawRow, spec.leaves),
  );
  if (spec.list) return decodeListProjection(rawRow, spec, meta);
  const out: Record<string, unknown> = {};
  for (const leaf of spec.leaves) {
    const raw = getAt(rawRow, [leaf.source]);
    setAt(out, leaf.out, decodeLinkLeaf(raw, leaf, meta, spec.key));
  }
  return out;
}

/** A projected ARRAY link: each leaf is an array; zip them into element objects. */
function decodeListProjection(
  rawRow: unknown,
  spec: LinkProjectionSpec,
  meta: TableMeta | undefined,
): unknown[] {
  const columns = spec.leaves.map((leaf) => {
    const value = getAt(rawRow, [leaf.source]);
    return {
      leaf,
      values: Array.isArray(value) ? value : value == null ? [] : [value],
    };
  });
  const length = columns.reduce(
    (max, column) => Math.max(max, column.values.length),
    0,
  );
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < length; i++) {
    const entry: Record<string, unknown> = {};
    for (const { leaf, values } of columns)
      setAt(entry, leaf.out, decodeLinkLeaf(values[i], leaf, meta, spec.key));
    out.push(entry);
  }
  return out;
}

/** The projected `id` leaf's raw value (used to pick a union target's codec). */
function findProjectedId(
  rawRow: unknown,
  leaves: readonly LinkLeafSpec[],
): unknown {
  const idLeaf = leaves.find(
    (leaf) => leaf.schemaPath.length === 1 && leaf.schemaPath[0] === "id",
  );
  return idLeaf ? getAt(rawRow, [idLeaf.source]) : undefined;
}

/** Decode one projected leaf with the target table's codec. */
function decodeLinkLeaf(
  raw: unknown,
  leaf: LinkLeafSpec,
  meta: TableMeta | undefined,
  table: string,
): unknown {
  if (!meta) return raw;
  const found = resolveLeafCodec(meta, leaf.schemaPath);
  const field: ProjectedField = {
    out: leaf.out,
    source: [leaf.source],
    expr: "",
    each: found.each,
    ...(found.schema ? { schema: found.schema } : {}),
  };
  return decodeLeaf(raw, field, table);
}

// --- graph edges ---------------------------------------------------------------------------------

/** Decode one edge include's subquery result (an array of target/edge/edge-target rows). */
function decodeEdge(
  value: unknown,
  spec: EdgeIncludeSpec,
  index: SchemaIndex,
): unknown[] {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  return rows.map((row) => {
    if (spec.shape === "edge-target" && isObject(row)) {
      const alias = spec.alias === "?" ? undefined : spec.alias;
      const targetRaw = alias ? row[alias] : undefined;
      const edgeFields: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(row))
        if (key !== alias) edgeFields[key] = entry;
      return {
        edge: decodeEdgeProjection(edgeFields, spec, index),
        target: decodeTargetProjection(targetRaw, spec.target, index),
      };
    }
    if (spec.shape === "edge") return decodeEdgeProjection(row, spec, index);
    return decodeTargetProjection(row, spec.target, index);
  });
}

/** Decode an edge record with the edge table's codec (wildcards pass through). */
function decodeEdgeProjection(
  raw: unknown,
  spec: EdgeIncludeSpec,
  index: SchemaIndex,
): unknown {
  const projection = spec.edge;
  if (!projection || projection.wildcard || !projection.meta) return raw;
  return decodeRow(raw, projection.meta, projection.spec, index);
}

/** Decode one target row, picking the codec of its actual table (union/wildcard targets). */
function decodeTargetProjection(
  raw: unknown,
  projection: TargetProjection,
  index: SchemaIndex,
): unknown {
  if (projection.wildcard) return raw;
  if (projection.entries.length === 0) return raw;
  if (projection.entries.length === 1) {
    const entry = projection.entries[0] as (typeof projection.entries)[number];
    return entry.meta ? decodeRow(raw, entry.meta, entry.spec, index) : raw;
  }
  const name = recordTableOf(raw);
  const entry = name
    ? projection.entries.find((candidate) => candidate.name === name)
    : undefined;
  if (!entry) return raw;
  return entry.meta ? decodeRow(raw, entry.meta, entry.spec, index) : raw;
}

/** The physical table a raw value names (a row's `id`, a RecordId, or a `"t:id"` string). */
function recordTableOf(raw: unknown): string | undefined {
  if (raw instanceof RecordId) return raw.table.name;
  if (typeof raw === "string") {
    const colon = raw.indexOf(":");
    return colon > 0 ? raw.slice(0, colon) : undefined;
  }
  if (!isObject(raw)) return undefined;
  return recordTableOf(raw.id);
}

// --- shared helpers ------------------------------------------------------------------------------

/** The single target meta of a link (`undefined` for unions/bare records without an id). */
function targetMetaFor(
  targets: readonly string[],
  index: SchemaIndex,
  raw: unknown,
): TableMeta | undefined {
  if (targets.length === 0) return undefined;
  if (targets.length === 1) return tableMetaByName(index, targets[0] as string);
  const name = recordTableOf(raw);
  return name ? tableMetaByName(index, name) : undefined;
}

function tableMetaByName(
  index: SchemaIndex,
  name: string,
): TableMeta | undefined {
  const meta = index.byName.get(name);
  return meta && !("schemaless" in meta) ? meta : undefined;
}

/** The table's schema with the given fields passed through (for nested FETCH hydration). */
function passthroughSchema(
  meta: TableMeta,
  fields: readonly string[],
): z.ZodType {
  const shape = {
    ...(meta.def.object as unknown as { shape: Record<string, z.ZodType> })
      .shape,
  };
  for (const field of fields) shape[field] = z.unknown().optional();
  return z.object(shape);
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
