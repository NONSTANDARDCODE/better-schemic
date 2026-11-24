/**
 * `describeSchema()` — a structured, agent-readable description of an authored schema.
 *
 * it's a PURE derivation over the existing `SchemaIndex` plus the authoring defs it already holds:
 * no DDL, no database round-trip, no Zod leaking out. Every value is JSON-safe (BoundQuery
 * expressions render them as their SurrealQL text), so the result can hands it to an LLM, logged,
 * or checked into a repo as the machine-readable companion to the TypeScript schema.
 *
 * Plugin markers authored under `TableConfig.meta` (tenant, create-, …) include them as opaque
 * tags — they are part of the contract an agent must respect, even though the DB never sees them.
 */
import type { AnyField } from "../pure"

import type {
  ColumnMeta,
  FieldFamily,
  RecordLinkMeta,
  ResolvedIdStrategy,
  SchemaIndex,
} from "./meta"
import { buildSchemaIndex } from "./schema"
import { stringCoerce } from "./text"
import type { AnyTableDef, SchemaDef, SchemaInput } from "./types/schema"

/** One field of a table/edge, in plain data. */
export type FieldDescriptor = {
  /** ASSERT expressions, rendered as SurrealQL text. */
  readonly asserts: readonly string[]
  readonly comment?: string
  readonly computed?: string
  /** DEFAULT / VALUE / COMPUTED expressions, rendered as SurrealQL text. */
  readonly default?: string
  readonly defaultAlways?: boolean
  readonly element?: FieldFamily
  readonly family: FieldFamily
  readonly index?: unknown
  readonly internal?: boolean
  readonly name: string
  readonly optional: boolean
  readonly permissions?: unknown
  readonly readonly?: boolean
  readonly record?: RecordLinkMeta
  readonly reference?: unknown
  /** The SurrealQL wire type (`inferField` output, e.g. `option<int>`, `record<user>`). */
  readonly type: string
  readonly value?: string
}

/** One table, edge or schemaless entry. */
export type TableDescriptor = {
  readonly columns: readonly FieldDescriptor[]
  readonly comment?: string
  readonly edges: readonly {
    direction: "in" | "out"
    key: string
    name: string
  }[]
  readonly endpoints?: {
    enforced: boolean
    from: readonly string[]
    to: readonly string[]
  }
  readonly events: unknown
  readonly idStrategy?: ResolvedIdStrategy
  /** Indexes/events/permissions/meta, normalized to plain JSON-safe data. */
  readonly indexes: unknown
  readonly key: string
  readonly kind: "relation" | "schemaless" | "table"
  readonly links: readonly {
    cardinality: "many" | "one"
    field: string
    optional: boolean
    targets?: readonly string[]
  }[]
  /** Opaque plugin tags (`meta.tenant`, `meta.createOnly`, …) — contract, not DDL. */
  readonly meta?: unknown
  readonly name: string
  readonly permissions: unknown
  readonly schemafull: boolean
  readonly singletonId?: string
  readonly type?: "any" | "normal"
  readonly uniqueFields: readonly string[]
  readonly uniqueGroups: readonly (readonly string[])[]
}

/** One authored database function. */
export type FunctionDescriptor = {
  readonly args: readonly {
    family: FieldFamily
    name: string
    optional: boolean
    type: string
  }[]
  readonly comment?: string
  readonly key: string
  readonly name: string
  readonly permissions: unknown
  readonly returns?: { family: FieldFamily; type: string }
}

/** The complete machine-readable schema description. */
export type SchemaDescriptor = {
  readonly functions: readonly FunctionDescriptor[]
  readonly schemaless: readonly { key: string; name: string }[]
  readonly tables: readonly TableDescriptor[]
  readonly version: 1
}

/** Convert a BoundQuery / Zod-ish / nested value into plain JSON-safe data. */
function plain(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value

  if (value === undefined || typeof value === "function") return undefined

  if (typeof value === "bigint") return String(value)

  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) return value.map((item) => plain(item) ?? null)

  if (typeof value === "object") {
    // BoundQuery and other expression carriers expose `.query` as their SurrealQL text.
    const text = (value as { query?: unknown }).query
    if (typeof text === "string") return text

    const out: Record<string, unknown> = {}

    Object.entries(value).forEach(([key, item]) => {
      const normalized = plain(item)
      if (normalized !== undefined) out[key] = normalized
    })
    return out
  }

  return stringCoerce(value)
}

/** Render an expression (string or BoundQuery) as SurrealQL text. */
function expr(value: unknown): string | undefined {
  if (value === undefined) return undefined

  if (typeof value === "string") return value

  const text = (value as { query?: unknown }).query
  return typeof text === "string" ? text : undefined
}

function describeColumn(name: string, column: ColumnMeta, field?: AnyField): FieldDescriptor {
  const meta = field?.surreal
  return {
    family: column.family,
    name,
    optional: column.optional,
    type: column.type,
    ...(column.element ? { element: column.element } : {}),
    ...(column.record ? { record: column.record } : {}),
    asserts: (meta?.asserts ?? [])
      .map((assertion) => expr(assertion))
      .filter((text): text is string => text !== undefined),
    ...(meta?.default ? { default: expr(meta.default) } : {}),
    ...(meta?.defaultAlways ? { defaultAlways: true } : {}),
    ...(meta?.value ? { value: expr(meta.value) } : {}),
    ...(meta?.computed ? { computed: expr(meta.computed) } : {}),
    ...(meta?.readonly ? { readonly: true } : {}),
    ...(meta?.internal ? { internal: true } : {}),
    ...(meta?.comment ? { comment: meta.comment } : {}),
    ...(meta?.permissions ? { permissions: plain(meta.permissions) } : {}),
    ...(meta?.index ? { index: plain(meta.index) } : {}),
    ...(meta?.reference ? { reference: plain(meta.reference) } : {}),
  }
}

function describeTable(key: string, def: AnyTableDef, index: SchemaIndex): TableDescriptor {
  const meta = index.tables.get(key)
  const config = def.config
  const fields = def.fields
  return {
    key,
    kind: def.kind,
    name: def.name,
    schemafull: config.schemafull,
    ...(config.type ? { type: config.type } : {}),
    ...(meta?.idStrategy ? { idStrategy: meta.idStrategy } : {}),
    ...(meta?.singletonId ? { singletonId: meta.singletonId } : {}),
    columns: Object.entries(fields).map(([name, field]) =>
      describeColumn(
        name,
        meta?.columns.get(name) ?? {
          family: "any",
          name,
          optional: false,
          type: "unknown",
        },
        field,
      ),
    ),
    edges: [
      ...(meta?.outgoing ?? []).map((edge) => ({
        direction: "out" as const,
        key: edge.key,
        name: edge.name,
      })),
      ...(meta?.incoming ?? []).map((edge) => ({
        direction: "in" as const,
        key: edge.key,
        name: edge.name,
      })),
    ],

    links: [...(meta?.links.values() ?? [])].map((link) => ({
      field: link.field,
      ...(link.targets ? { targets: link.targets } : {}),
      cardinality: link.cardinality,
      optional: link.optional,
    })),
    ...(meta?.endpoints
      ? {
          endpoints: {
            enforced: meta.endpoints.enforced,
            from: meta.endpoints.from,
            to: meta.endpoints.to,
          },
        }
      : {}),
    events: plain(config.events ?? []),
    indexes: plain(config.indexes ?? []),
    permissions: plain(config.permissions ?? {}),
    uniqueFields: meta?.uniqueFields ?? [],
    uniqueGroups: meta?.uniqueGroups ?? [],
    ...(config.comment ? { comment: config.comment } : {}),
    ...(config.meta ? { meta: plain(config.meta) } : {}),
  }
}

/**
 * Describe an authored schema (a branded `schema(...)` artifact or a plain key→def object) in one
 * JSON-safe object. No DDL emits it and the database is never contacted.
 */
export function describeSchema(input: SchemaDef | SchemaInput): SchemaDescriptor {
  const index: SchemaIndex = buildSchemaIndex(input)
  const tables: TableDescriptor[] = []
  const schemaless: { key: string; name: string }[] = []

  ;[...index.tables].forEach(([key, meta]) => tables.push(describeTable(key, meta.def, index)))

  ;[...index.schemaless].forEach(([key, meta]) => schemaless.push({ key, name: meta.name }))

  const functions: FunctionDescriptor[] = []

  ;[...index.functions].forEach(([key, fn]) => {
    const config = (fn.def as unknown as { config?: Record<string, unknown> }).config ?? {}
    functions.push({
      args: [...fn.args.values()].map((arg) => ({
        family: arg.family,
        name: arg.name,
        optional: arg.optional,
        type: arg.type,
      })),
      key,
      name: fn.name,
      ...(fn.returns ? { returns: { family: fn.returns.family, type: fn.returns.type } } : {}),
      permissions: plain(config.permissions ?? {}),
      ...(typeof config.comment === "string" ? { comment: config.comment } : {}),
    })
  })

  return { functions, schemaless, tables, version: 1 }
}
