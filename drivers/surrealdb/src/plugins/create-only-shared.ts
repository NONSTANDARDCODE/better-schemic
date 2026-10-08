/**
 * Shared helpers of the `plugins/create-only` preset + runtime — the ONE `meta.createOnly` marker
 * (also read by `timestamps()` and stamped by the `tenant()` preset when `createOnly: true`) plus
 * the per-index tags of the create-only tables (built once per `SchemaIndex`).
 *
 * The marker is OPAQUE to the engine: it emits no DDL, never enters a snapshot, and the
 * diff/introspection engines ignore it — the runtime reads it back through `TableMeta.def.config.meta`.
 */
import type { SchemaIndex } from "../orm/meta";
import type { AnyTableDef } from "../orm/types/schema";

/** The `TableConfig.meta` key the create-only marker lives under (`true` = append-only). */
export const CREATE_ONLY_MARKER = "createOnly";

/** The hard guard event name TEMPLATE — the `{table}` placeholder `.use()` interpolates. */
export const CREATE_ONLY_EVENT_TEMPLATE = "{table}_create_only";

/** One create-only table's resolved tag. */
export interface CreateOnlyTag {
  /** The table declares the hard `{table}_create_only` UPDATE guard event
   *  (`createOnly({ hard: true })`) — the escape hatch is DROP/ALTER, never `$withoutPlugins()`. */
  readonly hard: boolean;
}

/** The concrete hard guard event name of a physical table. */
function createOnlyEventName(table: string): string {
  return CREATE_ONLY_EVENT_TEMPLATE.replace("{table}", table);
}

/** Read the marker off a table def (`true` only for the exact literal — a marker, never a value). */
export function isCreateOnlyDef(def: AnyTableDef): boolean {
  return def.config.meta?.[CREATE_ONLY_MARKER] === true;
}

/** Does `def` declare the hard `{table}_create_only` UPDATE guard event? */
export function hasHardGuard(def: AnyTableDef, table: string): boolean {
  const expected = createOnlyEventName(table);
  return (def.config.events ?? []).some((event) => event.name === expected);
}

/**
 * Per-index cache: the tagged PHYSICAL tables, built once per `SchemaIndex`. A `WeakMap` keyed by
 * the index keeps a shared plugin instance correct across schemas; the transform hot path is one
 * `Map.get` (no per-operation allocation).
 */
const cache = new WeakMap<SchemaIndex, ReadonlyMap<string, CreateOnlyTag>>();

/** The create-only tables of `index` (physical name -> tag), cached per index. */
export function createOnlyTags(
  index: SchemaIndex,
): ReadonlyMap<string, CreateOnlyTag> {
  const cached = cache.get(index);
  if (cached !== undefined) return cached;
  const tags = new Map<string, CreateOnlyTag>();
  for (const meta of index.tables.values())
    if (isCreateOnlyDef(meta.def))
      tags.set(meta.name, { hard: hasHardGuard(meta.def, meta.name) });
  cache.set(index, tags);
  return tags;
}
