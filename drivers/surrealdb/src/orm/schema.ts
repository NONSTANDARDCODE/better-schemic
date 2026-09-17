/**
 * `defineSchema` + the runtime `SchemaIndex` — the ONE metadata pass every `/orm` surface reads:
 * typed tables/edges (columns, record links, graph adjacency), schemaless entries, and DB functions.
 *
 * Built once per schema object (WeakMap-cached) and validated fail-fast, so a bad schema module
 * throws a teaching `SchemaInvalid` at import time instead of failing at the first query. The
 * column metadata is derived from `inferField` (the DDL emitter's own walker), so the ORM can never
 * disagree with the schema engine about a field's SurrealQL wire type.
 */
import type { z } from "zod";
import { inferField } from "../ddl";
import { BetterSchemicError } from "./errors";
import type {
  AnyFunctionDef,
  AnyRelationDef,
  AnyTableDef,
  SchemaDef,
  SchemaInput,
} from "./types/schema";

// --- metadata types ------------------------------------------------------------------------------

/** The operator family a column belongs to — drives `where` typing and identifier validation. */
export type FieldFamily =
  | "string"
  | "number"
  | "bool"
  | "date"
  | "duration"
  | "bytes"
  | "record"
  | "geometry"
  | "object"
  | "array"
  | "set"
  | "any"
  | "other";

/** Record-link metadata of a column (itself, or its array/set element). */
export interface RecordLinkMeta {
  /** Target table names (`undefined` = a bare `record`, i.e. any table). */
  readonly targets?: readonly string[];
  /** True when the link lives inside an `array<…>`/`set<…>`. */
  readonly list: boolean;
  readonly optional: boolean;
}

/** One public column of a table/edge — wire type + family + link metadata, no Zod leaking out. */
export interface ColumnMeta {
  readonly name: string;
  /** The SurrealQL wire type, exactly as `inferField` (the DDL emitter) reports it. */
  readonly type: string;
  readonly family: FieldFamily;
  readonly optional: boolean;
  /** Array/set element family (only for `array`/`set`). */
  readonly element?: FieldFamily;
  /** Present when the column is (or contains) a record link. */
  readonly record?: RecordLinkMeta;
}

/** A record-link column, ready for `include`/`where` relational lowering. */
export interface LinkMeta {
  readonly field: string;
  /** Target table names (`undefined` = any table). */
  readonly targets?: readonly string[];
  readonly cardinality: "one" | "many";
  readonly optional: boolean;
}

/** A graph edge adjacent to a table, as seen from that table. */
export interface EdgeRef {
  readonly key: string;
  readonly name: string;
  readonly def: AnyRelationDef;
}

/** A relation's declared endpoints (physical names) + whether RELATE enforces them. */
export interface RelationEndpoints {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly enforced: boolean;
}

/** Runtime metadata for one typed table/edge. */
export interface TableMeta {
  /** The schema key (`client.<key>`). */
  readonly key: string;
  /** The physical table name. */
  readonly name: string;
  readonly kind: "table" | "relation";
  readonly def: AnyTableDef;
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string;
  /** Public columns (internal `$internal()` fields are excluded). */
  readonly columns: ReadonlyMap<string, ColumnMeta>;
  /** The subset of `columns` that are record links (single or array). */
  readonly links: ReadonlyMap<string, LinkMeta>;
  /** Edges whose `FROM` includes this table. */
  readonly outgoing: readonly EdgeRef[];
  /** Edges whose `TO` includes this table. */
  readonly incoming: readonly EdgeRef[];
  /** Only for `kind: "relation"`. */
  readonly endpoints?: RelationEndpoints;
}

/** Runtime metadata for a `string` schema entry (a schemaless table). */
export interface SchemalessMeta {
  readonly key: string;
  readonly name: string;
  readonly schemaless: true;
}

/** Runtime metadata for a `FunctionDef` schema entry. */
export interface FunctionMeta {
  readonly key: string;
  /** The bare function name (`fn::<name>` when called). */
  readonly name: string;
  readonly def: AnyFunctionDef;
  readonly args: ReadonlyMap<string, ColumnMeta>;
  readonly returns?: ColumnMeta;
}

/** The complete, validated metadata pass over a schema. */
export interface SchemaIndex<S extends SchemaInput = SchemaInput> {
  readonly schema: SchemaDef<S>;
  /** Typed tables/edges by schema key. */
  readonly tables: ReadonlyMap<string, TableMeta>;
  /** Schemaless entries by schema key. */
  readonly schemaless: ReadonlyMap<string, SchemalessMeta>;
  /** Typed + schemaless entries by PHYSICAL name (for `repository(name)` / endpoint checks). */
  readonly byName: ReadonlyMap<string, TableMeta | SchemalessMeta>;
  /** User-defined functions by schema key. */
  readonly functions: ReadonlyMap<string, FunctionMeta>;
}

// --- schema branding / construction --------------------------------------------------------------

/** Runtime brand distinguishing a `defineSchema` artifact from a plain literal. */
const SCHEMA_DEF: unique symbol = Symbol.for(
  "@better-schemic/surrealdb.schema",
);

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
  const schema = {
    [SCHEMA_DEF]: true,
    entries,
  } as unknown as SchemaDef<S>;
  buildSchemaIndex(schema);
  return schema;
}

/**
 * Build (or return the cached) {@link SchemaIndex} for a schema — accepts a `defineSchema` artifact
 * OR a plain `{ key: def }` literal (both are supported; the brand just adds eager validation).
 */
export function buildSchemaIndex<S extends SchemaInput>(
  input: SchemaDef<S> | S,
): SchemaIndex<S> {
  const schema: SchemaDef<S> = isSchemaDef(input)
    ? (input as SchemaDef<S>)
    : ({
        [SCHEMA_DEF]: true,
        entries: input,
      } as unknown as SchemaDef<S>);

  const cached = INDEX_CACHE.get(schema);
  if (cached) return cached as unknown as SchemaIndex<S>;

  const index = build(schema);
  INDEX_CACHE.set(schema, index as SchemaIndex);
  return index;
}

// --- runtime def detection (duck-typed, so a dual-loaded package still works) --------------------

interface FieldLike {
  readonly schema: unknown;
}

const isZodLike = (v: unknown): v is z.ZodType =>
  isObject(v) && isObject((v as { _zod?: unknown })._zod);

/** The Zod schema behind a field (an `SField` wrapper or a raw Zod type). */
function schemaOf(v: unknown): z.ZodType {
  if (isObject(v) && "schema" in v) {
    const inner = (v as FieldLike).schema;
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
  return isObject((def.config as { relation?: unknown }).relation);
}

// --- SurrealQL type-string classification --------------------------------------------------------

/** Split on `sep` at top level only — respecting `<…>`/`[…]` depth and quoted literals. */
function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote && input[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "<" || ch === "[") depth++;
    else if (ch === ">" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

/** Is the inside of a wrapper balanced (no dangling `>` at this level)? */
function isBalanced(inner: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote && inner[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "<" || ch === "[") depth++;
    else if (ch === ">" || ch === "]") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** The content of `kw<…>` when it wraps the WHOLE type, else `undefined`. */
function unwrapType(type: string, kw: string): string | undefined {
  const prefix = `${kw}<`;
  if (!type.startsWith(prefix) || !type.endsWith(">")) return undefined;
  const inner = type.slice(prefix.length, -1);
  return isBalanced(inner) ? inner : undefined;
}

const GEOMETRY_TYPES = new Set([
  "geometry",
  "point",
  "line",
  "polygon",
  "multipoint",
  "multiline",
  "multipolygon",
  "collection",
]);

interface ClassifiedType {
  readonly family: FieldFamily;
  readonly optional: boolean;
  readonly element?: FieldFamily;
  readonly record?: RecordLinkMeta;
}

/** Classify one SurrealQL atom (no union/null/option wrappers at this level). */
function classifyAtom(atom: string): ClassifiedType {
  if (atom === "string" || atom === "uuid")
    return { family: "string", optional: false };
  if (
    atom === "int" ||
    atom === "float" ||
    atom === "number" ||
    atom === "decimal"
  )
    return { family: "number", optional: false };
  if (atom === "bool") return { family: "bool", optional: false };
  if (atom === "datetime") return { family: "date", optional: false };
  if (atom === "duration") return { family: "duration", optional: false };
  if (atom === "bytes") return { family: "bytes", optional: false };
  if (atom === "object") return { family: "object", optional: false };
  if (atom === "any") return { family: "any", optional: false };
  if (GEOMETRY_TYPES.has(atom)) return { family: "geometry", optional: false };
  if (atom === "record")
    return {
      family: "record",
      optional: false,
      record: { list: false, optional: false },
    };
  if (/^'[\s\S]*'$/.test(atom) || /^"[\s\S]*"$/.test(atom))
    return { family: "string", optional: false };
  if (/^-?\d+(?:\.\d+)?$/.test(atom))
    return { family: "number", optional: false };
  if (atom === "true" || atom === "false")
    return { family: "bool", optional: false };
  return { family: "other", optional: false };
}

/** Classify a full `inferField` type string (`option<array<record<user>>>`, `'a' | 'b'`, …). */
export function classifyWireType(type: string): ClassifiedType {
  let optional = false;
  let cur = type.trim();

  const optInner = unwrapType(cur, "option");
  if (optInner !== undefined) {
    optional = true;
    cur = optInner.trim();
  }

  const atoms = splitTopLevel(cur, "|")
    .map((a) => a.trim())
    .filter(Boolean);

  if (atoms.length > 1) {
    const nonNull = atoms.filter((a) => a !== "null");
    if (nonNull.length !== atoms.length) optional = true;
    if (nonNull.length === 0) return { family: "other", optional };
    if (nonNull.length === 1) cur = nonNull[0];
    else {
      const classified = nonNull.map(classifyAtomOrWrapper);
      const families = new Set(classified.map((c) => c.family));
      const atomOptional = classified.some((c) => c.optional);
      const merged = optional || atomOptional;
      if (families.size === 1) {
        const family = classified[0].family;
        if (family === "record") {
          const targets = mergeTargets(classified.map((c) => c.record));
          return {
            family,
            optional: merged,
            record: {
              ...(targets ? { targets } : {}),
              list: false,
              optional: merged,
            },
          };
        }
        return { family, optional: merged };
      }
      return { family: "other", optional: merged };
    }
  }

  const leaf = classifyAtomOrWrapper(cur);
  const merged = optional || leaf.optional;
  return {
    family: leaf.family,
    optional: merged,
    ...(leaf.element ? { element: leaf.element } : {}),
    ...(leaf.record ? { record: { ...leaf.record, optional: merged } } : {}),
  };
}

/** Classify an atom that may itself be a wrapper (`record<…>` / `array<…>` / `set<…>` / `geometry<…>`). */
function classifyAtomOrWrapper(atom: string): ClassifiedType {
  const recInner = unwrapType(atom, "record");
  if (recInner !== undefined) {
    const targets = splitTopLevel(recInner, "|")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      family: "record",
      optional: false,
      record: {
        ...(targets.length ? { targets } : {}),
        list: false,
        optional: false,
      },
    };
  }

  for (const kw of ["array", "set"] as const) {
    const inner = unwrapType(atom, kw);
    if (inner === undefined) continue;
    // `array<T, N>` — N is an exact size; classify the element only.
    const elemType = splitTopLevel(inner, ",")[0].trim();
    const elem = classifyWireType(elemType);
    return {
      family: kw,
      optional: false,
      element: elem.family,
      ...(elem.record ? { record: { ...elem.record, list: true } } : {}),
    };
  }

  const geoInner = unwrapType(atom, "geometry");
  if (geoInner !== undefined) return { family: "geometry", optional: false };

  if (atom.startsWith("[")) return { family: "other", optional: false };

  return classifyAtom(atom);
}

function mergeTargets(
  links: (RecordLinkMeta | undefined)[],
): string[] | undefined {
  const present = links.filter(
    (l): l is RecordLinkMeta => l?.targets !== undefined,
  );
  if (present.length !== links.length) return undefined; // any bare `record` -> any table
  return [...new Set(present.flatMap((l) => l.targets ?? []))];
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
  let wireType: string;
  try {
    wireType = inferField(schemaOf(field)).type;
  } catch (e) {
    throw invalid(
      `field "${name}" of "${table}" has no SurrealQL type — ${(e as Error).message}`,
      { table, field: name, cause: e },
    );
  }
  const classified = classifyWireType(wireType);
  return {
    name,
    type: wireType,
    family: classified.family,
    optional: classified.optional,
    ...(classified.element ? { element: classified.element } : {}),
    ...(classified.record ? { record: classified.record } : {}),
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

  const relation = isRelationLike(def)
    ? (
        def.config as {
          relation?: { from?: string[]; to?: string[]; enforced?: boolean };
        }
      ).relation
    : undefined;

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

const isSchemalessMeta = (
  meta: TableMeta | SchemalessMeta,
): meta is SchemalessMeta => "schemaless" in meta && meta.schemaless === true;

function build<S extends SchemaInput>(schema: SchemaDef<S>): SchemaIndex<S> {
  const entries = schema.entries;
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
    const relation = (
      def.config as {
        relation?: { from?: string[]; to?: string[]; enforced?: boolean };
      }
    ).relation;
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

  return {
    schema,
    tables,
    schemaless,
    byName,
    functions,
  };
}
