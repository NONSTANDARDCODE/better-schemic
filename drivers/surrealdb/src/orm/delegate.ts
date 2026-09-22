/**
 * The per-model delegate — what `client.<key>` resolves to. This module owns the PUBLIC surface
 * (the typed {@link Delegate} interface, {@link ModelInfo} and the facade); the operation runtime
 * lives in `./reads` (compiled by `./compiler/*`, executed in ONE round-trip by `./execute`,
 * decoded by `./decode`).
 *
 * Reads are LAZY thenables: nothing touches the connection until the result is awaited (or
 * `.throw()` is called), which is what makes `.explain()` possible. Compilation itself is eager,
 * so a bad argument throws at the call site.
 *
 * The delegate is created once per schema key and shared by `client.<key>` and
 * `client.repository(name)`. M2 attaches writes, M6 attaches plugin state to the same object.
 */

import type { App } from "../pure";
import type { Queryable } from "./execute";
import { createLiveOperation } from "./live";
import type { ModelMeta, SchemaIndex } from "./meta";
import { createReadOperations } from "./reads";
import type { BatchResult } from "./results";
import type { OperationContext } from "./types/context";
import type {
  LiveArgs,
  LiveDefaults,
  LiveHandler,
  LiveResult,
  LiveRow,
} from "./types/live";
import type { AnyRelationDef, AnyTableDef, SchemaInput } from "./types/schema";
import type {
  AggregateArgs,
  AggregateShape,
  CountArgs,
  CursorArgs,
  CursorResult,
  FindManyArgs,
  FindManyResult,
  FindOneArgs,
  FindOneResult,
  FindUniqueArgs,
  FindUniqueResult,
  PaginateArgs,
  PaginationResult,
  ReadResult,
  ResultOf,
} from "./types/select";
import type {
  BatchWriteResult,
  CreateArgs,
  CreatedResult,
  CreateManyArgs,
  DeleteArgs,
  DeletedResult,
  DeleteManyArgs,
  InsertArgs,
  InsertManyArgs,
  PatchArgs,
  RelateArgs,
  RelateManyArgs,
  UnrelateArgs,
  UnrelateManyArgs,
  UpdateArgs,
  UpdatedResult,
  UpdateEachArgs,
  UpdateManyArgs,
  UpsertArgs,
  UpsertManyArgs,
  WrittenResult,
} from "./types/write";
import { createWriteOperations } from "./writes";

/** What kind of model a delegate wraps. */
export type ModelKind = "table" | "relation" | "schemaless";

/** Runtime identity/introspection of a delegate's model. */
export interface ModelInfo {
  /** The schema key (`client.<key>`). */
  readonly key: string;
  /** The physical table/edge name. */
  readonly name: string;
  readonly kind: ModelKind;
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string;
  /** Is `field` part of the model? (Always true for schemaless models.) */
  hasField(field: string): boolean;
}

/** The runtime services every delegate operation needs. Built once per client. */
export interface DelegateContext {
  /** The wrapped connection (or session/transaction). */
  readonly conn: Queryable;
  /** The validated schema metadata pass. */
  readonly index: SchemaIndex;
  /** Attach statement `vars` to thrown errors. */
  readonly debug: boolean;
  /**
   * The client is bound to a transaction — batch wrappers skip their implicit
   * `BEGIN/COMMIT` (the surrounding transaction already owns atomicity).
   */
  readonly inTransaction?: boolean;
  /** Client-level live defaults (`betterSchemic(conn, { schema, live: { … } })`). */
  readonly live?: LiveDefaults;
  /**
   * The clone's default namespace/database scope (present only on a `$withContext` clone) — every
   * compiled operation is prefixed with `USE NS … DB …;` in the same round-trip.
   */
  readonly context?: OperationContext;
}

/** A typed model delegate (`S` is the authored schema — relation typing needs it). */
export interface Delegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
> {
  readonly $model: ModelInfo;
  /**
   * Every matching row (empty array when nothing matches — never throws for a miss).
   *
   * ```ts
   * const rows = await client.users.findMany({
   *   where: { age: { gte: 18 } },
   *   select: { id: true, name: true },
   *   orderBy: [{ name: "asc" }],
   *   limit: 20,
   * });
   * ```
   */
  findMany<const A extends FindManyArgs<TD, S>>(
    args?: A,
  ): FindManyResult<TD, A, S>;
  /** The first matching row — a thenable that may miss (`.throw()` for a guaranteed row). */
  findFirst<const A extends FindOneArgs<TD, S>>(
    args?: A,
  ): FindOneResult<TD, A, S>;
  /** Alias of {@link Delegate.findFirst}. */
  findOne<const A extends FindOneArgs<TD, S>>(
    args?: A,
  ): FindOneResult<TD, A, S>;
  /**
   * The row targeted by `where.id` or a single-field UNIQUE index — `FROM ONLY <record>` for an
   * id, `WHERE <unique> = $p LIMIT 1` otherwise. Anything else fails with `UniqueTargetRequired`
   * (which fields are unique is runtime schema metadata, so the check is runtime-side).
   */
  findUnique<const A extends FindUniqueArgs<TD, S>>(
    args: A,
  ): FindUniqueResult<TD, A, S>;
  /** How many rows match — `SELECT count() … GROUP ALL`. */
  count<const A extends CountArgs<TD, S>>(args?: A): ReadResult<number, A>;
  /** Does any row match — `SELECT VALUE id … LIMIT 1`. */
  exists<const A extends CountArgs<TD, S>>(args?: A): ReadResult<boolean, A>;
  /**
   * Grouped aggregates — `count()`, `math::*` and `array::*` with `GROUP BY`/`GROUP ALL`.
   *
   * ```ts
   * const byCity = await client.users.aggregate({
   *   select: { city: "address.city", _count: true, avgAge: { avg: "age" } },
   *   groupBy: ["address.city"],
   *   orderBy: [{ _count: "desc" }],
   * });
   * ```
   */
  aggregate<const A extends AggregateArgs<TD, S>>(
    args: A,
  ): ReadResult<AggregateShape<TD, A["select"]>[], A>;
  /**
   * An offset page plus its count (`limit`/`start`, `count: false` probes `n+1` instead of
   * counting). Both statements ride ONE round-trip.
   */
  paginate<const A extends PaginateArgs<TD, S>>(
    args: A,
  ): ReadResult<PaginationResult<ResultOf<TD, A, S>>, A>;
  /**
   * A keyset page (`after`/`before`) ordered by unique fields (the last one is the tiebreaker,
   * `id` by default). One probe statement (`LIMIT n+1`) per page.
   */
  cursor<const A extends CursorArgs<TD, S>>(
    args: A,
  ): ReadResult<CursorResult<ResultOf<TD, A, S>>, A>;
  /**
   * Create one record — `CREATE [ONLY] t[:id] CONTENT $p`. `data` is codec-validated (an
   * expression in a field is spliced and server-enforced); `relate` adds edges in the same batch.
   *
   * ```ts
   * const user = await client.users.create({ data: { name: "Aeon", age: 30 } });
   * ```
   */
  create<const A extends CreateArgs<TD>>(args: A): CreatedResult<TD, A>;
  /** Create many in ONE round-trip (implicit transaction); `skipDuplicates` needs explicit ids. */
  createMany<const A extends CreateManyArgs<TD>>(
    args: A,
  ): BatchWriteResult<TD, A, S>;
  /** Insert one row keeping its id (`INSERT [IGNORE] … [ON DUPLICATE KEY UPDATE]`). */
  insert<const A extends InsertArgs<TD>>(args: A): WrittenResult<TD, A>;
  /** Insert an array in a SINGLE statement; `onDuplicate` decides the conflict policy. */
  insertMany<const A extends InsertManyArgs<TD>>(
    args: A,
  ): BatchWriteResult<TD, A, S>;
  /**
   * Update the record targeted by `where.id` or a single-field UNIQUE index — a miss resolves
   * `null` (`.throw()` for a guaranteed row), never creates. Modes: `merge` (default), `set`,
   * `content`, `replace`, `patch`; `unset` removes fields (a second statement when combined with
   * `data`).
   */
  update<const A extends UpdateArgs<TD, S>>(args: A): UpdatedResult<TD, A>;
  /** Update every matching row (`where` optional — the whole table; `rules` guards land in M6). */
  updateMany<const A extends UpdateManyArgs<TD, S>>(
    args: A,
  ): BatchWriteResult<TD, A, S>;
  /** JSON Patch by unique target (`UPDATE … PATCH $ops`). */
  patch<const A extends PatchArgs<TD, S>>(args: A): UpdatedResult<TD, A>;
  /**
   * Create-or-update by id or a single-field UNIQUE index — `data` for one payload, or
   * `create` + `update` for distinct branches (never conflicts).
   */
  upsert<const A extends UpsertArgs<TD, S>>(args: A): WrittenResult<TD, A>;
  /** Upsert many: with ids one `INSERT … ON DUPLICATE`; without, `conflict` resolves each row. */
  upsertMany<const A extends UpsertManyArgs<TD>>(
    args: A,
  ): BatchWriteResult<TD, A, S>;
  /** Delete the uniquely-targeted record (`RETURN BEFORE` default / `NONE`). */
  delete<const A extends DeleteArgs<TD, S>>(args: A): DeletedResult<TD, A>;
  /** Delete every matching row; without `where`, `all: true` is required. */
  deleteMany<const A extends DeleteManyArgs<TD, S>>(
    args: A,
  ): BatchWriteResult<TD, A, S>;
  /**
   * Per-row update — one `UPDATE … WHERE by = $item.by` statement per item (ONE round-trip).
   * Misses land in `skipped` (default) or raise `ResultNotFound` with `onEmpty: 'throw'`.
   */
  updateEach<
    const By extends keyof App<TD> & string = "id",
    const A extends UpdateEachArgs<TD, By> = UpdateEachArgs<TD, By>,
  >(args: A & { readonly by?: By }): BatchWriteResult<TD, A, S>;
  /**
   * Subscribe to server-pushed changes for this model — `LIVE SELECT [DIFF] <projeção> FROM t
   * [WHERE …] [FETCH …]`. Resolves to a {@link LiveSubscription} (iterate it or pass a handler);
   * `kill()` ends it. Live needs a WebSocket connection (`LiveQueryUnsupported` otherwise).
   *
   * ```ts
   * const sub = await client.users.live({ where: { active: true }, diff: true }, (change) => {
   *   if (change.action === "UPDATE") cache.set(change.recordId, change.diff);
   * });
   * ```
   */
  live<const A extends LiveArgs<TD, S>>(
    args?: A,
    handler?: LiveHandler<LiveRow<TD, A>>,
  ): LiveResult<TD, A>;
}

/** The extra surface a RELATION delegate (`defineRelation`) exposes. */
export interface RelationDelegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
> extends Delegate<TD, S> {
  /** Create an edge — `RELATE from->edge[:id]->to [SET …]`. */
  relate<const A extends RelateArgs<TD>>(args: A): CreatedResult<TD, A>;
  /** Create many edges in ONE transactional round-trip. */
  relateMany<const A extends RelateManyArgs<TD>>(
    args: A,
  ): BatchWriteResult<TD, A>;
  /** Delete the edges between two endpoints. */
  unrelate<const A extends UnrelateArgs<TD>>(
    args: A,
  ): Promise<BatchResult<never>>;
  /** Delete edges by filter (without `where`, `all: true` is required). */
  unrelateMany<const A extends UnrelateManyArgs<TD, S>>(
    args: A,
  ): Promise<BatchResult<never>>;
}

/** The delegate a schema key maps to: a relation carries the RELATE surface, a table does not. */
export type ModelDelegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
> = TD extends AnyRelationDef ? RelationDelegate<TD, S> : Delegate<TD, S>;

/** Build a delegate (and its `$model`) for one indexed model. */
export function createDelegate<TD extends AnyTableDef = AnyTableDef>(
  meta: ModelMeta,
  ctx: DelegateContext,
): Delegate<TD> {
  const delegate = {
    $model: modelInfo(meta),
    ...createReadOperations(meta, ctx),
    ...createWriteOperations(meta, ctx),
    live: createLiveOperation(meta, ctx),
  };
  return delegate as unknown as Delegate<TD>;
}

function modelInfo(meta: ModelMeta): ModelInfo {
  if ("schemaless" in meta)
    return {
      key: meta.key,
      name: meta.name,
      kind: "schemaless",
      hasField: () => true,
    };
  return {
    key: meta.key,
    name: meta.name,
    kind: meta.kind,
    ...(meta.singletonId !== undefined
      ? { singletonId: meta.singletonId }
      : {}),
    hasField: (field) => meta.columns.has(field),
  };
}
