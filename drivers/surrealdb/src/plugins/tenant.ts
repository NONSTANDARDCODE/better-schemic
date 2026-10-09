/**
 * `@better-schemic/surrealdb/plugins/tenant` — row-level tenant isolation: the `tenant()` schema
 * PRESET (this file) plus the `tenantRls()` runtime plugin (re-exported from `./tenant-runtime`).
 *
 * Both halves share ONE metadata marker (`meta.tenant`):
 *
 * - **Schema preset** — `tenant(userTable, options?)` stamps the tenant column
 *   (`record<user> DEFAULT $auth.id ASSERT $value != NONE READONLY`), per-op permissions
 *   (`tenant_id = $auth.id`, with the soft-delete tombstone clause), the
 *   `{table}_protect_tenant_id` guard event and the tenant indexes. It composes through
 *   `defineTable(…).use(tenant(userTable))` like any preset (AND-narrowing permissions, typed column).
 * - **Runtime plugin** — `tenantRls(options?)` enforces the same scope client-side, for PRIVILEGED
 *   sessions where `$auth`/permissions do not filter. It requires a scope for every tenant-tagged
 *   table (fail-closed), injects it into writes, AND-combines it into every read/update/delete
 *   (including `findUnique`'s id/unique targets, through the compiler `scope` channel), and exposes
 *   `$forTenant("user:abc")`.
 *
 * ```ts
 * import { tenant, tenantRls } from "@better-schemic/surrealdb/plugins/tenant";
 *
 * export const Customer = defineTable("customer", { name: s.string(), deletedAt: s.datetime().optional() })
 *   .use(tenant(User, { softDelete: true }));
 *
 * const client = betterSchemic(db, {
 *   schema: defineSchema({ customers: Customer }),
 *   plugins: [tenantRls({ tenant: () => ctx.tenantId })],
 * });
 * await client.customers.$forTenant("user:abc").findMany({});
 * ```
 *
 * Boundaries (documented, deliberate): edges (`relate`/`unrelate`), `live`, `changes` (changefeed),
 * raw SQL (`$raw`/`$query`/`$unsafe`) and `$withoutPlugins()` bypass the runtime scope — the DB
 * permission (or the explicit admin escape) is the boundary there. Audit those call sites.
 */

import type { RecordIdValue } from "surrealdb";
import { surql } from "../index";
import { BetterSchemicError } from "../orm/errors";
import type { AnyTableDef } from "../orm/types/schema";
import {
  defineTable,
  type PresetEvent,
  type PresetIndex,
  paramProxy,
  type RecordIdField,
  type RecordIdSchemaOf,
  type SField,
  type TableDef,
  type TablePermissions,
  type TablePreset,
} from "../pure";
import { CREATE_ONLY_MARKER } from "./create-only-shared";
import { assertIdent } from "./tenant-shared";

// --- the schema preset: tenant(principal, options?) ----------------------------------------------

/** The per-table marker the preset stamps into `TableConfig.meta.tenant` (opaque to the engine). */
export interface TenantTableMeta {
  /** The tenant column (a `record<principal>` carrying the principal's id value type). */
  readonly column: string;
  /** The principal table name (`User.name`) the column links to. */
  readonly principal: string;
  /** The preserved tombstone column, or `false` when the table is not soft-deletable. */
  readonly softDelete: string | false;
  /** `true` when `update` is locked to `NONE` (append-only table) — also stamps the top-level
   *  `meta.createOnly` marker read by `createOnlyGuard()` + `timestamps()`. */
  readonly createOnly: boolean;
}

/** Overridable derived names — a `{table}` placeholder interpolates to the table name. */
export interface TenantPresetNames {
  /** The guard event name (default `"{table}_protect_{column}"`). */
  readonly event?: string;
  /** The tenant index name (default `"{table}_{snake(column)}_idx"`). */
  readonly tenantIndex?: string;
  /** The soft-delete index name (default `"{table}_{snake(deleted)}_idx"`). */
  readonly deletedIndex?: string;
}

/** Options for the `tenant(...)` preset. */
export interface TenantPresetOptions<C extends string = string> {
  /**
   * The tenant column name (default `"tenant_id"`). A `const` generic: the literal flows into the
   * preset's column type, so `t.<column>` is a real, rename-safe ref in `.index("x", (t) => …)`.
   */
  readonly column?: C;
  /**
   * Soft delete: `true` = `"deletedAt"`, or the tombstone column name. The tombstone column is
   * APP-DECLARED (the preset only permissions/indexes it — SCHEMAFULL rejects an index on a missing
   * field). Mutually exclusive with `createOnly`. When on, `select` hides tombstones and `update`
   * gets the `$before` tombstone clause.
   */
  readonly softDelete?: boolean | string;
  /** Append-only table: `update` is `NONE` (no row can ever be updated). */
  readonly createOnly?: boolean;
  /** Emit the `{table}_protect_{column}` guard event (default `true`). */
  readonly protect?: boolean;
  /** Emit the tenant indexes (default `true`). */
  readonly indexes?: boolean;
  /** Override the derived event/index names. */
  readonly names?: TenantPresetNames;
}

/** The principal's table name (`"user"`) — the tenant column's record target. */
type PrincipalName<P> =
  P extends TableDef<infer N extends string, infer _> ? N : string;
/** The principal's id VALUE type (`userTable` declared `id: s.uuid()` -> the tenant column keeps it). */
type PrincipalValue<P> =
  P extends TableDef<string, infer S>
    ? S extends { id: RecordIdField<string, infer V, infer _M> }
      ? V
      : RecordIdValue
    : RecordIdValue;
/** The principal's id MODE — a string-id principal gets a string-id tenant column. */
type PrincipalMode<P> =
  P extends TableDef<string, infer S>
    ? S extends { id: RecordIdField<string, RecordIdValue, infer M> }
      ? M
      : "record"
    : "record";

/** The tenant column as it lands on the table: `record<principal, V>` (same id mode as the
 *  principal), create-optional (`$default`) and non-updatable (`$readonly`). */
export type TenantField<P extends AnyTableDef> = SField<
  RecordIdSchemaOf<PrincipalName<P>, PrincipalValue<P>, PrincipalMode<P>>,
  "create" | "readonly"
>;

/** The preset's columns map: exactly the `column` key, fully typed. */
export type TenantColumns<P extends AnyTableDef, C extends string> = {
  [K in C]: TenantField<P>;
};

/** camelCase -> snake_case, matching the manual convention (`deletedAt` -> `deleted_at`). */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * The tenant SCOPING preset: tenant column + per-op permissions + guard event + indexes, applied
 * with `defineTable(…).use(tenant(User, options?))`. Zero-diff against the hand-written recipe
 * (same field/permissions/event/index names) and typed end-to-end.
 *
 * Permissions (AND-combined with the table's own — a preset only narrows):
 * - `select`: `T = $auth.id` (+ `AND deletedAt IS NONE` with soft delete)
 * - `create` / `delete`: `T = $auth.id`
 * - `update`: `NONE` with `createOnly`; the `$before`-aware tombstone clause with soft delete;
 *   else `T = $auth.id`
 *
 * The guard event rejects a CREATE/UPDATE that sets the tenant column to a value other than
 * `$auth.id` (the READONLY field is the DB-level backstop on updates).
 */
export function tenant<
  P extends AnyTableDef,
  const C extends string = "tenant_id",
>(
  principal: P,
  options: TenantPresetOptions<C> = {},
): TablePreset<TenantColumns<P, C>> {
  const table = principal.name;
  const column = (options.column ?? "tenant_id") as C;
  assertIdent(column, table, "column");
  const createOnly = options.createOnly === true;
  const softDeleteOption = options.softDelete ?? false;
  if (createOnly && softDeleteOption)
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: tenant("${table}") — "createOnly" and "softDelete" are mutually exclusive: an append-only table never updates, so the tombstone clause is unreachable.`,
      { table, field: "softDelete" },
    );
  const deleted =
    softDeleteOption === true
      ? "deletedAt"
      : typeof softDeleteOption === "string"
        ? softDeleteOption
        : undefined;
  if (deleted !== undefined) assertIdent(deleted, table, "softDelete");

  // `$auth.id` is the scope for every op. The column is spliced ESCAPED; `$auth`/`$before` are
  // param refs (no bindings — DDL inlines expressions).
  const scope = surql`${surql.ident(column)} = ${paramProxy(["auth", "id"])}`;
  const select = deleted
    ? surql`${scope} AND ${surql.ident(deleted)} IS NONE`
    : scope;
  // The tombstone write is an UPDATE, so the post-state has deletedAt set ($before is unset) —
  // without the `$before` clause the DB would deny it.
  const update = createOnly
    ? false
    : deleted
      ? surql`${scope} AND (${surql.ident(deleted)} IS NONE OR ${paramProxy(["before", deleted])} IS NONE AND ${surql.ident(deleted)} != NONE)`
      : scope;
  const permissions: TablePermissions = {
    select,
    create: scope,
    update,
    delete: scope,
  };

  // Resolve the overridable names up front: a plain `undefined` check (not `??`) keeps each
  // branch independently provable (the derived template is never falsy).
  const eventName = options.names?.event;
  const tenantIndexName = options.names?.tenantIndex;
  const deletedIndexName = options.names?.deletedIndex;

  const events: PresetEvent[] = [];
  if (options.protect !== false) {
    const message = `${column} cannot manually be set to a different value than the authenticated user`;
    events.push({
      name: eventName === undefined ? `{table}_protect_${column}` : eventName,
      when: surql`$event = 'CREATE' OR $event = 'UPDATE'`,
      // `$auth != NONE` keeps privileged/system writes (no session auth) working; the runtime
      // plugin is what scopes THOSE sessions.
      // biome-ignore lint/suspicious/noThenProperty: SurrealQL's event THEN clause, not a thenable.
      then: surql`IF ${paramProxy(["auth"])} != NONE AND ${paramProxy(["after", column])} != ${paramProxy(["auth", "id"])} { THROW ${message}; }`,
    });
  }

  const indexes: PresetIndex[] = [];
  if (options.indexes !== false) {
    indexes.push({
      name:
        tenantIndexName === undefined
          ? `{table}_${snake(column)}_idx`
          : tenantIndexName,
      fields: [column],
    });
    if (deleted)
      indexes.push({
        name:
          deletedIndexName === undefined
            ? `{table}_${snake(deleted)}_idx`
            : deletedIndexName,
        fields: [column, deleted],
      });
  }

  const field = principal
    .record()
    .$default(surql`$auth.id`)
    .$assert(surql`$value != NONE`)
    .$readonly();
  const columns = { [column]: field } as unknown as TenantColumns<P, C>;

  return defineTable.preset({
    columns,
    permissions,
    events,
    indexes,
    meta: {
      tenant: {
        column,
        principal: principal.name,
        softDelete: deleted ?? false,
        createOnly,
      } satisfies TenantTableMeta,
      // The canonical create-only marker: `createOnlyGuard()` enforces it client-side and
      // `timestamps()` skips `updatedAt` on this table.
      ...(createOnly ? { [CREATE_ONLY_MARKER]: true } : {}),
    },
  });
}

export type {
  TenantModelExtras,
  TenantRef,
  TenantRlsOptions,
} from "./tenant-runtime";
// The runtime half lives in its own module; the subpath re-exports it so one import carries both.
export { tenantRls } from "./tenant-runtime";
