/**
 * The `tenantRls` runtime half of `plugins/tenant` — client-side row-level tenant isolation for
 * PRIVILEGED sessions (where `$auth`/DDL permissions do not filter). Reads the `meta.tenant` marker
 * the `tenant()` preset stamps (`./tenant.ts`) and:
 *
 * - requires a scope for every tenant-tagged table (`TenantRequired`, fail-closed, BEFORE compiling);
 * - injects the scope into create/upsert payloads (a forged/divergent value is `TenantViolation`);
 * - AND-combines it into EVERY read/write through the compiler `scope` channel — including
 *   `findUnique`'s id/unique targets and singular writes, without joining `uniqueTarget`;
 * - exposes `$forTenant("user:abc")` (per-delegate state, `$withState`).
 *
 * Boundaries (documented, deliberate): edges (`relate`/`unrelate`), `live`, `changes` (changefeed),
 * raw SQL (`$raw`/`$query`/`$unsafe`) and `$withoutPlugins()` bypass the runtime scope — the DB
 * permission (or the explicit admin escape) is the boundary there. Audit those call sites.
 */
import { RecordId } from "surrealdb";
import { describeValue, isPlainObject } from "../orm/compiler/shared";
import { BetterSchemicError } from "../orm/errors";
import { operationFamily } from "../orm/hooks";
import type { SchemaIndex, TableMeta } from "../orm/meta";
import { definePlugin } from "../orm/plugins";
import type { Operation, PluginState } from "../orm/types/plugins";
import type { AnyTableDef } from "../orm/types/schema";
import { assertIdent, isIdent } from "./tenant-shared";

/**
 * A tenant scope value: a `RecordId`, or a string record id (`"user:abc"`). A bare `"abc"` is
 * accepted when the table is tagged with a principal (it becomes `user:abc`).
 */
export type TenantRef = string | RecordId;

/** Options for the `tenantRls(...)` runtime plugin. */
export interface TenantRlsOptions {
  /**
   * The default tenant scope, evaluated PER OPERATION: a static value or a resolver
   * (`tenant: () => ctx.tenantId`). `$forTenant(...)` on a delegate overrides it for that clone.
   */
  readonly tenant?: TenantRef | (() => TenantRef | undefined | null);
  /**
   * Extra PHYSICAL table names to treat as tenant-scoped, for schemas without the preset. Typed
   * tables are validated at bootstrap; schemaless entries are accepted as-is. The fallback column is
   * {@link TenantRlsOptions.column}.
   */
  readonly tables?: readonly string[];
  /** The column used for `tables` entries without a `meta.tenant` tag (default `"tenant_id"`). */
  readonly column?: string;
}

/**
 * The methods `tenantRls` grafts onto every delegate. `$forTenant` returns `this`, so the full
 * typed delegate (reads, writes, other plugins' methods) survives the scope clone.
 */
export interface TenantModelExtras {
  /** A clone of this delegate scoped to `tenant` (via `$withState`) — chainable; the original
   *  delegate keeps its state. The scope resolves as `$state.<plugin id>` > `tenantRls({ tenant })`. */
  $forTenant(tenant: TenantRef): this;
}

/** The parsed runtime tag of one tenant-scoped table. */
interface TenantTag {
  readonly column: string;
  readonly principal?: string;
  readonly softDelete?: string;
  readonly createOnly: boolean;
}

/** The plugin id, also used as the `$state` namespace of `$forTenant` (collision-proof: the flat
 *  state bag is shared by every plugin and is reachable through the public `$withState`). */
const PLUGIN_ID = "@better-schemic/surrealdb/tenant";
const STATE_KEY = PLUGIN_ID;

/** Read the preset's marker off a table def (or `undefined` for untagged tables). */
function tenantMetaOf(meta: TableMeta | { def: AnyTableDef }): unknown {
  return meta.def.config.meta?.tenant;
}

/** Parse + validate a `meta.tenant` marker (fails bootstrap with the table named). */
function parseTag(raw: unknown, table: string): TenantTag {
  const malformed = () =>
    new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: table "${table}" has a malformed meta.tenant tag — expected { column: string, principal?: string, softDelete?: string | false, createOnly?: boolean }.`,
      { table },
    );
  if (!isPlainObject(raw)) throw malformed();
  if (typeof raw.column !== "string" || raw.column.length === 0)
    throw malformed();
  assertIdent(raw.column, table, "meta.tenant.column");
  let softDelete: string | undefined;
  if (typeof raw.softDelete === "string" && raw.softDelete.length > 0)
    softDelete = raw.softDelete;
  if (softDelete !== undefined)
    assertIdent(softDelete, table, "meta.tenant.softDelete");
  let principal: string | undefined;
  if (typeof raw.principal === "string" && raw.principal.length > 0)
    principal = raw.principal;
  return {
    column: raw.column,
    ...(principal !== undefined ? { principal } : {}),
    ...(softDelete !== undefined ? { softDelete } : {}),
    createOnly: raw.createOnly === true,
  };
}

/** Bootstrap validation: the tag's column is a record link to the principal (and the soft-delete
 *  column exists — a SCHEMAFULL index on a missing field fails at apply). */
function validateTag(tag: TenantTag, meta: TableMeta): void {
  const column = meta.columns.get(tag.column);
  if (column === undefined)
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: "${meta.name}" is tenant-scoped, but column "${tag.column}" is not a field — add it (the tenant() preset does), or fix meta.tenant.`,
      { table: meta.name, field: tag.column },
    );
  if (column.record === undefined)
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: "${meta.name}.${tag.column}" must be a record link to be tenant-scoped — got type "${column.type}".`,
      { table: meta.name, field: tag.column },
    );
  if (
    tag.principal !== undefined &&
    column.record.targets !== undefined &&
    !column.record.targets.includes(tag.principal)
  )
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: "${meta.name}.${tag.column}" links ${column.record.targets.map((t) => `record<${t}>`).join(" | ")}, but meta.tenant names principal "${tag.principal}" — align them.`,
      { table: meta.name, field: tag.column },
    );
  if (tag.softDelete !== undefined && !meta.columns.has(tag.softDelete))
    throw new BetterSchemicError(
      "SchemaInvalid",
      `plugins/tenant: "${meta.name}" is soft-delete scoped, but the tombstone column "${tag.softDelete}" is not a field — declare it before the schemafull table (SCHEMAFULL rejects an index on a missing field).`,
      { table: meta.name, field: tag.softDelete },
    );
}

/** Resolve the operation's scope: `$state.<plugin id>` > `tenantRls({ tenant })` (a static or a
 *  per-operation resolver). `undefined` = no scope (the transform fails closed). */
function resolveScope(
  op: Operation,
  options: TenantRlsOptions,
): TenantRef | undefined {
  const state = op.state[STATE_KEY];
  if (state != null) return state as TenantRef;
  const configured = options.tenant;
  const value = typeof configured === "function" ? configured() : configured;
  return value == null ? undefined : value;
}

/** Normalize a `TenantRef` to a `RecordId`, validating it against the table's principal. */
function toRecordId(value: unknown, tag: TenantTag, op: Operation): RecordId {
  if (value instanceof RecordId) {
    if (tag.principal !== undefined && value.table.name !== tag.principal)
      throw violationError(
        op,
        tag,
        `the scope ${describeValue(value)} belongs to table "${value.table.name}", but this table's principal is "${tag.principal}"`,
      );
    return value;
  }
  if (typeof value !== "string" || value.length === 0)
    throw violationError(
      op,
      tag,
      `the tenant scope must be a record id like "user:abc" (got ${describeValue(value)})`,
    );
  const colon = value.indexOf(":");
  if (colon > 0) {
    const table = value.slice(0, colon);
    if (tag.principal !== undefined && table !== tag.principal)
      throw violationError(
        op,
        tag,
        `the scope "${value}" belongs to table "${table}", but this table's principal is "${tag.principal}"`,
      );
    return new RecordId(table, value.slice(colon + 1));
  }
  if (tag.principal === undefined)
    throw violationError(
      op,
      tag,
      `a bare tenant id "${value}" needs a principal — pass "table:id" (this table has no meta.tenant marker)`,
    );
  return new RecordId(tag.principal, value);
}

/** Is `value` the same tenant as `scope` (string/RecordId/short form normalized)? */
function sameTenant(value: unknown, scope: RecordId, tag: TenantTag): boolean {
  if (value instanceof RecordId) return String(value) === String(scope);
  if (typeof value !== "string" || value.length === 0) return false;
  const colon = value.indexOf(":");
  if (colon > 0)
    return (
      String(new RecordId(value.slice(0, colon), value.slice(colon + 1))) ===
      String(scope)
    );
  return tag.principal !== undefined
    ? String(new RecordId(tag.principal, value)) === String(scope)
    : false;
}

/** The teaching error for a missing scope (fail-closed, before compiling). */
function requiredError(op: Operation, tag: TenantTag): BetterSchemicError {
  return new BetterSchemicError(
    "TenantRequired",
    `tenantRls: "${op.table}" is tenant-scoped by "${tag.column}", but operation "${op.kind}" has no tenant scope — call $forTenant("user:abc") on the delegate or set tenantRls({ tenant: () => … }). For an intentional cross-tenant/admin operation, call $withoutPlugins() explicitly.`,
    { table: op.table, operation: op.kind, field: tag.column },
  );
}

/** The teaching error for a divergent/forged tenant. */
function violationError(
  op: Operation,
  tag: TenantTag,
  detail: string,
  hint = "Never set the tenant column by hand — the plugin injects the scoped value.",
): BetterSchemicError {
  return new BetterSchemicError(
    "TenantViolation",
    `tenantRls: operation "${op.kind}" on "${op.table}" — ${detail} (column "${tag.column}"). ${hint}`,
    { table: op.table, operation: op.kind, field: tag.column },
  );
}

/**
 * Validate a caller `where` that already constrains the tenant column: it must pin EXACTLY the
 * scope (a forged/divergent value is `TenantViolation`). Returns `true` when the filter itself
 * pins the scope — the compiler then adds nothing (the predicate IS the scope); reads/writes with
 * no such key get the scope ANDed by their compiler.
 */
function wherePinsScope(
  op: Operation,
  tag: TenantTag,
  scope: RecordId,
): boolean {
  const where = op.args.where;
  if (!isPlainObject(where)) return false; // absent/fragment: the compiler ANDs the scope itself
  const existing = where[tag.column];
  if (existing === undefined) return false;
  if (!isScopeValue(existing, scope, tag))
    throw violationError(
      op,
      tag,
      `the caller's where already constrains "${tag.column}" (${describeValue(existing)}) to a different value than the scope ${describeValue(scope)}`,
      "Drop the manual tenant filter — $forTenant()/tenantRls({ tenant }) is the one source of scope.",
    );
  return true;
}

/** A `where[column]` value that pins exactly the scoped tenant. */
function isScopeValue(
  value: unknown,
  scope: RecordId,
  tag: TenantTag,
): boolean {
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return (
      entries.length === 1 &&
      entries[0]?.[0] === "equals" &&
      sameTenant(entries[0][1], scope, tag)
    );
  }
  return sameTenant(value, scope, tag);
}

/** Set the plugin scope on an operation: a caller `where` that already pins the scope is a valid,
 *  sufficient predicate (validated by `wherePinsScope`); anything else gets the scope channelled
 *  to the compiler, which ANDs it into every statement. */
function scopeOperation(op: Operation, tag: TenantTag, scope: RecordId): void {
  if (!wherePinsScope(op, tag, scope)) op.scope[tag.column] = { equals: scope };
}

/** Inject `column = scope` into a create payload (object or `Many` array), rejecting a divergent
 *  value. A string id is normalized to the `RecordId` the codec requires. `data` defaults to
 *  `op.args.data`; `upsert`'s distinct `create` branch passes `op.args.create` too. */
function injectCreateData(
  op: Operation,
  tag: TenantTag,
  scope: RecordId,
  data: unknown = op.args.data,
): void {
  const items = Array.isArray(data) ? data : data !== undefined ? [data] : [];
  for (const item of items) {
    if (!isPlainObject(item)) continue; // the compiler rejects a non-object payload itself
    const current = item[tag.column];
    if (current !== undefined && !sameTenant(current, scope, tag))
      throw violationError(
        op,
        tag,
        `the payload sets "${tag.column}" to ${describeValue(current)}, but the scope is ${describeValue(scope)}`,
      );
    item[tag.column] = scope;
  }
}

/** Validate an update payload's tenant value (an equal value is normalized to the scoped
 *  `RecordId`; READONLY allows the same-value no-op write, and `REPLACE` needs it present). */
function assertUpdateData(
  op: Operation,
  tag: TenantTag,
  scope: RecordId,
  data: unknown = op.args.data,
): void {
  const items = Array.isArray(data) ? data : data !== undefined ? [data] : [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const current = item[tag.column];
    if (current === undefined) continue;
    if (!sameTenant(current, scope, tag))
      throw violationError(
        op,
        tag,
        `the payload sets "${tag.column}" to ${describeValue(current)}, but the scope is ${describeValue(scope)}`,
      );
    item[tag.column] = scope;
  }
}

/** Reject a JSON Patch that targets the tenant column (top-level paths). */
function assertPatches(op: Operation, tag: TenantTag): void {
  const patches = op.args.patches;
  if (!Array.isArray(patches)) return;
  for (const entry of patches) {
    if (!isPlainObject(entry) || typeof entry.path !== "string") continue;
    const path = entry.path;
    if (path === `/${tag.column}` || path.startsWith(`/${tag.column}/`))
      throw violationError(
        op,
        tag,
        `the JSON Patch touches "/${tag.column}"`,
        `The tenant column is READONLY and scope-owned — remove the patch op.`,
      );
  }
}

/** `INSERT … ON DUPLICATE KEY UPDATE` has no WHERE: a guessed id could update another tenant's
 *  record, so it is refused on a tenant-scoped table (fail-closed). */
function assertDuplicateSafe(op: Operation, tag: TenantTag): void {
  const onDuplicate = op.args.onDuplicate;
  if (onDuplicate === undefined || onDuplicate === "ignore") return;
  throw violationError(
    op,
    tag,
    `insert onDuplicate ${describeValue(onDuplicate)} can update a record of another tenant (INSERT … ON DUPLICATE KEY UPDATE has no WHERE)`,
    `Use upsert({ where, data }) with a $forTenant() scope instead, or $withoutPlugins() for an explicit admin path.`,
  );
}

/** The teaching error for a bad `tenantRls({ column })`. */
function columnError(value: unknown): BetterSchemicError {
  return new BetterSchemicError(
    "PluginError",
    `tenantRls: "column" must be a plain identifier (letters/digits/underscore, not starting with a digit) — got ${describeValue(value)}.`,
  );
}

/**
 * The tenant runtime plugin. Fail-closed: a tenant-scoped table with no scope throws
 * {@link BetterSchemicError} `TenantRequired` BEFORE compiling; forged/divergent values throw
 * `TenantViolation`. Untagged tables pass through untouched (zero behavior change).
 */
export function tenantRls(options: TenantRlsOptions = {}) {
  const fallbackColumn = options.column ?? "tenant_id";
  if (!isIdent(fallbackColumn)) throw columnError(options.column);
  const extras: readonly string[] = options.tables ?? [];
  for (const name of extras)
    if (typeof name !== "string" || !name)
      throw new BetterSchemicError(
        "PluginError",
        `tenantRls: every "tables" entry must be a non-empty physical table name (got ${describeValue(name)}).`,
      );
  /** Per schema index: physical table -> tag, built at bootstrap (setup) — the transform is a
   *  plain map lookup. Keyed by the INDEX (not by plugin instance), so sharing one `tenantRls`
   *  instance across clients with different schemas stays correct. */
  const tagsByIndex = new WeakMap<SchemaIndex, Map<string, TenantTag>>();

  /** Build + validate the tag map for one schema index (bootstrap, or lazily fail-closed). */
  const buildTags = (index: SchemaIndex): Map<string, TenantTag> => {
    const tags = new Map<string, TenantTag>();
    for (const meta of index.tables.values()) {
      const raw = tenantMetaOf(meta);
      if (raw === undefined) continue;
      const tag = parseTag(raw, meta.name);
      validateTag(tag, meta);
      tags.set(meta.name, tag);
    }
    for (const name of extras) {
      const model = index.byName.get(name);
      if (model === undefined)
        throw new BetterSchemicError(
          "SchemaInvalid",
          `tenantRls: "tables" entry "${name}" is not in the schema — add it or drop the entry.`,
          { table: name, operation: "setup" },
        );
      if ("schemaless" in model) {
        tags.set(name, { column: fallbackColumn, createOnly: false });
        continue;
      }
      const raw = tenantMetaOf(model);
      const tag =
        raw !== undefined
          ? parseTag(raw, name)
          : { column: fallbackColumn, createOnly: false };
      validateTag(tag, model);
      tags.set(name, tag);
    }
    return tags;
  };

  return definePlugin({
    id: PLUGIN_ID,
    name: "Tenant RLS",
    description:
      "Row-level tenant isolation for privileged sessions (client-side scope).",
    config: { ...options, column: fallbackColumn, tables: extras },
    setup({ index }) {
      const configured = options.tenant;
      if (
        configured !== undefined &&
        typeof configured !== "string" &&
        !(configured instanceof RecordId) &&
        typeof configured !== "function"
      )
        throw new BetterSchemicError(
          "PluginError",
          `tenantRls: "tenant" must be a record id, a string, or a () => TenantRef resolver (got ${describeValue(configured)}).`,
        );
      // Every tagged table must be valid — a bad tag fails the bootstrap, not the first query.
      tagsByIndex.set(index, buildTags(index));
    },
    transform(op) {
      let tags = tagsByIndex.get(op.index);
      if (tags === undefined) {
        // A client always runs `setup`; this lazy build keeps a hand-built pipeline (and a shared
        // plugin instance across clients) correct instead of silently unscoped.
        tags = buildTags(op.index);
        tagsByIndex.set(op.index, tags);
      }
      const tag = tags.get(op.table);
      if (tag === undefined) return; // untagged table: untouched
      // Edges are out of scope: RELATE/DELETE-edge go through the DB permission, not a column.
      if (operationFamily(op.kind) === "relate") return;
      const scope = resolveScope(op, options);
      if (scope === undefined) throw requiredError(op, tag);
      const tenant = toRecordId(scope, tag, op);
      const family = operationFamily(op.kind);

      if (family === "create") {
        if (op.kind === "insert" || op.kind === "insertMany")
          assertDuplicateSafe(op, tag);
        injectCreateData(op, tag, tenant);
        return;
      }
      if (family === "update") {
        if (
          op.kind === "upsert" ||
          op.kind === "upsertDelta" ||
          op.kind === "upsertMany"
        ) {
          // The create branch needs the value in the payload (an UPSERT's WHERE does not filter
          // the create branch) — and the update branch is scoped via `scope`. Distinct
          // `create`/`update` branches each get their own payload check. `upsertDelta`'s strict
          // `onMissing: "throw"` never creates, but the same payload checks stay correct (the
          // update branch rejects a divergent value; the inferred target is scoped).
          injectCreateData(op, tag, tenant);
          injectCreateData(op, tag, tenant, op.args.create);
          assertUpdateData(op, tag, tenant, op.args.update);
        } else {
          assertPatches(op, tag);
          // `mode: "replace"` drops fields absent from the payload, and a READONLY field must be
          // present with the same value — inject the scope (validated) instead of requiring the
          // caller to echo it. MERGE/SET/CONTENT preserve an omitted READONLY column.
          if (op.args.mode === "replace") injectCreateData(op, tag, tenant);
          else assertUpdateData(op, tag, tenant);
        }
        scopeOperation(op, tag, tenant);
        return;
      }
      // delete + query families: the compiler ANDs the scope into every statement; a caller
      // `where` that already pins it is validated instead.
      scopeOperation(op, tag, tenant);
    },
    extendModel({ model }): TenantModelExtras {
      const self = model as {
        $withState(state: PluginState): TenantModelExtras;
      };
      return {
        $forTenant: (tenant: TenantRef) =>
          self.$withState({ [STATE_KEY]: tenant }),
      };
    },
  });
}
