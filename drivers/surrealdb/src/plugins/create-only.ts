/**
 * `@better-schemic/surrealdb/plugins/create-only` — append-only tables: the `createOnly()` schema
 * PRESET (this file) plus the `createOnlyGuard()` runtime plugin.
 *
 * Both halves share ONE metadata marker (`meta.createOnly`):
 *
 * - **Schema preset** — `createOnly(options?)` narrows the table's permissions with
 *   `FOR update NONE` (the DB barrier for record users; it covers `UPDATE`, the update path of
 *   `UPSERT` and `INSERT … ON DUPLICATE KEY UPDATE`) and stamps `meta.createOnly = true`. With
 *   `hard: true` it also emits a `{table}_create_only` guard event
 *   (`WHEN $event = 'UPDATE' THEN { THROW … }`), which runs even for privileged (root) sessions
 *   and raw SQL.
 * - **Runtime plugin** — `createOnlyGuard(options?)` rejects the update family client-side BEFORE
 *   compiling (`CreateOnlyViolation`, 403) for every tagged table: `update`/`updateMany`/
 *   `updateEach`/`patch`/`upsert`/`upsertDelta`/`upsertMany`, plus `insert`/`insertMany` with
 *   `onDuplicate: "update" | <map>` (they compile `ON DUPLICATE KEY UPDATE`). Untagged tables are
 *   untouched (zero behavior change).
 *
 * `timestamps()` reads the same marker and never stamps `updatedAt` on a create-only table; the
 * `tenant()` preset stamps the marker when `createOnly: true`, so both halves cover it too.
 *
 * ```ts
 * import { createOnly, createOnlyGuard } from "@better-schemic/surrealdb/plugins/create-only";
 *
 * export const AuditLog = defineTable("audit_log", {
 *   action: s.string(),
 *   createdAt: s.datetime().optional(),
 * }).use(createOnly({ hard: true }));
 *
 * const client = betterSchemic(db, { schema, plugins: [timestamps(), createOnlyGuard()] });
 * await client.auditLogs.create({ data: { action: "login" } });
 * // client.auditLogs.update(...) -> CreateOnlyViolation (never reaches the server)
 * ```
 *
 * Boundaries (documented, deliberate): raw SQL (`$raw`/`$query`/`$unsafe`), `$sdk` and edge ops
 * bypass the runtime guard — the DB permission (record users) and the optional hard event (every
 * session, raw included) are the boundary there. `sc pull` cannot recover `meta`, so a pulled
 * schema has no client-side guard (the permission/event persist in the DDL). `softDelete()` is
 * CONTRADICTORY here — a soft delete IS an update, so a delete on a create-only table is rejected
 * once the soft-delete rewrite lands (pick one interpretation).
 */
import { surql } from "../index";
import { describeValue, isPlainObject } from "../orm/compiler/shared";
import { BetterSchemicError } from "../orm/errors";
import { operationFamily } from "../orm/hooks";
import type { SchemaIndex } from "../orm/meta";
import { definePlugin } from "../orm/plugins";
import type { Operation } from "../orm/types/plugins";
import {
  defineTable,
  type PresetEvent,
  type TablePermissions,
  type TablePreset,
} from "../pure";
import {
  CREATE_ONLY_EVENT_TEMPLATE,
  CREATE_ONLY_MARKER,
  type CreateOnlyTag,
  createOnlyTags,
  hasHardGuard,
} from "./create-only-shared";

// --- the schema preset: createOnly(options?) ----------------------------------------------------

/** Options for the `createOnly(...)` preset. */
export interface CreateOnlyPresetOptions {
  /**
   * Also emit a HARD DB barrier: a `{table}_create_only` event that runs
   * `WHEN $event = 'UPDATE' THEN { THROW … }`. Events execute without permission checks, so this
   * blocks privileged (root) sessions and raw SQL too — `$withoutPlugins()` does NOT escape it.
   * Default `false`: `FOR update NONE` (record users) + `createOnlyGuard()` (the client) are the
   * default boundary. Drop/alter the event for a deliberate administrative migration.
   */
  readonly hard?: boolean;
}

/** The hard event's `THROW` message (the DB-level barrier is NOT bypassable from the client). */
const HARD_MESSAGE =
  "createOnly: this table is append-only — UPDATE is not allowed";

/** The hard guard event, shared by every `createOnly({ hard: true })` call. `.use()` interpolates
 *  `{table}` and re-reads it — the object itself is never mutated. */
const HARD_EVENT: PresetEvent = {
  name: CREATE_ONLY_EVENT_TEMPLATE,
  when: surql`$event = 'UPDATE'`,
  // biome-ignore lint/suspicious/noThenProperty: SurrealQL's event THEN clause, not a thenable.
  then: surql`{ THROW ${HARD_MESSAGE}; }`,
};

/** The runtime plugin id (stable — duplicate/collision failures name it). */
const PLUGIN_ID = "@better-schemic/surrealdb/create-only";

/**
 * The create-only (append-only) PRESET: `update` is locked to NONE (per-op **AND**-combined with
 * the table's own permissions — a preset only narrows) and `meta.createOnly = true` is stamped for
 * the runtime guard + `timestamps()`. Optional `hard` adds the DB-level event guard.
 *
 * ```ts
 * const AuditLog = defineTable("audit_log", { action: s.string(), createdAt: s.datetime().optional() })
 *   .use(createOnly());
 * ```
 */
export function createOnly(options: CreateOnlyPresetOptions = {}): TablePreset {
  if (options.hard !== undefined && typeof options.hard !== "boolean")
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/create-only: createOnly() "hard" must be a boolean (got ${describeValue(options.hard)}).`,
    );
  const permissions: TablePermissions = { update: false };
  return defineTable.preset({
    permissions,
    ...(options.hard === true ? { events: [HARD_EVENT] } : {}),
    meta: { [CREATE_ONLY_MARKER]: true },
  });
}

// --- the runtime plugin: createOnlyGuard(options?) ----------------------------------------------

/** Options for the `createOnlyGuard(...)` runtime plugin. */
export interface CreateOnlyGuardOptions {
  /**
   * Extra PHYSICAL table names to treat as create-only, for schemas without the preset (e.g. a
   * pulled schema, whose `meta` markers are not recoverable). Typed tables are validated at
   * bootstrap; schemaless entries are accepted as-is. Tables tagged by `createOnly()` are always
   * included.
   */
  readonly tables?: readonly string[];
}

/** Does this `onDuplicate` compile an `ON DUPLICATE KEY UPDATE` (i.e. can update a row)? The
 *  compiler rejects an all-`undefined` map itself — never mask its teaching error. */
function updatesOnDuplicate(onDuplicate: unknown): boolean {
  if (onDuplicate === "update") return true;
  if (!isPlainObject(onDuplicate)) return false;
  return Object.values(onDuplicate).some((value) => value !== undefined);
}

/** The teaching error for a blocked write. The escape hint is hard-aware: with the
 *  `{table}_create_only` event, `$withoutPlugins()` (and raw SQL) are blocked too. */
function violationError(
  op: Operation,
  hard: boolean,
  what: string,
): BetterSchemicError {
  const hint = hard
    ? 'Use create()/insert({ onDuplicate: "ignore" }) to write; the hard guard event blocks $withoutPlugins() and raw SQL too — drop/alter it for an intentional admin operation.'
    : 'Use create()/insert({ onDuplicate: "ignore" }) to write, or $withoutPlugins() for an intentional admin operation.';
  return new BetterSchemicError(
    "CreateOnlyViolation",
    `createOnlyGuard: "${op.table}" is create-only (append-only) — ${what}. ${hint}`,
    { table: op.table, operation: op.kind },
  );
}

/**
 * The create-only/append-only runtime GUARD. Fail-fast: a tagged table's update-family call throws
 * {@link BetterSchemicError} `CreateOnlyViolation` BEFORE compiling (403), so a buggy update never
 * round-trips. Untagged tables pass through untouched (zero behavior change).
 */
export function createOnlyGuard(options: CreateOnlyGuardOptions = {}) {
  if (options.tables !== undefined && !Array.isArray(options.tables))
    throw new BetterSchemicError(
      "PluginError",
      `createOnlyGuard: "tables" must be an array of physical table names (got ${describeValue(options.tables)}).`,
    );
  const extras: readonly string[] = options.tables ?? [];
  for (const name of extras)
    if (typeof name !== "string" || name.length === 0)
      throw new BetterSchemicError(
        "PluginError",
        `createOnlyGuard: every "tables" entry must be a non-empty physical table name (got ${describeValue(name)}).`,
      );
  /** Per schema index: the tagged physical tables, built at bootstrap (setup) — the transform is a
   *  plain `Map.get`. Keyed by the INDEX (not by plugin instance), so sharing one `createOnlyGuard`
   *  instance across clients with different schemas stays correct. */
  const taggedByIndex = new WeakMap<
    SchemaIndex,
    ReadonlyMap<string, CreateOnlyTag>
  >();

  /** Build + validate the tag map for one schema index (bootstrap, or lazily fail-closed). */
  const buildTags = (
    index: SchemaIndex,
  ): ReadonlyMap<string, CreateOnlyTag> => {
    const tags = new Map(createOnlyTags(index));
    for (const name of extras) {
      const model = index.byName.get(name);
      if (model === undefined)
        throw new BetterSchemicError(
          "SchemaInvalid",
          `createOnlyGuard: "tables" entry "${name}" is not in the schema — add it or drop the entry.`,
          { table: name, operation: "setup" },
        );
      // A schemaless entry cannot declare events — `hard` only comes from typed tables.
      if (!tags.has(name))
        tags.set(name, {
          hard: "def" in model && hasHardGuard(model.def, name),
        });
    }
    return tags;
  };

  return definePlugin({
    id: PLUGIN_ID,
    name: "Create only",
    description:
      "Reject update-family operations on append-only tables (client-side fail-fast).",
    config: { ...options, tables: extras },
    setup({ index }) {
      // Every entry must resolve — a typo fails the bootstrap, not the first write.
      taggedByIndex.set(index, buildTags(index));
    },
    transform(op) {
      let tagged = taggedByIndex.get(op.index);
      if (tagged === undefined) {
        // A client always runs `setup`; this lazy build keeps a hand-built pipeline (and a shared
        // plugin instance across clients) correct instead of silently unguarded.
        tagged = buildTags(op.index);
        taggedByIndex.set(op.index, tagged);
      }
      const tag = tagged.get(op.table);
      if (tag === undefined) return; // untagged table: untouched
      // The whole update family (update/updateMany/updateEach/patch/upsert/upsertDelta/upsertMany).
      if (operationFamily(op.kind) === "update")
        throw violationError(
          op,
          tag.hard,
          `operation "${op.kind}" is an UPDATE`,
        );
      // `insert … ON DUPLICATE KEY UPDATE` is an update wearing a create's clothes.
      if (
        (op.kind === "insert" || op.kind === "insertMany") &&
        updatesOnDuplicate(op.args.onDuplicate)
      )
        throw violationError(
          op,
          tag.hard,
          `insert with onDuplicate ${describeValue(op.args.onDuplicate)} can UPDATE an existing record`,
        );
      // create / read / delete / relate are allowed: create-only = immutable rows, not tombstones.
    },
  });
}
