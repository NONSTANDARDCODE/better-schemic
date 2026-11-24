/**
 * The projection compiler — `select`/`omit`/`value` lowered to BOTH the SQL projection text and the
 * {@link ProjectionSpec} the decoder walks (`../decode`), so what the statement returns and how it's
 * decoded can't drift apart. The codec resolution walks the table's Zod shape (`wire.ts` is the
 * classifier) — it never re-parses a type string.
 */

import { z } from "zod"

import { escapeIdentSafe as escapeIdent } from "../../ident"
import type { ModelMeta, TableMeta } from "../meta"

import type { IncludeSpec } from "./include"
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
} from "./shared"

/** One decoded leaf of a projection: where it lands, where it comes from, how to decode it. */
export type ProjectedField = {
  /** An expression entry — the server can compute it (a client-side projection rejects it). */
  readonly computed?: true
  /** The raw value is an ARRAY of leaves (an array ancestor or a `[*]` path). */
  readonly each: boolean
  /** The SQL expression (used for `SELECT VALUE`). */
  readonly expr: string
  /**
   * The SCHEMA path a client-side projection reads from an already-decoded app row — set  for
   * alias entries, whose raw `source` is the server output alias (`{ city: "address.city" }`).
   */
  readonly from?: readonly string[]
  /** Output path (`["address", "city"]`). */
  readonly out: readonly string[]
  /** The field's codec, when the table types it. */
  readonly schema?: z.ZodType
  /** Key path in the raw row (`["address", "city"]`, or `[alias]` for an aliased entry). */
  readonly source: readonly string[]
}

/** How to turn raw rows into decoded values. */
export type ProjectionSpec = {
  /** Explicit projection leaves. */
  readonly fields: readonly ProjectedField[]
  /**
   * Reserved aliases the read APPENDED (`_split_<field>`): decoded like any leaf, then dropped from
   * the result, so `data` stays  the user's selection.
   */
  readonly hidden?: readonly string[]
  /** Relation hydration specs (`include`/`_count`) applied AFTER the base decode. */
  readonly includes: readonly IncludeSpec[]
  /** Top-level fields removed by `omit`. */
  readonly omit: readonly string[]
  /** The projection includes `*` — decode the whole row, then overlay explicit entries. */
  readonly star: boolean
  /**
   * The adjusted schema for a `*` decode when `omit`/`split`/`include` change the row's shape
   * (`undefined` = use the table's own codec untouched).
   */
  readonly starSchema?: z.ZodType
  /** `SELECT VALUE …` — rows are values, not objects. */
  readonly value: boolean
  /** For `value: true`: the single leaf's codec/array-ness. */
  readonly valueField?: ProjectedField
}

/** Extra projection sources the read assembler merges in (`include`, cursor keyset columns). */
export type ProjectionExtras = {
  /**
   * Aliases appended to the projection (`path AS alias`), decoded as leaves — the delegate strips
   * them from `data`; keyset cursor values read them from the RAW rows, not these decoded leaves.
   */
  readonly aliases?: readonly ProjectionAlias[]
  /** SQL expressions appended to the projection (`author.id AS author_id`, subqueries, counts). */
  readonly parts?: readonly string[]
  /** Link fields materialized by `FETCH` — the base `*` decode must pass them through. */
  readonly passthrough?: readonly string[]
}

/** One alias the read appends: `path AS alias`, landing as a decoded top-level key. */
export type ProjectionAlias = {
  /** The output/raw key the alias lands under. */
  readonly alias: string
  /** The field path the alias projects. */
  readonly path: string
}

/** The full-row decode spec (writes always return whole records). ONE canonical instance. */
export function fullProjectionSpec(): ProjectionSpec {
  return { fields: [], includes: [], omit: [], star: true, value: false }
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
): { spec: ProjectionSpec; text: string } {
  const omitList = omitListOf(omit, operation)
  const extraParts = extras.parts ?? []
  const passthrough = extras.passthrough ?? []
  // Caller-appended aliases (`author_id`, cursor keyset columns) decode as regular leaves; they
  // never in `*`/`omit` (the overlay runs after the star decode + omit deletions).
  const aliases = extras.aliases ?? []
  const aliasParts = aliases.map(
    ({ alias, path }) => `${renderPath(path)} AS ${escapeIdent(alias)}`,
  )
  const aliasFields = aliases.map(({ alias, path }) =>
    projectedFieldFor(meta, [alias], [alias], path.split("."), split),
  )
  if (select === undefined || select === null) {
    if (value) {
      throw compileError(
        "ValidationError",
        `${operation}: "value" needs a "select" with exactly one expression.`,
        { operation },
      )
    }
    const starSchema = buildStarSchema(meta, omitList, split, passthrough, operation)
    const allParts = [...extraParts, ...aliasParts]
    return {
      spec: {
        fields: aliasFields,
        includes: [],
        omit: omitList,
        star: true,
        value: false,
        ...(starSchema ? { starSchema } : {}),
      },
      text: starText(allParts.length > 0 ? `*, ${allParts.join(", ")}` : "*", omitList),
    }
  }

  if (Array.isArray(select)) {
    const fields: ProjectedField[] = []
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const key of select) {
      if (typeof key !== "string") {
        throw compileError(
          "ValidationError",
          `${operation}: select array entries must be field names, got ${describeValue(key)}.`,
          { operation },
        )
      }
      // The server returns a dotted path NESTED (`SELECT address.city` → `{ address: { city } }`),
      // the leaf decodes from the nested raw path even though the projected key stays literal.
      fields.push(projectedFieldFor(meta, [key], pathSegments(key), key.split("."), split))
    }
    if (fields.length === 0) {
      throw compileError(
        "ValidationError",
        `${operation}: select is empty — project at least one field.`,
        { operation },
      )
    }
    if (value) return valueProjection(fields, operation)

    return {
      spec: {
        fields: [...fields, ...aliasFields],
        includes: [],
        omit: [],
        star: false,
        value: false,
      },
      text: [...fields.map((f) => f.expr), ...extraParts, ...aliasParts].join(", "),
    }
  }

  if (!isPlainObject(select)) {
    throw compileError(
      "ValidationError",
      `${operation}: select must be an array of fields or a projection object, got ${describeValue(select)}.`,
      { operation },
    )
  }

  const fields: ProjectedField[] = []
  const parts: string[] = []
  let star = false
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [key, entry] of Object.entries(select)) {
    if (entry === undefined || entry === false) continue

    if (key === "*") {
      if (entry !== true) {
        throw compileError("ValidationError", `${operation}: "*" in select only accepts true.`, {
          operation,
        })
      }
      star = true
      continue
    }
    compileEntry(meta, key, entry, [], parts, fields, binds, operation, split)
  }

  if (value) {
    if (star) {
      throw compileError(
        "ValidationError",
        `${operation}: "value" can't be combined with "*" — project one expression.`,
        { operation },
      )
    }
    return valueProjection(fields, operation)
  }

  if (!star && parts.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one field.`,
      { operation },
    )
  }
  const allParts = [...parts, ...extraParts, ...aliasParts]
  const text = star
    ? starText(allParts.length > 0 ? `*, ${allParts.join(", ")}` : "*", omitList)
    : allParts.join(", ")
  const starSchema = star
    ? buildStarSchema(meta, omitList, split, passthrough, operation)
    : undefined
  return {
    spec: {
      fields: [...fields, ...aliasFields],
      includes: [],
      omit: star ? omitList : [],
      star,
      value: false,
      ...(starSchema ? { starSchema } : {}),
    },
    text,
  }
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
): undefined | z.ZodType {
  if (!isTableMeta(meta) || (omit.length === 0 && !split && passthrough.length === 0))
    return undefined

  // Memoized per (table, omit/split/passthrough shape): a `*` read with include/omit otherwise
  // rebuilds the Zod object on every query. Failures (invalid split) are never cached.
  const key = `${omit.join(",")}|${split ? split.join(".") : ""}|${passthrough.join(",")}`
  let byKey = STAR_CACHE.get(meta)
  if (!byKey) {
    byKey = new Map()
    STAR_CACHE.set(meta, byKey)
  }
  if (byKey.has(key)) return byKey.get(key)

  if (split && split.length > 1) {
    throw compileError(
      "ValidationError",
      `${operation}: split on a nested path ("${split.join(".")}") needs an explicit "select" — the full-row decode can't reshape it.`,
      { operation },
    )
  }
  const shape = {
    ...(meta.def.object as unknown as { shape: Record<string, z.ZodType> }).shape,
  }
  if (split) {
    const field = split[0]
    const element = elementSchema(shape[field])
    if (!element) {
      throw compileError(
        "ValidationError",
        `${operation}: split field "${field}" is not an array in the schema.`,
        { operation },
      )
    }
    shape[field] = element
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const field of passthrough) shape[field] = z.unknown().optional()

  let schema: z.ZodType = zObject(shape)
  if (omit.length > 0) schema = (schema as unknown as { partial(): z.ZodType }).partial()

  byKey.set(key, schema)
  return schema
}

/** Built `*` schemas per table, keyed by the omit/split/passthrough shape. */
const STAR_CACHE = new WeakMap<TableMeta, Map<string, undefined | z.ZodType>>()

/** The element schema of an array/set field (`undefined` when it isn't one). */
function elementSchema(schema: undefined | z.ZodType): undefined | z.ZodType {
  if (!schema) return undefined

  const inner = unwrap(schema)
  const def = zdef(inner)
  if (def.type !== "array" && def.type !== "set") return undefined

  return (def.element ?? def.valueType) as z.ZodType
}

/**
 * Projection ANALYSIS — what a user `select`/`omit` actually returns, in the normalized shape the
 * read compilers need (the cursor keyset and the SPLIT idiom both ask "does this projection already
 * carry that field?"). Pure, allocation-light and shared so the two can never disagree.
 */

/** The analyzed shape of a VALID user projection (`undefined` = malformed; `compileRead` teaches). */
export type ProjectionForm =
  | { readonly entries: Record<string, unknown>; readonly kind: "object" }
  | { readonly entries: Record<string, unknown>; readonly kind: "star" }
  | { readonly fields: readonly string[]; readonly kind: "list" }
/** Normalize a user projection for analysis; `undefined` when it's malformed. */
export function projectionForm(select: unknown): ProjectionForm | undefined {
  if (select === undefined || select === null) return { entries: {}, kind: "star" }

  if (Array.isArray(select)) {
    const fields = select as readonly unknown[]
    if (
      fields.length === 0 ||
      fields.some((entry) => typeof entry !== "string" || entry.length === 0)
    )
      return undefined

    return { fields: fields as readonly string[], kind: "list" }
  }
  if (!isPlainObject(select)) return undefined

  const entries = select
  const contributes = Object.values(entries).some((entry) => entry !== undefined && entry !== false)
  if (!contributes) return undefined

  return entries["*"] === true ? { entries, kind: "star" } : { entries, kind: "object" }
}

/** Does the projection already return `field` in the decoded row? */
export function projectedInPlace(
  form: ProjectionForm,
  omitted: readonly (readonly string[])[],
  field: string,
): boolean {
  const target = pathSegments(field)
  if (form.kind === "star") return !omitted.some((entry) => covers(entry, target))

  if (form.kind === "list") return form.fields.some((entry) => covers(pathSegments(entry), target))

  return coveredByEntries(form.entries, target)
}

/**
 * Does an object projection descend to `segments` through `true` entries and same-path aliases?
 * The longest key that prefixes the path decides (a dotted key wins over its parent), mirroring
 * how `compileEntry` lays the leaves out.
 */
function coveredByEntries(entries: Record<string, unknown>, segments: readonly string[]): boolean {
  const match = longestKey(entries, segments)
  if (!match) return false

  const entry = entries[match.key]
  if (entry === undefined || entry === false) return false

  if (entry === true) return true

  // A string entry is an alias: it returns the field when it re-projects its own key
  // (`{ address: "address" }`, or the flat `{ "address.city": "address.city" }`).
  if (typeof entry === "string") return entry === match.key

  if (isPlainObject(entry))
    return match.end < segments.length && coveredByEntries(entry, segments.slice(match.end))

  return false
}

/** The longest entry key matching a prefix of `segments` (`"address.city"` before `"address"`). */
function longestKey(
  entries: Record<string, unknown>,
  segments: readonly string[],
): undefined | { readonly end: number; readonly key: string } {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (let end = segments.length; end > 0; end--) {
    const key = segments.slice(0, end).join(".")
    if (key in entries) return { end, key }
  }
  return undefined
}

/** Is `path` the same as, or a descendant of, `ancestor`? */
function covers(ancestor: readonly string[], path: readonly string[]): boolean {
  return (
    ancestor.length <= path.length && ancestor.every((segment, index) => segment === path[index])
  )
}

/** Are two paths the same, segment by segment? */
function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index])
}

/**
 * The select key that REDEFINES the ordered path (`{ age: "id" }`, `{ age: surql\`…\` }`) — the
 * emitted `ORDER BY age` would bind that alias, while the keyset `WHERE age > $c` binds the stored
 * field. A `true` entry, a same-path alias and a nested sub-select (which creates no alias of that
 * name) are not redefinitions.
 */
export function redefinedPath(
  entries: Record<string, unknown>,
  segments: readonly string[],
): string | undefined {
  const key = segments.join(".")
  if (!(key in entries)) return undefined

  const entry = entries[key]
  if (entry === undefined || entry === false || entry === true) return undefined

  if (isPlainObject(entry)) return undefined

  if (typeof entry === "string" && samePath(pathSegments(entry), segments)) return undefined

  return key
}

/** The omit entries that can hide a `*`-projected path (malformed ones are `compileRead`'s error). */
export function omittedPaths(omit: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(omit)) return []

  return omit
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map(pathSegments)
}

/** The top-level output keys a valid projection can emit. */
export function projectionKeys(form: ProjectionForm): ReadonlySet<string> {
  const keys = new Set<string>()
  if (form.kind === "list") {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const field of form.fields) keys.add(pathSegments(field)[0])

    return keys
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const key of Object.keys(form.entries)) keys.add(pathSegments(key)[0])

  return keys
}

/** `z.object` with a loose shape (the runtime schema, not the branded generic). */
function zObject(shape: Record<string, z.ZodType>): z.ZodType {
  return z.object(shape)
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
    const sqlPath = [...prefix, key].join(".")
    const out = [...prefix, ...pathSegments(key)]
    parts.push(renderPath(sqlPath))
    fields.push(projectedFieldFor(meta, out, out, sqlPath.split("."), split))
    return
  }
  if (typeof entry === "string") {
    if (prefix.length > 0) {
      throw compileError(
        "ValidationError",
        `${operation}: aliases are only supported at the top level of select (got "${key}" nested).`,
        { operation },
      )
    }
    parts.push(`${renderPath(entry)} AS ${escapeIdent(key)}`)
    fields.push({
      ...projectedFieldFor(meta, [key], [key], entry.split("."), split),
      from: pathSegments(entry),
    })
    return
  }
  if (isPlainObject(entry)) {
    const nested = [...prefix, key]
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const [childKey, child] of Object.entries(entry)) {
      if (child === undefined || child === false) continue

      compileEntry(meta, childKey, child, nested, parts, fields, binds, operation, split)
    }
    return
  }
  if (isLowerableValue(entry)) {
    if (prefix.length > 0) {
      throw compileError(
        "ValidationError",
        `${operation}: expressions are only supported at the top level of select (got "${key}" nested).`,
        { operation },
      )
    }
    const expr = renderValue(entry, binds, binds.ctx())
    parts.push(`${expr} AS ${escapeIdent(key)}`)
    fields.push({
      computed: true,
      each: false,
      expr,
      out: [key],
      source: [key],
    })
    return
  }
  throw compileError(
    "ValidationError",
    `${operation}: select entry "${key}" must be true, a path string, a nested object or a fragment (got ${describeValue(entry)}).`,
    { operation },
  )
}

/** Build the single-expression projection for `value: true`. */
function valueProjection(
  fields: readonly ProjectedField[],
  operation: string,
): { spec: ProjectionSpec; text: string } {
  if (fields.length !== 1) {
    throw compileError(
      "ValidationError",
      `${operation}: "value" projects exactly one expression — got ${fields.length}.`,
      { operation },
    )
  }
  const field = fields[0]
  return {
    spec: {
      fields: [],
      includes: [],
      omit: [],
      star: false,
      value: true,
      valueField: field,
    },
    text: field.expr,
  }
}

/** `*` plus an `OMIT` list, when any. */
function starText(base: string, omit: readonly string[]): string {
  return omit.length > 0 ? `${base} OMIT ${omit.map(renderPath).join(", ")}` : base
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
  const expr = renderPath(schemaPath.join("."))
  if (!isTableMeta(meta)) return { each: false, expr, out, source }

  const found = resolveLeafCodec(meta, schemaPath)
  const stripped = pathSegments(schemaPath.join("."))
  const isSplit =
    split?.length === stripped.length && split.every((segment, i) => segment === stripped[i])
  const schema = isSplit ? (elementSchema(found.schema) ?? found.schema) : found.schema
  return {
    each: isSplit ? false : found.each,
    expr,
    out,
    source,
    ...(schema ? { schema } : {}),
  }
}

/**
 * Resolve the codec + array-ness of a path through a table's Zod shape. Exported so `include`
 * remounting decodes a projected link leaf with the TARGET's codec without duplicating the walker
 * (the projection compiler and the include decoder can never disagree about a field's codec).
 */
export function resolveLeafCodec(
  meta: TableMeta,
  schemaPath: readonly string[],
): { each: boolean; schema?: z.ZodType } {
  // Memoized per (table, path): the walker reads it once per select/include leaf per query.
  const key = schemaPath.join(".")
  let byKey = LEAF_CACHE.get(meta)
  if (!byKey) {
    byKey = new Map()
    LEAF_CACHE.set(meta, byKey)
  }
  const cached = byKey.get(key)
  if (cached) return cached

  const resolved = leafSchema(meta, parsePath(schemaPath))
  byKey.set(key, resolved)
  return resolved
}

/** Resolved leaf codecs per table, keyed by the dotted schema path. */
const LEAF_CACHE = new WeakMap<TableMeta, Map<string, { each: boolean; schema?: z.ZodType }>>()

// --- codec resolution (walks the Zod shape; never re-parses type strings) -------------------------

const zdef = (schema: z.ZodType): { [k: string]: unknown; type: string } =>
  schema._zod.def as unknown as { [k: string]: unknown; type: string }

/** One path segment: its key, and whether it indexes an array (`[*]`/none) or a fixed slot (`[0]`). */
type PathSegment = {
  /** `auto` = no brackets (an array ancestor yields an array), `some` = `[*]`, `index` = `[n]`. */
  readonly mode: "auto" | "index" | "many"
  readonly name: string
}

/** Parse a projection path into segments, keeping bracket semantics. */
function parsePath(segments: readonly string[]): readonly PathSegment[] {
  const out: PathSegment[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const raw of segments) {
    const matches = [...raw.matchAll(/\[(\d+|\*)\]/gu)]
    const name = raw.replaceAll(/\[\d+\]|\[\*\]/gu, "")
    let mode: PathSegment["mode"] = "auto"
    if (matches.some((m) => m[1] === "*")) mode = "many"
    else if (matches.length > 0) mode = "index"
    out.push({ mode, name })
  }
  return out
}

/** Unwrap option/nullable/default/readonly/pipe/catch to the shape that owns the field. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (;;) {
    const def = zdef(current)
    if (
      def.type === "optional" ||
      def.type === "nullable" ||
      def.type === "default" ||
      def.type === "prefault" ||
      def.type === "readonly" ||
      def.type === "catch"
    ) {
      current = def.innerType as z.ZodType
      continue
    }
    if (def.type === "pipe") {
      current = def.out as z.ZodType
      continue
    }
    return current
  }
}

/**
 * Walk a projection path through the table shape, tracking array-ness: an array ancestor (or `[*]`)
 * makes the leaf an ARRAY of decoded values; an explicit `[n]` descends without the array wrapper.
 */
function leafSchema(
  meta: TableMeta,
  segments: readonly PathSegment[],
): { each: boolean; schema?: z.ZodType } {
  const shape = (meta.def.object as { shape?: Record<string, z.ZodType> }).shape
  if (!shape || segments.length === 0) return { each: false }

  let current: z.ZodType = meta.def.object
  let each = false
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const segment of segments) {
    const step = descend(current, segment)
    if (!step.next) return { each }

    current = step.next
    each = each || step.each
  }
  return { each, schema: current }
}

/** Descend one path segment; arrays unwrap (and mark `each`) unless the segment is an explicit index. */
function descend(current: z.ZodType, segment: PathSegment): { each: boolean; next?: z.ZodType } {
  const inner = unwrap(current)
  const def = zdef(inner)
  if (def.type === "array" || def.type === "set") {
    const element = (def.element ?? def.valueType) as z.ZodType
    const step = descend(element, segment)
    return { each: segment.mode !== "index" || step.each, next: step.next }
  }
  if (def.type === "object") {
    const child = (def.shape as Record<string, z.ZodType>)[segment.name]
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- checagem defensiva em runtime (valores ausentes/mutados por callback); tipo TS é otimista
    if (!child) return { each: false }

    if (segment.mode === "auto") return { each: false, next: child }

    const childInner = unwrap(child)
    const childDef = zdef(childInner)
    if (childDef.type !== "array" && childDef.type !== "set") return { each: false, next: child }

    const element = (childDef.element ?? childDef.valueType) as z.ZodType
    return { each: segment.mode !== "index", next: element }
  }
  return { each: false }
}

/** Normalize `omit` to a list of field names. */
function omitListOf(omit: unknown, operation: string): readonly string[] {
  if (omit === undefined || omit === null) return []

  if (!Array.isArray(omit)) {
    throw compileError(
      "ValidationError",
      `${operation}: omit must be an array of field names, got ${describeValue(omit)}.`,
      { operation },
    )
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const field of omit) {
    if (typeof field !== "string" || !field) {
      throw compileError(
        "ValidationError",
        `${operation}: omit entries must be field names, got ${describeValue(field)}.`,
        { operation },
      )
    }
  }
  return omit as readonly string[]
}
