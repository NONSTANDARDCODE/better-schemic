/**
 * `schema` + the runtime `SchemaIndex` — the ONE metadata pass every `/orm` surface reads:
 * typed tables/edges (columns, record links, graph adjacency), schemaless entries, and DB functions.
 *
 * Built once per schema object (WeakMap-cached) and validated fail-fast, so a bad schema module
 * throws a teaching `SchemaInvalid` at import time instead of failing at the first query. The
 * column metadata projects it from `inferField` (the shared field walker in `../wire`), so the ORM
 * cannot disagree with the DDL emitter about a field's type, family, optionality or link targets.
 */
import type { z } from "zod"

import { type IdStrategy, stringIdsOf } from "../pure"
import { type FieldInfo, inferField, zodDef } from "../wire"

import { OrmError } from "./errors"
import type {
  ColumnMeta,
  EdgeRef,
  FunctionMeta,
  LinkMeta,
  ModelMeta,
  RecordLinkMeta,
  ResolvedIdStrategy,
  SchemaIndex,
  SchemalessMeta,
  TableMeta,
} from "./meta"
import {
  type AnyFunctionDef,
  type AnyRelationDef,
  type AnyTableDef,
  SCHEMA_DEF,
  type SchemaDef,
  type SchemaInput,
} from "./types/schema"

// --- schema branding / construction --------------------------------------------------------------

/** Built-index cache — a schema walks it once, no matter how some clients read it. */

const INDEX_CACHE = new WeakMap<Record<string, unknown>, SchemaIndex>()

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Is this a `schema(...)` artifact (vs. a plain `{ key: def }` literal)? */
export function isSchemaDef(v: unknown): v is SchemaDef {
  return isObject(v) && (v as Record<symbol, unknown>)[SCHEMA_DEF] === true
}

/**
 * Brand + check a schema. Validation runs HERE, at module evaluation, so a bad schema fails at
 * import time (with `SchemaInvalid`) instead of at the first query.
 *
 * ```ts
 * export const schemaDef = schema({
 *   users: User, likes: Likes, sendMail, audit: "audit_log",
 * });
 * ```
 */
export function schema<const S extends SchemaInput>(entries: S): SchemaDef<S> {
  const schemaDef: SchemaDef<S> = { entries, [SCHEMA_DEF]: true }
  buildSchemaIndex(schemaDef)
  return schemaDef
}

/**
 * Build (or return the cached) {@link SchemaIndex} for a schema — accepts a `schema` artifact
 * OR a plain `{ key: def }` literal (both support them; the brand  adds eager validation).
 */
export function buildSchemaIndex(input: SchemaDef | SchemaInput): SchemaIndex {
  const cached = INDEX_CACHE.get(input)
  if (cached) return cached

  const index = build(isSchemaDef(input) ? input.entries : input)
  INDEX_CACHE.set(input, index)
  return index
}

// --- runtime def detection (duck-typed, so a dual-loaded package still works) --------------------

const isZodLike = (v: unknown): v is z.ZodType =>
  isObject(v) && isObject((v as { _zod?: unknown })._zod)

/** The Zod schema behind a field (an `SField` wrapper or a raw Zod type). */
function schemaOf(v: unknown): z.ZodType {
  if (isObject(v)) {
    const inner = (v as { schema?: unknown }).schema
    if (isZodLike(inner)) return inner
  }
  if (isZodLike(v)) return v

  throw new OrmError(
    "SchemaInvalid",
    "expected an s.* field or a Zod schema, got a value with no `.schema`.",
  )
}

function isTableDefLike(v: unknown): v is AnyTableDef {
  return (
    isObject(v) &&
    typeof v.name === "string" &&
    typeof v.decode === "function" &&
    typeof v.encode === "function" &&
    isObject(v.object) &&
    isObject((v.object as { shape?: unknown }).shape)
  )
}

function isFunctionDefLike(v: unknown): v is AnyFunctionDef {
  return isObject(v) && v.kind === "function" && typeof v.name === "string" && isObject(v.args)
}

function isRelationLike(def: AnyTableDef): def is AnyRelationDef {
  return def.config.relation !== undefined
}

// The third constructor parameter of `OrmError` is its options bag.
type ErrorOptionsIndex = 2

// --- index construction --------------------------------------------------------------------------

function invalid(
  message: string,

  options: ConstructorParameters<typeof OrmError>[ErrorOptionsIndex] = {},
): OrmError {
  return new OrmError("SchemaInvalid", `schema: ${message}`, options)
}

function columnMeta(name: string, field: unknown, table: string): ColumnMeta {
  let info: FieldInfo
  try {
    info = inferField(schemaOf(field))
  } catch (error) {
    throw invalid(
      `field "${name}" of "${table}" has no SurrealQL type — ${(error as Error).message}`,
      {
        cause: error,
        field: name,
        table,
      },
    )
  }
  const record: RecordLinkMeta | undefined = info.record
    ? {
        ...(info.record.targets ? { targets: info.record.targets } : {}),
        list: info.family === "array" || info.family === "set",
        optional: info.optional,
        ...(stringIdsOf(schemaOf(field)) ? { stringIds: true } : {}),
      }
    : undefined
  return {
    family: info.family,
    name,
    optional: info.optional,
    type: info.type,
    ...(info.element ? { element: info.element } : {}),
    ...(record ? { record } : {}),
  }
}

/**
 * The strategy an explicit `id` field implies: `uuid` for `s.uuid()`/`s.uuidv7()` (a Zod uuid
 * format or the native uuid codec), `ulid` for `s.ulid()`; `undefined` when the id field is
 * absent/broad (any strategy works). `"unsupported"` marks a format NO strategy can produce
 * (uuid v4/v6) — an explicit `.idStrategy(...)` on such a table is a fail-fast `SchemaInvalid`.
 */
function inferIdStrategy(def: AnyTableDef): "unsupported" | IdStrategy | undefined {
  const idField = (def.fields as Record<string, unknown> | undefined)?.id as
    undefined | { valueType?: z.ZodType }
  const valueType = idField?.valueType
  if (valueType === undefined) return undefined

  // The Zod probe runs first: `inferField` maps every uuid string format to the native `uuid`
  // type, but `rand::uuid()` (v7) can it — a pinned v4/v6 id is unsatisfiable.
  const zod = zodDef(valueType)
  if (zod.format === "uuid") {
    const version = zod.version
    return version === undefined || version === "v7" ? "uuid" : "unsupported"
  }
  if (zod.format === "ulid") return "ulid"

  try {
    // The native `s.uuid()` codec carries no Zod format — its SurrealQL type is `uuid`.
    if (inferField(valueType).type === "uuid") return "uuid"
  } catch {
    // No SurrealQL mapping — no inference.
  }
  return undefined
}

/**
 * Resolve a table's ORM create-id strategy: an explicit `.idStrategy(...)` wins, otherwise the
 * explicit id field's type, otherwise `"ulid"`. A declared strategy that cannot match the id
 * field's codec fails HERE (import time, `SchemaInvalid`) instead of decoding the first create;
 * an undeclared ungeneratable id field resolves to `"none"` (explicit-id writes stay valid, a
 * generated create fails at compile time).
 */
function resolveIdStrategy(def: AnyTableDef): ResolvedIdStrategy {
  const declared = def.config.idStrategy
  const inferred = inferIdStrategy(def)
  if (inferred === "unsupported") {
    if (declared !== undefined) {
      throw invalid(
        `table "${def.name}": idStrategy "${declared}" can't satisfy the declared id field (uuid v4/v6 — no ORM strategy generates that format). Pass an explicit id or change the id field.`,
        { table: def.name },
      )
    }
    return "none"
  }
  if (declared !== undefined) {
    if (inferred !== undefined && declared !== inferred) {
      throw invalid(
        `table "${def.name}": idStrategy "${declared}" conflicts with the declared id field, which requires "${inferred}" — use idStrategy("${inferred}") or change the id field.`,
        { table: def.name },
      )
    }
    return declared
  }
  if (inferred !== undefined) return inferred

  return "ulid"
}

function tableMeta(
  key: string,
  def: AnyTableDef,
  adjacency: { incoming: EdgeRef[]; outgoing: EdgeRef[] },
): TableMeta {
  const columns = new Map<string, ColumnMeta>()
  const links = new Map<string, LinkMeta>()
  const shape = (def.object as { shape: Record<string, unknown> }).shape

  Object.entries(shape).forEach(([field, zod]) => {
    const meta = columnMeta(field, zod, def.name)
    columns.set(field, meta)
    if (meta.record) {
      links.set(field, {
        field,
        ...(meta.record.targets ? { targets: meta.record.targets } : {}),
        cardinality: meta.record.list ? "many" : "one",
        optional: meta.record.optional,
      })
    }
  })

  const relation = isRelationLike(def) ? def.config.relation : undefined

  // Dedupe the adjacency ONCE (outgoing wins) — `findEdge`/`edgesOf` are per-query reads.
  const edges: EdgeRef[] = []
  const seenEdges = new Set<string>()

  ;[...adjacency.outgoing, ...adjacency.incoming].forEach((edge) => {
    if (!seenEdges.has(edge.name)) {
      seenEdges.add(edge.name)
      edges.push(edge)
    }
  })

  return {
    def,
    key,
    kind: relation ? "relation" : "table",
    name: def.name,
    ...(def.singletonId === undefined ? {} : { singletonId: def.singletonId }),
    columns,
    edges,
    idStrategy: resolveIdStrategy(def),
    incoming: adjacency.incoming,
    links,
    outgoing: adjacency.outgoing,
    uniqueFields: (def.config.indexes ?? [])
      .filter((index) => index.unique === true && index.fields.length === 1)
      .map((index) => index.fields[0]),
    uniqueGroups: (def.config.indexes ?? [])
      .filter((index) => index.unique === true && index.fields.length > 1)
      .map((index) => index.fields as readonly string[]),
    ...(relation
      ? {
          endpoints: {
            enforced: relation.enforced === true,
            from: [...relation.from],
            to: [...relation.to],
          },
        }
      : {}),
  }
}

function functionMeta(key: string, def: AnyFunctionDef): FunctionMeta {
  const args = new Map<string, ColumnMeta>()

  Object.entries(def.args).forEach(([name, field]) => {
    args.set(name, columnMeta(name, field, `fn::${def.name}`))
  })

  const returns = def.config.returns
  return {
    args,
    def,
    key,
    name: def.name,
    ...(returns ? { returns: columnMeta("$return", returns, `fn::${def.name}`) } : {}),
  }
}

const isSchemalessMeta = (meta: ModelMeta): meta is SchemalessMeta =>
  "schemaless" in meta && meta.schemaless

function build(entries: SchemaInput): SchemaIndex {
  if (!isObject(entries))
    throw invalid("the schema must be an object of defs and schemaless names.")

  const schemaless = new Map<string, SchemalessMeta>()
  const functions = new Map<string, FunctionMeta>()
  const functionKeysByName = new Map<string, string>()
  const byName = new Map<string, SchemalessMeta | TableMeta>()
  const tableDefs: { def: AnyTableDef; key: string }[] = []
  const relationDefs: { def: AnyRelationDef; key: string }[] = []

  const claim = (name: string, key: string): void => {
    const existing = byName.get(name)
    if (existing) {
      throw invalid(
        `duplicate table name "${name}" — entries "${existing.key}" and "${key}" both declare it. Rename one or drop the duplicate.`,
      )
    }
  }

  // Pass 1 — classify entries, remember defs, claim physical names (tables + schemaless alike).

  Object.entries(entries).forEach(([key, entry]) => {
    if (typeof entry === "string") {
      if (!entry.trim()) {
        throw invalid(
          `entry "${key}" is an empty schemaless name — pass the physical table name, e.g. "${key}": "audit_log".`,
        )
      }
      claim(entry, key)
      const meta: SchemalessMeta = { key, name: entry, schemaless: true }
      schemaless.set(key, meta)
      byName.set(entry, meta)
      return
    }
    if (isTableDefLike(entry)) {
      claim(entry.name, key)
      // Placeholder meta — pass 3 replaces it with the adjacency-carrying one; the name is
      // registered NOW so duplicates + relation endpoints check during pass 1/2.
      byName.set(entry.name, {
        columns: new Map(),
        def: entry,
        edges: [],
        idStrategy: resolveIdStrategy(entry),
        incoming: [],
        key,
        kind: "table",
        links: new Map(),
        name: entry.name,
        outgoing: [],
        uniqueFields: [],
        uniqueGroups: [],
      })
      tableDefs.push({ def: entry, key })
      if (isRelationLike(entry)) relationDefs.push({ def: entry, key })

      return
    }
    if (isFunctionDefLike(entry)) {
      const firstKey = functionKeysByName.get(entry.name)
      if (firstKey !== undefined) {
        throw invalid(
          `duplicate function name "${entry.name}" — entries "${firstKey}" and "${key}".`,
        )
      }
      functionKeysByName.set(entry.name, key)
      functions.set(key, functionMeta(key, entry))
      return
    }
    throw invalid(
      `entry "${key}" is not a table/edge/function or a schemaless name (got ${typeof entry}). Pass the def itself (e.g. table(...)) or a string for a schemaless table.`,
    )
  })

  // Pass 2 — relation adjacency + endpoint validation.
  const adjacency = new Map<string, { incoming: EdgeRef[]; outgoing: EdgeRef[] }>()
  const adjFor = (name: string): { incoming: EdgeRef[]; outgoing: EdgeRef[] } => {
    let a = adjacency.get(name)
    if (!a) {
      a = { incoming: [], outgoing: [] }
      adjacency.set(name, a)
    }
    return a
  }

  relationDefs.forEach(({ def, key }) => {
    const edge: EdgeRef = { def, key, name: def.name }
    const relation = def.config.relation

    ;(
      [
        ["from", relation?.from ?? []],
        ["to", relation?.to ?? []],
      ] as const
    ).forEach(([dir, endpoints]) => {
      endpoints.forEach((endpoint) => {
        const target = byName.get(endpoint)

        if (!target) {
          throw invalid(
            `relation "${def.name}" (.${dir}) points to table "${endpoint}", which no entry declares. Add it to the schema or fix the endpoint.`,
            { table: def.name },
          )
        }

        if (!isSchemalessMeta(target))
          adjFor(target.name)[dir === "from" ? "outgoing" : "incoming"].push(edge)
      })
    })
  })

  // Pass 3 — build table metas (columns/links/adjacency) + reject link/edge name ambiguity.
  const tables = new Map<string, TableMeta>()

  tableDefs.forEach(({ def, key }) => {
    const adj = adjacency.get(def.name) ?? { incoming: [], outgoing: [] }
    const meta = tableMeta(key, def, adj)
    const edgeNames = new Set([
      ...adj.outgoing.map((e) => e.name),
      ...adj.incoming.map((e) => e.name),
    ])

    meta.links.keys().forEach((field) => {
      if (edgeNames.has(field)) {
        throw invalid(
          `"${def.name}" has both a record-link field "${field}" and a relation named "${field}". The field wins — rename one (include/where would otherwise be ambiguous).`,
          { field, table: def.name },
        )
      }
    })
    tables.set(key, meta)
    byName.set(def.name, meta)
  })

  return { byName, functions, schemaless, tables }
}
