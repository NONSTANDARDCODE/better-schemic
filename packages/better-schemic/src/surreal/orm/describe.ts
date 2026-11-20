/**
 * `describeSchema()` — a structured, agent-readable description of an authored schema.
 *
 * It is a PURE derivation over the existing `SchemaIndex` plus the authoring defs it already holds:
 * no DDL, no database round-trip, no Zod leaking out. Every value is JSON-safe (BoundQuery
 * expressions are rendered as their SurrealQL text), so the result can be handed to an LLM, logged,
 * or checked into a repo as the machine-readable companion to the TypeScript schema.
 *
 * Plugin markers authored under `TableConfig.meta` (tenant, create-only, …) are included as opaque
 * tags — they are part of the contract an agent must respect, even though the DB never sees them.
 */
import type { AnyField, SurrealMeta, TableConfig } from "../pure";
import type {
  ColumnMeta,
  FieldFamily,
  RecordLinkMeta,
  ResolvedIdStrategy,
  SchemaIndex,
} from "./meta";
import { buildSchemaIndex } from "./schema";
import type { AnyTableDef, SchemaDef, SchemaInput } from "./types/schema";

/** One field of a table/edge, in plain data. */
export interface FieldDescriptor {
  readonly name: string;
  /** The SurrealQL wire type (`inferField` output, e.g. `option<int>`, `record<user>`). */
  readonly type: string;
  readonly family: FieldFamily;
  readonly optional: boolean;
  readonly element?: FieldFamily;
  readonly record?: RecordLinkMeta;
  /** ASSERT expressions, rendered as SurrealQL text. */
  readonly asserts: readonly string[];
  /** DEFAULT / VALUE / COMPUTED expressions, rendered as SurrealQL text. */
  readonly default?: string;
  readonly defaultAlways?: boolean;
  readonly value?: string;
  readonly computed?: string;
  readonly readonly?: boolean;
  readonly internal?: boolean;
  readonly comment?: string;
  readonly permissions?: unknown;
  readonly index?: unknown;
  readonly reference?: unknown;
}

/** One table, edge or schemaless entry. */
export interface TableDescriptor {
  readonly key: string;
  readonly name: string;
  readonly kind: "table" | "relation" | "schemaless";
  readonly schemafull: boolean;
  readonly type?: "normal" | "any";
  readonly idStrategy?: ResolvedIdStrategy;
  readonly singletonId?: string;
  readonly columns: readonly FieldDescriptor[];
  readonly links: readonly {
    field: string;
    targets?: readonly string[];
    cardinality: "one" | "many";
    optional: boolean;
  }[];
  readonly edges: readonly {
    key: string;
    name: string;
    direction: "out" | "in";
  }[];
  readonly endpoints?: {
    from: readonly string[];
    to: readonly string[];
    enforced: boolean;
  };
  readonly uniqueFields: readonly string[];
  readonly uniqueGroups: readonly (readonly string[])[];
  /** Indexes/events/permissions/meta, normalized to plain JSON-safe data. */
  readonly indexes: unknown;
  readonly events: unknown;
  readonly permissions: unknown;
  readonly comment?: string;
  /** Opaque plugin tags (`meta.tenant`, `meta.createOnly`, …) — contract, not DDL. */
  readonly meta?: unknown;
}

/** One authored database function. */
export interface FunctionDescriptor {
  readonly key: string;
  readonly name: string;
  readonly args: readonly {
    name: string;
    type: string;
    family: FieldFamily;
    optional: boolean;
  }[];
  readonly returns?: { type: string; family: FieldFamily };
  readonly permissions: unknown;
  readonly comment?: string;
}

/** The complete machine-readable schema description. */
export interface SchemaDescriptor {
  readonly version: 1;
  readonly tables: readonly TableDescriptor[];
  readonly schemaless: readonly { key: string; name: string }[];
  readonly functions: readonly FunctionDescriptor[];
}

/** Convert a BoundQuery / Zod-ish / nested value into plain JSON-safe data. */
function plain(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (value === undefined || typeof value === "function") return undefined;
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => plain(item) ?? null);
  if (typeof value === "object") {
    // BoundQuery and other expression carriers expose `.query` as their SurrealQL text.
    const text = (value as { query?: unknown }).query;
    if (typeof text === "string") return text;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = plain(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

/** Render an expression (string or BoundQuery) as SurrealQL text. */
function expr(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const text = (value as { query?: unknown }).query;
  return typeof text === "string" ? text : undefined;
}

function describeColumn(
  name: string,
  column: ColumnMeta,
  field?: AnyField,
): FieldDescriptor {
  const meta = field?.surreal as SurrealMeta | undefined;
  return {
    name,
    type: column.type,
    family: column.family,
    optional: column.optional,
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
  };
}

function describeTable(
  key: string,
  def: AnyTableDef,
  index: SchemaIndex,
): TableDescriptor {
  const meta = index.tables.get(key);
  const config = def.config as TableConfig;
  const fields = def.fields ?? {};
  return {
    key,
    name: def.name,
    kind: def.kind,
    schemafull: config.schemafull,
    ...(config.type ? { type: config.type } : {}),
    ...(meta?.idStrategy ? { idStrategy: meta.idStrategy } : {}),
    ...(meta?.singletonId ? { singletonId: meta.singletonId } : {}),
    columns: Object.entries(fields).map(([name, field]) =>
      describeColumn(
        name,
        meta?.columns.get(name) ?? {
          name,
          type: "unknown",
          family: "any",
          optional: false,
        },
        field,
      ),
    ),
    links: [...(meta?.links?.values() ?? [])].map((link) => ({
      field: link.field,
      ...(link.targets ? { targets: link.targets } : {}),
      cardinality: link.cardinality,
      optional: link.optional,
    })),
    edges: [
      ...(meta?.outgoing ?? []).map((edge) => ({
        key: edge.key,
        name: edge.name,
        direction: "out" as const,
      })),
      ...(meta?.incoming ?? []).map((edge) => ({
        key: edge.key,
        name: edge.name,
        direction: "in" as const,
      })),
    ],
    ...(meta?.endpoints
      ? {
          endpoints: {
            from: meta.endpoints.from,
            to: meta.endpoints.to,
            enforced: meta.endpoints.enforced,
          },
        }
      : {}),
    uniqueFields: meta?.uniqueFields ?? [],
    uniqueGroups: meta?.uniqueGroups ?? [],
    indexes: plain(config.indexes ?? []),
    events: plain(config.events ?? []),
    permissions: plain(config.permissions ?? {}),
    ...(config.comment ? { comment: config.comment } : {}),
    ...(config.meta ? { meta: plain(config.meta) } : {}),
  };
}

/**
 * Describe an authored schema (a branded `schema(...)` artifact or a plain key→def object) in one
 * JSON-safe object. No DDL is emitted and the database is never contacted.
 */
export function describeSchema(
  input: SchemaDef | SchemaInput,
): SchemaDescriptor {
  const index: SchemaIndex = buildSchemaIndex(input);
  const tables: TableDescriptor[] = [];
  const schemaless: { key: string; name: string }[] = [];
  for (const [key, meta] of index.tables)
    tables.push(describeTable(key, meta.def as AnyTableDef, index));
  for (const [key, meta] of index.schemaless)
    schemaless.push({ key, name: meta.name });

  const functions: FunctionDescriptor[] = [];
  for (const [key, fn] of index.functions) {
    const config =
      (fn.def as unknown as { config?: Record<string, unknown> }).config ?? {};
    functions.push({
      key,
      name: fn.name,
      args: [...fn.args.values()].map((arg) => ({
        name: arg.name,
        type: arg.type,
        family: arg.family,
        optional: arg.optional,
      })),
      ...(fn.returns
        ? { returns: { type: fn.returns.type, family: fn.returns.family } }
        : {}),
      permissions: plain(config.permissions ?? {}),
      ...(typeof config.comment === "string"
        ? { comment: config.comment }
        : {}),
    });
  }

  return { version: 1, tables, schemaless, functions };
}
