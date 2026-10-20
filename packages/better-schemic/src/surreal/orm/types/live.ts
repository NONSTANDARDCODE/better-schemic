/**
 * Types for live queries — `client.users.live(args?, handler?)`, `client.live(table, …)`,
 * `client.liveOf(uuid, …)` and `client.kill(uuid)`.
 *
 * A live query is compiled by the ORM itself (`LIVE SELECT [DIFF] <projeção> FROM <tabela>
 * [WHERE …] [FETCH …]`) so the typed `where`/`select` and their parameter binds behave EXACTLY like
 * a read; notifications arrive through the SDK's `liveOf(uuid)` stream and are decoded through the
 * model codec. Server-verified divergences live in `docs/orm-syntax-map.md` §7: `DIFF` cannot
 * combine with a projection, `FROM ONLY`/record targets are parse/execution errors, and a record
 * that falls OUT of the `WHERE` filter emits nothing.
 */
import type { RecordId, Uuid } from "surrealdb";
import type { App } from "../../pure";
import type { LinkKeys } from "./relations";
import type { AnyTableDef, SchemaInput } from "./schema";
import type { SelectArg, SelectedShape } from "./select";
import type { Where } from "./where";
import type { PatchOp } from "./write";

/** Client-level live defaults (`betterSchemic(conn, { schema, live: { … } })`). */
export interface LiveDefaults {
  /**
   * Re-run and re-subscribe the live query when the SDK connection is re-established, emitting a
   * `RECONNECTED` notification (default `true`). Needs a `Surreal` connection (its `subscribe`);
   * a forked `SurrealSession` has no connection events, so the option is inert there.
   */
  readonly reconnect?: boolean;
}

/** Fields `fetch` accepts: the model's declared links (any string for schemaless/no-link models). */
export type LiveFetchKeys<TD extends AnyTableDef> = [LinkKeys<TD>] extends [
  never,
]
  ? string
  : LinkKeys<TD>;

/** The live args accepted by a delegate (mirrors the read clauses live supports). */
export interface LiveArgs<TD extends AnyTableDef, S = SchemaInput> {
  /** Same lowering as a read `where` (parameterized; relational filters included). */
  readonly where?: Where<TD, S>;
  /** Same projection as a read `select` (`*` when omitted). Mutually exclusive with `diff`. */
  readonly select?: SelectArg<TD>;
  /**
   * Receive JSON Patch ops instead of the full row (`LIVE SELECT DIFF FROM …`). The server does
   * not accept a projection with `DIFF` — passing both is a `ClauseNotSupportedInLive` error.
   */
  readonly diff?: boolean;
  /** Materialize links on the notified row (`FETCH a, b`). */
  readonly fetch?: readonly LiveFetchKeys<TD>[];
  /** Metadata carried on the subscription (`sub.meta`) — hooks consume it in M6. */
  readonly meta?: Record<string, unknown>;
}

/** The row a live notification carries: the projection shape (or the full decoded row). */
export type LiveRow<TD extends AnyTableDef, A> = A extends { select: infer Sel }
  ? SelectedShape<TD, Sel>
  : App<TD>;

/** The handler invoked for every notification (sync or async; failures route to `sub.onError`). */
export type LiveHandler<Row> = (
  change: LiveNotification<Row>,
) => void | Promise<void>;

/** A data change pushed by the server. */
export interface LiveChange<Row = Record<string, unknown>> {
  readonly action: "CREATE" | "UPDATE" | "DELETE" | "KILLED";
  /** The decoded row (or `null` on a `DIFF` notification / when the payload is empty). */
  readonly value: Row | null;
  /** The record the change touched. */
  readonly recordId: RecordId;
  /** Present iff `diff: true` — the JSON Patch operations of the change. */
  readonly diff?: readonly PatchOp[];
  /** The live query uuid (updated after a reconnect). */
  readonly uuid: string;
  /** The raw SDK payload (escape hatch). */
  readonly result?: unknown;
}

/** The client-side event emitted after the SDK reconnected and the live was re-subscribed. */
export interface LiveReconnected {
  readonly action: "RECONNECTED";
  readonly value: null;
  readonly uuid: string;
}

/** What a live subscription yields (data changes + the `RECONNECTED` lifecycle event). */
export type LiveNotification<Row = Record<string, unknown>> =
  | LiveChange<Row>
  | LiveReconnected;

/**
 * A running live query. `uuid` identifies it on the server; `kill()` ends it (idempotent);
 * iterating yields notifications. A handler may be passed to `live(...)` instead of iterating.
 */
export interface LiveSubscription<Row = Record<string, unknown>>
  extends AsyncIterable<LiveNotification<Row>> {
  /** The server-side live query id (changes after a reconnect). */
  readonly uuid: string;
  /** `false` once killed (or after the stream ends). */
  readonly isAlive: boolean;
  /** The `meta` passed to `live(...)`, when any. */
  readonly meta?: Record<string, unknown>;
  /** End the live query on the server and release every listener (idempotent). */
  kill(): Promise<void>;
  /** Observe handler/stream failures (without it they are reported on the console). */
  onError(handler: (error: Error) => void): void;
}

/** The promise a `live(...)` call resolves to (the server assigns the uuid before it settles). */
export type LiveResult<TD extends AnyTableDef, A> = Promise<
  LiveSubscription<LiveRow<TD, A>>
>;

/** What `liveOf(uuid, …)` accepts: the uuid string or the SDK `Uuid`. */
export type LiveId = string | Uuid;
