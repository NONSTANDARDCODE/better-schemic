/**
 * The projection compiler — `select`/`omit`/`value` lowered to BOTH the SQL projection text and the
 * {@link ProjectionSpec} the decoder walks (`../decode`), so what the statement returns and how it is
 * decoded can't drift apart. The codec resolution walks the table's Zod shape (`wire.ts` is the only
 * classifier) — it never re-parses a type string.
 */
import { escapeIdent } from "surrealdb";
import { z } from "zod";
import type { ModelMeta, TableMeta } from "../meta";
import type { IncludeSpec } from "./include";
import {
  type Binds,
  compileError,
  describeValue,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  pathSegments,
  renderPath,
  renderValue,
} from "./shared";

/** One decoded leaf of a projection: where it lands, where it comes from, how to decode it. */
export interface ProjectedField {
  /** Output path (`["address", "city"]`). */
  readonly out: readonly string[];
  /** Key path in the raw row (`["address", "city"]`, or `[alias]` for an aliased entry). */
  readonly source: readonly string[];
  /** The SQL expression (used for `SELECT VALUE`). */
  readonly expr: string;
  /** The field's codec, when the table is typed. */
  readonly schema?: z.ZodType;
  /** The raw value is an ARRAY of leaves (an array ancestor or a `[*]` path). */
  readonly each: boolean;
}

/** How to turn raw rows into decoded values. */
export interface ProjectionSpec {
  /** The projection includes `*` — decode the whole row, then overlay explicit entries. */
  readonly star: boolean;
  /** Explicit projection leaves. */
  readonly fields: readonly ProjectedField[];
  /** Top-level fields removed by `omit`. */
  readonly omit: readonly string[];
  /** `SELECT VALUE …` — rows are values, not objects. */
  readonly value: boolean;
  /** For `value: true`: the single leaf's codec/array-ness. */
  readonly valueField?: ProjectedField;
  /**
   * The adjusted schema for a `*` decode when `omit`/`split`/`include` change the row's shape
   * (`undefined` = use the table's own codec untouched).
   */
  readonly starSchema?: z.ZodType;
  /** Relation hydration specs (`include`/`_count`) applied AFTER the base decode. */
  readonly includes: readonly IncludeSpec[];
}

/** Extra projection sources the read assembler merges in (`include`). */
export interface ProjectionExtras {
  /** SQL expressions appended to the projection (`author.id AS author_id`, subqueries, counts). */
  readonly parts?: readonly string[];
  /** Link fields materialized by `FETCH` — the base `*` decode must pass them through. */
  readonly passthrough?: readonly string[];
}

/** The full-row decode spec (writes always return whole records). ONE canonical instance. */
export function fullProjectionSpec(): ProjectionSpec {
  return { star: true, fields: [], omit: [], value: false, includes: [] };
}

/** Compile `select`/`omit`/`value` into SQL text + the decode spec. */
export function compileProjection(
  meta: ModelMeta,
  select: unknown,
  omit: unknown,
  value: boolean,
  binds: Binds,
  operation: string,
  split?: readonly string[],
  extras: ProjectionExtras = {},
): { text: string; spec: ProjectionSpec } {
  const omitList = omitListOf(omit, operation);
  const extraParts = extras.parts ?? [];
  const passthrough = extras.passthrough ?? [];
  if (select === undefined || select === null) {
    if (value)
      throw compileError(
        "ValidationError",
        `${operation}: "value" needs a "select" with exactly one expression.`,
        { operation },
      );
    const starSchema = buildStarSchema(
      meta,
      omitList,
      split,
      passthrough,
      operation,
    );
    return {
      text: starText(
        extraParts.length ? `*, ${extraParts.join(", ")}` : "*",
        omitList,
      ),
      spec: {
        star: true,
        fields: [],
        omit: omitList,
        value: false,
        includes: [],
        ...(starSchema ? { starSchema } : {}),
      },
    };
  }

  if (Array.isArray(select)) {
    const fields: ProjectedField[] = [];
    for (const key of select) {
      if (typeof key !== "string")
        throw compileError(
          "ValidationError",
          `${operation}: select array entries must be field names, got ${describeValue(key)}.`,
          { operation },
        );
      fields.push(projectedFieldFor(meta, [key], [key], key.split("."), split));
    }
    if (fields.length === 0)
      throw compileError(
        "ValidationError",
        `${operation}: select is empty — project at least one field.`,
        { operation },
      );
    if (value) return valueProjection(fields, operation);
    return {
      text: [...fields.map((f) => f.expr), ...extraParts].join(", "),
      spec: { star: false, fields, omit: [], value: false, includes: [] },
    };
  }

  if (!isPlainObject(select))
    throw compileError(
      "ValidationError",
      `${operation}: select must be an array of fields or a projection object, got ${describeValue(select)}.`,
      { operation },
    );

  const fields: ProjectedField[] = [];
  const parts: string[] = [];
  let star = false;
  for (const [key, entry] of Object.entries(select)) {
    if (entry === undefined || entry === false) continue;
    if (key === "*") {
      if (entry !== true)
        throw compileError(
          "ValidationError",
          `${operation}: "*" in select only accepts true.`,
          { operation },
        );
      star = true;
      continue;
    }
    compileEntry(meta, key, entry, [], parts, fields, binds, operation, split);
  }

  if (value) {
    if (star)
      throw compileError(
        "ValidationError",
        `${operation}: "value" can't be combined with "*" — project one expression.`,
        { operation },
      );
    return valueProjection(fields, operation);
  }

  if (!star && parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one field.`,
      { operation },
    );
  const allParts = [...parts, ...extraParts];
  const text = star
    ? starText(allParts.length ? `*, ${allParts.join(", ")}` : "*", omitList)
    : allParts.join(", ");
  const starSchema = star
    ? buildStarSchema(meta, omitList, split, passthrough, operation)
    : undefined;
  return {
    text,
    spec: {
      star,
      fields,
      omit: star ? omitList : [],
      value: false,
      includes: [],
      ...(starSchema ? { starSchema } : {}),
    },
  };
}

/**
 * The adjusted `*` decode schema when `omit`/`split`/`include` change the row's shape. `split`
 * unfolds the field into scalars, so its codec becomes the ELEMENT codec — decoding with the array
 * codec would fail on every row. `passthrough` fields (links materialized by `FETCH`) accept the
 * server's object instead of the record-link codec; `decode.ts` hydrates them afterwards.
 */
function buildStarSchema(
  meta: ModelMeta,
  omit: readonly string[],
  split: readonly string[] | undefined,
  passthrough: readonly string[],
  operation: string,
): z.ZodType | undefined {
  if (!isTableMeta(meta) || (!omit.length && !split && !passthrough.length))
    return undefined;
  if (split && split.length > 1)
    throw compileError(
      "ValidationError",
      `${operation}: split on a nested path ("${split.join(".")}") needs an explicit "select" — the full-row decode can't reshape it.`,
      { operation },
    );
  const shape = {
    ...(meta.def.object as unknown as { shape: Record<string, z.ZodType> })
      .shape,
  };
  if (split) {
    const field = split[0] as string;
    const element = elementSchema(shape[field]);
    if (!element)
      throw compileError(
        "ValidationError",
        `${operation}: split field "${field}" is not an array in the schema.`,
        { operation },
      );
    shape[field] = element;
  }
  for (const field of passthrough) shape[field] = z.unknown().optional();
  let schema: z.ZodType = zObject(shape);
  if (omit.length)
    schema = (schema as unknown as { partial(): z.ZodType }).partial();
  return schema;
}

/** The element schema of an array/set field (`undefined` when it isn't one). */
function elementSchema(schema: z.ZodType | undefined): z.ZodType | undefined {
  if (!schema) return undefined;
  const inner = unwrap(schema);
  const def = zdef(inner);
  if (def.type !== "array" && def.type !== "set") return undefined;
  return (def.element ?? def.valueType) as z.ZodType;
}

/** `z.object` with a loose shape (the runtime schema, not the branded generic). */
function zObject(shape: Record<string, z.ZodType>): z.ZodType {
  return z.object(shape);
}

/** Compile one `select` object entry (field, path, alias, sub-object or expression). */
function compileEntry(
  meta: ModelMeta,
  key: string,
  entry: unknown,
  prefix: readonly string[],
  parts: string[],
  fields: ProjectedField[],
  binds: Binds,
  operation: string,
  split?: readonly string[],
): void {
  if (entry === true) {
    const sqlPath = [...prefix, key].join(".");
    const out = [...prefix, ...pathSegments(key)];
    parts.push(renderPath(sqlPath));
    fields.push(projectedFieldFor(meta, out, out, sqlPath.split("."), split));
    return;
  }
  if (typeof entry === "string") {
    if (prefix.length > 0)
      throw compileError(
        "ValidationError",
        `${operation}: aliases are only supported at the top level of select (got "${key}" nested).`,
        { operation },
      );
    parts.push(`${renderPath(entry)} AS ${escapeIdent(key)}`);
    fields.push(projectedFieldFor(meta, [key], [key], entry.split("."), split));
    return;
  }
  if (isPlainObject(entry)) {
    const nested = [...prefix, key];
    for (const [childKey, child] of Object.entries(entry)) {
      if (child === undefined || child === false) continue;
      compileEntry(
        meta,
        childKey,
        child,
        nested,
        parts,
        fields,
        binds,
        operation,
        split,
      );
    }
    return;
  }
  if (isLowerableValue(entry)) {
    if (prefix.length > 0)
      throw compileError(
        "ValidationError",
        `${operation}: expressions are only supported at the top level of select (got "${key}" nested).`,
        { operation },
      );
    const expr = renderValue(entry, binds, binds.ctx());
    parts.push(`${expr} AS ${escapeIdent(key)}`);
    fields.push({ out: [key], source: [key], expr, each: false });
    return;
  }
  throw compileError(
    "ValidationError",
    `${operation}: select entry "${key}" must be true, a path string, a nested object or a fragment (got ${describeValue(entry)}).`,
    { operation },
  );
}

/** Build the single-expression projection for `value: true`. */
function valueProjection(
  fields: readonly ProjectedField[],
  operation: string,
): { text: string; spec: ProjectionSpec } {
  if (fields.length !== 1)
    throw compileError(
      "ValidationError",
      `${operation}: "value" projects exactly one expression — got ${fields.length}.`,
      { operation },
    );
  const field = fields[0] as ProjectedField;
  return {
    text: field.expr,
    spec: {
      star: false,
      fields: [],
      omit: [],
      value: true,
      valueField: field,
      includes: [],
    },
  };
}

/** `*` plus an `OMIT` list, when any. */
function starText(base: string, omit: readonly string[]): string {
  return omit.length ? `${base} OMIT ${omit.map(renderPath).join(", ")}` : base;
}

/**
 * Build a projected leaf, resolving its codec from the table shape (SPLIT unfolds arrays).
 * `schemaPath` keeps the ORIGINAL bracket segments (`contacts[0].value`): the walker needs the
 * `[n]`/`[*]` mode to decide between a scalar and an array leaf.
 */
export function projectedFieldFor(
  meta: ModelMeta,
  out: readonly string[],
  source: readonly string[],
  schemaPath: readonly string[],
  split?: readonly string[],
): ProjectedField {
  const expr = renderPath(schemaPath.join("."));
  if (!isTableMeta(meta)) return { out, source, expr, each: false };
  const found = resolveLeafCodec(meta, schemaPath);
  const stripped = pathSegments(schemaPath.join("."));
  const isSplit =
    split !== undefined &&
    split.length === stripped.length &&
    split.every((segment, i) => segment === stripped[i]);
  const schema = isSplit
    ? (elementSchema(found.schema) ?? found.schema)
    : found.schema;
  return {
    out,
    source,
    expr,
    each: isSplit ? false : found.each,
    ...(schema ? { schema } : {}),
  };
}

/**
 * Resolve the codec + array-ness of a path through a table's Zod shape. Exported so `include`
 * remounting decodes a projected link leaf with the TARGET's codec without duplicating the walker
 * (the projection compiler and the include decoder can never disagree about a field's codec).
 */
export function resolveLeafCodec(
  meta: TableMeta,
  schemaPath: readonly string[],
): { schema?: z.ZodType; each: boolean } {
  return leafSchema(meta, parsePath(schemaPath));
}

// --- codec resolution (walks the Zod shape; never re-parses type strings) -------------------------

const zdef = (schema: z.ZodType): { type: string; [k: string]: unknown } =>
  schema._zod.def as unknown as { type: string; [k: string]: unknown };

/** One path segment: its key, and whether it indexes an array (`[*]`/none) or a fixed slot (`[0]`). */
interface PathSegment {
  readonly name: string;
  /** `auto` = no brackets (an array ancestor yields an array), `many` = `[*]`, `index` = `[n]`. */
  readonly mode: "auto" | "many" | "index";
}

/** Parse a projection path into segments, keeping bracket semantics. */
function parsePath(segments: readonly string[]): readonly PathSegment[] {
  const out: PathSegment[] = [];
  for (const raw of segments) {
    const matches = [...raw.matchAll(/\[(\d+|\*)\]/g)];
    const name = raw.replace(/\[\d+\]|\[\*\]/g, "");
    const mode: PathSegment["mode"] = matches.some((m) => m[1] === "*")
      ? "many"
      : matches.length > 0
        ? "index"
        : "auto";
    out.push({ name, mode });
  }
  return out;
}

/** Unwrap option/nullable/default/readonly/pipe/catch to the shape that owns the field. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    const def = zdef(current);
    if (
      def.type === "optional" ||
      def.type === "nullable" ||
      def.type === "default" ||
      def.type === "prefault" ||
      def.type === "readonly" ||
      def.type === "catch"
    ) {
      current = def.innerType as z.ZodType;
      continue;
    }
    if (def.type === "pipe") {
      current = def.out as z.ZodType;
      continue;
    }
    return current;
  }
}

/**
 * Walk a projection path through the table shape, tracking array-ness: an array ancestor (or `[*]`)
 * makes the leaf an ARRAY of decoded values; an explicit `[n]` descends without the array wrapper.
 */
function leafSchema(
  meta: TableMeta,
  segments: readonly PathSegment[],
): { schema?: z.ZodType; each: boolean } {
  const shape = (meta.def.object as { shape?: Record<string, z.ZodType> })
    .shape;
  if (!shape || segments.length === 0) return { each: false };
  let current: z.ZodType = meta.def.object;
  let each = false;
  for (const segment of segments) {
    const step = descend(current, segment);
    if (!step.next) return { each };
    current = step.next;
    each = each || step.each;
  }
  return { schema: current, each };
}

/** Descend one path segment; arrays unwrap (and mark `each`) unless the segment is an explicit index. */
function descend(
  current: z.ZodType,
  segment: PathSegment,
): { next?: z.ZodType; each: boolean } {
  const inner = unwrap(current);
  const def = zdef(inner);
  if (def.type === "array" || def.type === "set") {
    const element = (def.element ?? def.valueType) as z.ZodType;
    const step = descend(element, segment);
    return { next: step.next, each: segment.mode !== "index" || step.each };
  }
  if (def.type === "object") {
    const child = (def.shape as Record<string, z.ZodType>)[segment.name];
    if (!child) return { each: false };
    if (segment.mode === "auto") return { next: child, each: false };
    const childInner = unwrap(child);
    const childDef = zdef(childInner);
    if (childDef.type !== "array" && childDef.type !== "set")
      return { next: child, each: false };
    const element = (childDef.element ?? childDef.valueType) as z.ZodType;
    return { next: element, each: segment.mode !== "index" };
  }
  return { each: false };
}

/** Normalize `omit` to a list of field names. */
function omitListOf(omit: unknown, operation: string): readonly string[] {
  if (omit === undefined || omit === null) return [];
  if (!Array.isArray(omit))
    throw compileError(
      "ValidationError",
      `${operation}: omit must be an array of field names, got ${describeValue(omit)}.`,
      { operation },
    );
  for (const field of omit)
    if (typeof field !== "string" || !field)
      throw compileError(
        "ValidationError",
        `${operation}: omit entries must be field names, got ${describeValue(field)}.`,
        { operation },
      );
  return omit as readonly string[];
}
