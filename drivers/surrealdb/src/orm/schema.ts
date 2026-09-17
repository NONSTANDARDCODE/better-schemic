/**
 * `defineSchema` + the runtime `SchemaIndex` — the ONE metadata pass every `/orm` surface reads:
 * typed tables/edges (columns, record links, graph adjacency), schemaless entries, and DB functions.
 *
 * Built once per schema object (WeakMap-cached) and validated fail-fast, so a bad schema module
 * throws a teaching `SchemaInvalid` at import time instead of failing at the first query. The
 * column metadata is PROJECTED from `inferField` (the shared field walker in `../wire`), so the ORM
 * cannot disagree with the DDL emitter about a field's type, family, optionality or link targets.
 */
import type { z } from "zod";
import { type FieldInfo, inferField } from "../wire";
import { BetterSchemicError } from "./errors";
import type {
  ColumnMeta,
  EdgeRef,
  FunctionMeta,
  LinkMeta,
  ModelMeta,
  RecordLinkMeta,
  SchemaIndex,
  SchemalessMeta,
  TableMeta,
} from "./meta";
import type {
  AnyFunctionDef,
  AnyRelationDef,
  AnyTableDef,
  SchemaDef,
  SchemaInput,
} from "./types/schema";
import { SCHEMA_DEF } from "./types/schema";

// --- schema branding / construction --------------------------------------------------------------

/** Built-index cache — a schema is walked once, no matter how many clients read it. */
const INDEX_CACHE = new WeakMap<object, SchemaIndex>();

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Is this a `defineSchema(...)` artifact (vs. a plain `{ key: def }` literal)? */
export function isSchemaDef(v: unknown): v is SchemaDef {
  return isObject(v) && (v as Record<symbol, unknown>)[SCHEMA_DEF] === true;
}

/**
 * Brand + validate a schema. Validation runs HERE, at module evaluation, so a bad schema fails at
 * import time (with `SchemaInvalid`) instead of at the first query.
 *
 * ```ts
 * export const schema = defineSchema({
 *   users: User, likes: Likes, sendMail, audit: "audit_log",
 * });
 * ```
 */
export function defineSchema<const S extends SchemaInput>(
  entries: S,
): SchemaDef<S> {
  const schema: SchemaDef<S> = { [SCHEMA_DEF]: true, entries };
  buildSchemaIndex(schema);
  return schema;
}

/**
 * Build (or return the cached) {@link SchemaIndex} for a schema — accepts a `defineSchema` artifact
 * OR a plain `{ key: def }` literal (both are supported; the brand just adds eager validation).
 */
export function buildSchemaIndex(input: SchemaDef | SchemaInput): SchemaIndex {
  const cached = INDEX_CACHE.get(input);
  if (cached) return cached;

  const index = build(isSchemaDef(input) ? input.entries : input);
  INDEX_CACHE.set(input, index);
  return index;
}

// --- runtime def detection (duck-typed, so a dual-loaded package still works) --------------------

const isZodLike = (v: unknown): v is z.ZodType =>
  isObject(v) && isObject((v as { _zod?: unknown })._zod);

/** The Zod schema behind a field (an `SField` wrapper or a raw Zod type). */
function schemaOf(v: unknown): z.ZodType {
  if (isObject(v)) {
    const inner = (v as { schema?: unknown }).schema;
    if (isZodLike(inner)) return inner;
  }
  if (isZodLike(v)) return v;
  throw new BetterSchemicError(
    "SchemaInvalid",
    "expected an s.* field or a Zod schema, got a value with no `.schema`.",
  );
}

function isTableDefLike(v: unknown): v is AnyTableDef {
  return (
    isObject(v) &&
    typeof v.name === "string" &&
    typeof v.decode === "function" &&
    typeof v.encode === "function" &&
    isObject(v.object) &&
    isObject((v.object as { shape?: unknown }).shape)
  );
}

function isFunctionDefLike(v: unknown): v is AnyFunctionDef {
  return (
    isObject(v) &&
    v.kind === "function" &&
    typeof v.name === "string" &&
    isObject(v.args)
  );
}

function isRelationLike(def: AnyTableDef): def is AnyRelationDef {
  return def.config.relation !== undefined;
}

// --- index construction --------------------------------------------------------------------------

function invalid(
  message: string,
  options: ConstructorParameters<typeof BetterSchemicError>[2] = {},
): BetterSchemicError {
  return new BetterSchemicError(
    "SchemaInvalid",
    `defineSchema: ${message}`,
    options,
  );
}

function columnMeta(name: string, field: unknown, table: string): ColumnMeta {
  let info: FieldInfo;
  try {
    info = inferField(schemaOf(field));
  } catch (e) {
    throw invalid(
      `field "${name}" of "${table}" has no SurrealQL type — ${(e as Error).message}`,
      { table, field: name, cause: e },
    );
  }
  const record: RecordLinkMeta | undefined = info.record
    ? {
        ...(info.record.targets ? { targets: info.record.targets } : {}),
        list: info.family === "array" || info.family === "set",
        optional: info.optional,
      }
    : undefined;
  return {
    name,
    type: info.type,
    family: info.family,
    optional: info.optional,
    ...(info.element ? { element: info.element } : {}),
    ...(record ? { record } : {}),
  };
}

function tableMeta(
  key: string,
  def: AnyTableDef,
  adjacency: { outgoing: EdgeRef[]; incoming: EdgeRef[] },
): TableMeta {
  const columns = new Map<string, ColumnMeta>();
  const links = new Map<string, LinkMeta>();
  const shape = (def.object as { shape: Record<string, unknown> }).shape;
  for (const [field, zod] of Object.entries(shape)) {
    const meta = columnMeta(field, zod, def.name);
    columns.set(field, meta);
    if (meta.record)
      links.set(field, {
        field,
        ...(meta.record.targets ? { targets: meta.record.targets } : {}),
        cardinality: meta.record.list ? "many" : "one",
        optional: meta.record.optional,
      });
  }

  const relation = isRelationLike(def) ? def.config.relation : undefined;

  return {
    key,
    name: def.name,
    kind: relation ? "relation" : "table",
    def,
    ...(def.singletonId !== undefined ? { singletonId: def.singletonId } : {}),
    columns,
    links,
    outgoing: adjacency.outgoing,
    incoming: adjacency.incoming,
    ...(relation
      ? {
          endpoints: {
            from: [...(relation.from ?? [])],
            to: [...(relation.to ?? [])],
            enforced: relation.enforced === true,
          },
        }
      : {}),
  };
}

function functionMeta(key: string, def: AnyFunctionDef): FunctionMeta {
  const args = new Map<string, ColumnMeta>();
  for (const [name, field] of Object.entries(def.args ?? {}))
    args.set(name, columnMeta(name, field, `fn::${def.name}`));
  const returns = def.config.returns;
  return {
    key,
    name: def.name,
    def,
    args,
    ...(returns
      ? { returns: columnMeta("$return", returns, `fn::${def.name}`) }
      : {}),
  };
}

const isSchemalessMeta = (meta: ModelMeta): meta is SchemalessMeta =>
  "schemaless" in meta && meta.schemaless === true;

function build(entries: SchemaInput): SchemaIndex {
  if (!isObject(entries))
    throw invalid("the schema must be an object of defs and schemaless names.");

  const schemaless = new Map<string, SchemalessMeta>();
  const functions = new Map<string, FunctionMeta>();
  const functionKeysByName = new Map<string, string>();
  const byName = new Map<string, TableMeta | SchemalessMeta>();
  const tableDefs: { key: string; def: AnyTableDef }[] = [];
  const relationDefs: { key: string; def: AnyRelationDef }[] = [];

  const claim = (name: string, key: string) => {
    const existing = byName.get(name);
    if (existing)
      throw invalid(
        `duplicate table name "${name}" — entries "${existing.key}" and "${key}" both declare it. Rename one or drop the duplicate.`,
      );
  };

  // Pass 1 — classify entries, remember defs, claim physical names (tables + schemaless alike).
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry === "string") {
      if (!entry.trim())
        throw invalid(
          `entry "${key}" is an empty schemaless name — pass the physical table name, e.g. "${key}": "audit_log".`,
        );
      claim(entry, key);
      const meta: SchemalessMeta = { key, name: entry, schemaless: true };
      schemaless.set(key, meta);
      byName.set(entry, meta);
      continue;
    }
    if (isTableDefLike(entry)) {
      claim(entry.name, key);
      // Placeholder meta — pass 3 replaces it with the adjacency-carrying one; the name is
      // registered NOW so duplicates + relation endpoints validate during pass 1/2.
      byName.set(entry.name, {
        key,
        name: entry.name,
        kind: "table",
        def: entry,
        columns: new Map(),
        links: new Map(),
        outgoing: [],
        incoming: [],
      });
      tableDefs.push({ key, def: entry });
      if (isRelationLike(entry)) relationDefs.push({ key, def: entry });
      continue;
    }
    if (isFunctionDefLike(entry)) {
      const firstKey = functionKeysByName.get(entry.name);
      if (firstKey !== undefined)
        throw invalid(
          `duplicate function name "${entry.name}" — entries "${firstKey}" and "${key}".`,
        );
      functionKeysByName.set(entry.name, key);
      functions.set(key, functionMeta(key, entry));
      continue;
    }
    throw invalid(
      `entry "${key}" is not a table/edge/function or a schemaless name (got ${typeof entry}). Pass the def itself (e.g. defineTable(...)) or a string for a schemaless table.`,
    );
  }

  // Pass 2 — relation adjacency + endpoint validation.
  const adjacency = new Map<
    string,
    { outgoing: EdgeRef[]; incoming: EdgeRef[] }
  >();
  const adjFor = (name: string) => {
    let a = adjacency.get(name);
    if (!a) {
      a = { outgoing: [], incoming: [] };
      adjacency.set(name, a);
    }
    return a;
  };

  for (const { key, def } of relationDefs) {
    const edge: EdgeRef = { key, name: def.name, def };
    const relation = def.config.relation;
    for (const [dir, endpoints] of [
      ["from", relation?.from ?? []],
      ["to", relation?.to ?? []],
    ] as const) {
      for (const endpoint of endpoints) {
        const target = byName.get(endpoint);
        if (!target)
          throw invalid(
            `relation "${def.name}" (.${dir}) points to table "${endpoint}", which no entry declares. Add it to the schema or fix the endpoint.`,
            { table: def.name },
          );
        if (!isSchemalessMeta(target))
          adjFor(target.name)[dir === "from" ? "outgoing" : "incoming"].push(
            edge,
          );
      }
    }
  }

  // Pass 3 — build table metas (columns/links/adjacency) + reject link/edge name ambiguity.
  const tables = new Map<string, TableMeta>();
  for (const { key, def } of tableDefs) {
    const adj = adjacency.get(def.name) ?? { outgoing: [], incoming: [] };
    const meta = tableMeta(key, def, adj);
    const edgeNames = new Set([
      ...adj.outgoing.map((e) => e.name),
      ...adj.incoming.map((e) => e.name),
    ]);
    for (const field of meta.links.keys())
      if (edgeNames.has(field))
        throw invalid(
          `"${def.name}" has both a record-link field "${field}" and a relation named "${field}". The field wins — rename one (include/where would otherwise be ambiguous).`,
          { table: def.name, field },
        );
    tables.set(key, meta);
    byName.set(def.name, meta);
  }

  return { tables, schemaless, byName, functions };
}
