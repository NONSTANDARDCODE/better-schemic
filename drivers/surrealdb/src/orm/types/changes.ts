/**
 * Types for changefeeds — `client.changes({ table?, since, limit? })`.
 *
 * Changefeeds are defined in the SCHEMA (`DEFINE TABLE t CHANGEFEED 1d [INCLUDE ORIGINAL]`); the
 * ORM only reads the history through `SHOW CHANGES FOR TABLE t | FOR DATABASE`. The server labels a
 * write (create OR update) as `update` — without `INCLUDE ORIGINAL` the two are indistinguishable —
 * so the normalized {@link ChangeEntry} uses `"UPDATE"` for both (documented in
 * `docs/orm-syntax-map.md` §7).
 */
import type { RecordId } from "surrealdb";
import type { App } from "../../pure";
import type { CallContext } from "./context";
import type { ModelKeys, SchemaInput, TableAt } from "./schema";
import type { PatchOp } from "./write";

/** The normalized action of one changefeed entry (see the module note). */
export type ChangeAction = "UPDATE" | "DELETE" | "DEFINE";

/** A written record: `value` is the full row (or the `current` state of an original-carrying change). */
export interface ChangeWritten<Row = Record<string, unknown>> {
  readonly action: "UPDATE";
  readonly recordId: RecordId;
  /** The decoded row after the write (CREATE and UPDATE both arrive as `update`). */
  readonly value: Row;
  /** The JSON Patch of the change — only present with `INCLUDE ORIGINAL`. */
  readonly diff?: readonly PatchOp[];
}

/** A deleted record: `before` is the prior state (only with `INCLUDE ORIGINAL`). */
export interface ChangeDeleted<Row = Record<string, unknown>> {
  readonly action: "DELETE";
  readonly recordId: RecordId;
  readonly before?: Row;
}

/** A schema (`DEFINE TABLE`) entry — carries the raw server definition. */
export interface ChangeDefined {
  readonly action: "DEFINE";
  /** The raw `define_table` payload (escape hatch; shape is server-owned). */
  readonly definition: unknown;
}

/** One entry of a {@link ChangeSet}. */
export type ChangeEntry<Row = Record<string, unknown>> =
  | ChangeWritten<Row>
  | ChangeDeleted<Row>
  | ChangeDefined;

/** One versionstamp bucket: the entries that landed at that point in the changefeed. */
export interface ChangeSet<Row = Record<string, unknown>> {
  /** The changefeed position (bigint). Pagination uses `versionstamp + 1` — `SINCE` is inclusive. */
  readonly versionstamp: bigint;
  readonly changes: readonly ChangeEntry<Row>[];
}

/** What `since` accepts: a versionstamp, a `Date` or an ISO-8601 string (compiled to `d'…'`). */
export type ChangesSince = number | bigint | Date | string;

/** Args for `client.changes(...)`. */
export interface ChangesArgs<S = SchemaInput> {
  /** Schema key (resolved to the physical table) or a physical table name. Omit for DATABASE. */
  readonly table?: ModelKeys<S> & string;
  /** Where to start reading; defaults to `0` (the beginning of the retained changefeed). */
  readonly since?: ChangesSince;
  /** Max entries per call (server `LIMIT`). */
  readonly limit?: number;
  /** Per-call namespace/database override (`context: { database: "analytics" }`). */
  readonly context?: CallContext;
}

/** The row type of a change: the table's decoded shape when `table` is a schema key. */
export type ChangeRow<S, A> = A extends { table: infer K }
  ? K extends ModelKeys<S> & string
    ? App<TableAt<S, K>>
    : Record<string, unknown>
  : Record<string, unknown>;
