/**
 * The changefeed runtime — `client.changes({ table?, since, limit? })` over `SHOW CHANGES`.
 *
 * The SQL is literal-only (the server rejects a `SINCE` param — see `docs/orm-syntax-map.md` §7),
 * so `since` compiles to a versionstamp or a `d'…'` datetime. The raw entries are normalized into
 * {@link ChangeSet}s and each row is decoded through the model codec (by the record's table when
 * `table` is omitted, so a DATABASE-level read still gets typed rows for known models).
 */
import { escapeIdent, RecordId } from "surrealdb";
import { fullProjectionSpec } from "./compiler/projection";
import { compileError, describeValue, isPlainObject } from "./compiler/shared";
import { contextOption } from "./context";
import { decodeRow } from "./decode";
import type { DelegateContext } from "./delegate";
import { execute } from "./execute";
import { type ModelMeta, resolveModel, type SchemaIndex } from "./meta";
import type { ChangeEntry, ChangeSet, ChangesSince } from "./types/changes";
import type { CallContext } from "./types/context";
import type { PatchOp } from "./types/write";

const OPERATION = "changes";

/** The runtime args (loose on purpose — the typed key surface lives in `types/changes`). */
export interface ChangesRuntimeArgs {
  readonly table?: string;
  readonly since?: ChangesSince;
  readonly limit?: number;
  readonly context?: CallContext;
}

/** `0` / `123` / `123n` / `d'2025-…'` — the only forms the server accepts after SINCE. */
export function sinceLiteral(since: ChangesSince | undefined): string {
  if (since === undefined) return "0";
  if (typeof since === "number") {
    if (!Number.isFinite(since) || since < 0)
      throw compileError(
        "ValidationError",
        `${OPERATION}: since (versionstamp) must be a finite, non-negative number (got ${since}).`,
        { operation: OPERATION },
      );
    return String(since);
  }
  if (typeof since === "bigint") {
    if (since < 0n)
      throw compileError(
        "ValidationError",
        `${OPERATION}: since (versionstamp) must be non-negative (got ${since}).`,
        { operation: OPERATION },
      );
    return since.toString();
  }
  const iso =
    since instanceof Date
      ? since.toISOString()
      : typeof since === "string"
        ? since
        : undefined;
  if (iso === undefined || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(iso))
    throw compileError(
      "ValidationError",
      `${OPERATION}: since must be a versionstamp (number/bigint), a Date or an ISO-8601 string (got ${describeValue(since)}).`,
      { operation: OPERATION },
    );
  return `d'${iso}'`;
}

/** Compile `SHOW CHANGES FOR TABLE <t> | FOR DATABASE SINCE <since> [LIMIT n]`. */
export function compileChanges(
  index: SchemaIndex,
  args: ChangesRuntimeArgs | undefined,
): string {
  if (args !== undefined && !isPlainObject(args))
    throw compileError(
      "ValidationError",
      `${OPERATION}: args must be an object with table/since/limit (got ${describeValue(args)}).`,
      { operation: OPERATION },
    );
  const spec = (args ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(spec))
    if (!["table", "since", "limit", "context"].includes(key))
      throw compileError(
        "ValidationError",
        `${OPERATION}: unknown option "${key}" — changes accepts table, since, limit, context.`,
        { operation: OPERATION },
      );

  let target = "DATABASE";
  if (spec.table !== undefined) {
    if (typeof spec.table !== "string" || spec.table.length === 0)
      throw compileError(
        "ValidationError",
        `${OPERATION}: table must be a schema key or physical table name (got ${describeValue(spec.table)}).`,
        { operation: OPERATION },
      );
    const meta = resolveModel(index, spec.table);
    target = `TABLE ${escapeIdent(meta ? meta.name : spec.table)}`;
  }
  const parts = [
    `SHOW CHANGES FOR ${target}`,
    `SINCE ${sinceLiteral(spec.since as ChangesSince | undefined)}`,
  ];
  if (spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || (spec.limit as number) <= 0)
      throw compileError(
        "ValidationError",
        `${OPERATION}: limit must be a positive integer (got ${describeValue(spec.limit)}).`,
        { operation: OPERATION },
      );
    parts.push(`LIMIT ${spec.limit}`);
  }
  return parts.join(" ");
}

/** The decoded row for a raw record, via its own table when it is a known model. */
function decodeByRecord(
  raw: unknown,
  index: SchemaIndex,
  fallback: ModelMeta | undefined,
): unknown {
  const record =
    raw && typeof raw === "object"
      ? (raw as { id?: unknown })
      : ({} as { id?: unknown });
  const id = record.id;
  const table =
    id instanceof Object && "table" in (id as object)
      ? (id as { table?: { name?: string } }).table?.name
      : undefined;
  const meta = (table ? index.byName.get(table) : undefined) ?? fallback;
  if (!meta) return raw;
  return decodeRow(raw, meta, fullProjectionSpec(), index);
}

/** Normalize one raw `SHOW CHANGES` result into typed {@link ChangeSet}s. */
export function normalizeChangeSets(
  raw: unknown,
  index: SchemaIndex,
  fallback?: ModelMeta,
): ChangeSet<unknown>[] {
  if (!Array.isArray(raw)) return [];
  const sets: ChangeSet<unknown>[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const versionstamp =
      typeof entry.versionstamp === "bigint"
        ? entry.versionstamp
        : typeof entry.versionstamp === "number"
          ? BigInt(entry.versionstamp)
          : undefined;
    if (versionstamp === undefined) continue;
    const changes: ChangeEntry<unknown>[] = [];
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (!isPlainObject(change)) continue;
      if ("delete" in change && isPlainObject(change.delete)) {
        const deleted = change.delete as { id?: unknown; original?: unknown };
        if (deleted.id instanceof RecordId)
          changes.push({
            action: "DELETE",
            recordId: deleted.id,
            ...(deleted.original !== undefined
              ? { before: decodeByRecord(deleted.original, index, fallback) }
              : {}),
          });
        continue;
      }
      if ("current" in change && isPlainObject(change.current)) {
        const current = change.current as { id?: unknown };
        if (current.id instanceof RecordId)
          changes.push({
            action: "UPDATE",
            recordId: current.id,
            value: decodeByRecord(current, index, fallback),
            ...(Array.isArray(change.update)
              ? { diff: change.update as readonly PatchOp[] }
              : {}),
          });
        continue;
      }
      if ("update" in change && isPlainObject(change.update)) {
        const updated = change.update as { id?: unknown };
        if (updated.id instanceof RecordId)
          changes.push({
            action: "UPDATE",
            recordId: updated.id,
            value: decodeByRecord(updated, index, fallback),
          });
        continue;
      }
      if ("define_table" in change)
        changes.push({ action: "DEFINE", definition: change.define_table });
      else {
        // Forward-compatible: an unknown single-key entry whose payload is a record (a future
        // server action, e.g. a distinct `create`) normalizes as a write instead of vanishing.
        const payload = Object.values(change)[0];
        const id = isPlainObject(payload)
          ? (payload as { id?: unknown }).id
          : undefined;
        if (id instanceof RecordId)
          changes.push({
            action: "UPDATE",
            recordId: id,
            value: decodeByRecord(payload, index, fallback),
          });
      }
    }
    sets.push({ versionstamp, changes });
  }
  return sets;
}

/**
 * Run `SHOW CHANGES` and normalize the result. `fallback` is the delegate model when the call
 * asked for a specific table (its codec decodes rows even if the id table lookup misses).
 */
export async function fetchChanges(
  ctx: DelegateContext,
  index: SchemaIndex,
  args: ChangesRuntimeArgs | undefined,
  fallback?: ModelMeta,
): Promise<ChangeSet<unknown>[]> {
  const sql = compileChanges(index, args);
  const out = await execute(ctx.conn, {
    statements: [{ sql }],
    operation: OPERATION,
    table: fallback?.name,
    debug: ctx.debug,
    logger: ctx.logger,
    ...contextOption(ctx, args?.context),
  });
  return normalizeChangeSets(out.rows[0], index, fallback);
}
