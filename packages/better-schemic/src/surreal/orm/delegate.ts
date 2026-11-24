/**
 * The per-model delegate — what `client.<key>` resolves to. This module owns the PUBLIC surface
 * (the typed {@link Delegate} interface, {@link ModelInfo} and the facade); the operation runtime
 * lives in `./reads` (compiled by `./compiler/*`, executed in ONE round-trip by `./execute`,
 * decoded by `./decode`).
 *
 * Reads are LAZY thenables: nothing touches the connection until the result awaits it (or
 * `.throw()` calls it), which is what makes `.explain()` possible. Compilation itself is eager,
 * so a bad argument throws at the call site.
 *
 * The delegate creats it once per schema key and shared by `client.<key>` and
 * `client.repository(name)`. M2 attaches writes, M6 attaches plugin state to the same object.
 */

import type { App } from "../pure"

import { OrmError } from "./errors"
import type { Queryable } from "./execute"
import { createGraphEntryPoint, type GraphEntryPoint } from "./graph"
import type { HookDispatcher } from "./hooks"
import type { ModelMeta, ResolvedIdStrategy, SchemaIndex } from "./meta"
import { type PluginPipeline, RuntimeOperation } from "./plugins"
import { createReadOperations } from "./reads"
import type { BatchResult, SqlPreview } from "./results"
import type { OperationContext } from "./types/context"
import type { OperationKind } from "./types/hooks"
import type { QueryLogger } from "./types/logger"
import type { PluginArgs, PluginList, PluginModelExtras, PluginState } from "./types/plugins"
import type { AnyRelationDef, AnyTableDef, SchemaInput } from "./types/schema"
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
} from "./types/select"
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
  UpsertDeltaArgs,
  UpsertDeltaResult,
  UpsertManyArgs,
  WrittenResult,
} from "./types/write"
import { createWriteOperations } from "./writes"

/** What kind of model a delegate wraps. */
export type ModelKind = "relation" | "schemaless" | "table"

/** Runtime identity/introspection of a delegate's model. */
export type ModelInfo = {
  /** Alias of {@link ModelInfo.name} — the name the database knows the model by. */
  readonly dbName: string
  /** Is `field` part of the model? (Always true for schemaless models.) */
  hasField(field: string): boolean
  /** The ORM create-id strategy (`"ulid"` default; schemaless models resolve to `"ulid"`;
   *  `"none"` = the id field's codec is ungeneratable — explicit ids ). */
  readonly idStrategy: ResolvedIdStrategy
  /** The schema key (`client.<key>`). */
  readonly key: string
  readonly kind: ModelKind
  /** The physical table/edge name. */
  readonly name: string
  /** The edge names this model (for plugin introspection). */
  readonly relations: {
    readonly incoming: readonly string[]
    readonly outgoing: readonly string[]
  }
  /** A singleton's fixed record-id key, when declared via `defineSingleton`. */
  readonly singletonId?: string
}

/** The runtime services every delegate operation needs. Built once per client. */
export type DelegateContext = {
  /**
   * Compile- delegate (`$sql`): operations return a {@link SqlPreview} instead of touching
   * the connection. Plugin transforms still run, so the preview reflects tenant/soft-delete scope.
   */
  readonly compileOnly?: boolean
  /** The wrapped connection (or session/transaction). */
  readonly conn: Queryable
  /**
   * The clone's default namespace/database scope (present  on a `$withContext` clone) — every
   * compiled operation prefixs it with `USE NS … DB …;` in the same round-trip.
   */
  readonly context?: OperationContext
  /** Attach statement `vars` to thrown errors. */
  readonly debug: boolean
  /**
   * The observation-hook dispatcher (absent when no hook registers it — the zero-overhead path).
   * Plugins contribute hooks in M6.2; the operation runtimes call `before`/`after`/`error`.
   */
  readonly hooks?: HookDispatcher
  /** The validated schema metadata pass. */
  readonly index: SchemaIndex
  /**
   * The client binds it to a transaction — batch wrappers skip their implicit
   * `BEGIN/COMMIT` (the surrounding transaction already owns atomicity).
   */
  readonly inTransaction?: boolean
  /** The query logger (absent = zero-overhead; threaded into every executor round-trip). */
  readonly logger?: QueryLogger
  /** The plugin pipeline (absent when no plugin registers it). */
  readonly pipeline?: PluginPipeline
  /** `false` when the delegate clons it with `$withoutPlugins()`. */
  readonly pluginsEnabled?: boolean
  /** The delegate's plugin state (`$state`). */
  readonly pluginState?: PluginState
}

/** The operations exposed as server-free previews on `delegate.$sql`. */
type PreviewOperation =
  | "aggregate"
  | "count"
  | "create"
  | "createMany"
  | "cursor"
  | "delete"
  | "deleteMany"
  | "exists"
  | "findFirst"
  | "findMany"
  | "findOne"
  | "findUnique"
  | "insert"
  | "insertMany"
  | "paginate"
  | "patch"
  | "relate"
  | "relateMany"
  | "unrelate"
  | "unrelateMany"
  | "update"
  | "updateEach"
  | "updateMany"
  | "upsert"
  | "upsertDelta"
  | "upsertMany"

/** The exact operation signature, with the result replaced by a synchronous SQL preview. */
export type SqlPreviewDelegate<D> = {
  [K in keyof D as K extends PreviewOperation ? K : never]: D[K] extends (
    ...args: infer A
  ) => unknown
    ? (...args: A) => SqlPreview
    : never
}

/** A method's args widened with the extra args the registered plugins contribute to `K`. */
type WithPluginArgs<Base, P extends PluginList, K extends string> = Base & PluginArgs<P, K>

/** A typed model delegate (`S` is the authored schema — relation typing needs it). */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- interface needed: `$withoutPlugins()`/`$withState()` return the polymorphic `this` type, unavailable in a type alias.
export interface Delegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
  P extends PluginList = readonly [],
> {
  readonly $model: ModelInfo
  /**
   * Compile- previews: `delegate.$sql.create({ data })` returns the exact SurrealQL + binds —
   * no connection, no hooks, no rows. Plugin transforms still apply, so this is a true dry run.
   * Reads also expose `.toSQL()` directly on their lazy result.
   */
  readonly $sql: SqlPreviewDelegate<Delegate<TD, S, P>>
  /** The delegate's plugin state (a flat bag shared by every plugin on this delegate). */
  readonly $state: PluginState
  /** A clone of the delegate that ignores every plugin (transforms, hooks, extensions). */
  $withoutPlugins(): this
  /** A clone of the delegate with `patch` merged into its plugin state. */
  $withState(state: PluginState): this
  /**
   * Grouped combines — `count()`, `math::*` and `array::*` with `GROUP BY`/`GROUP ALL`.
   *
   * ```ts
   * const byCity = await client.users.combine({
   *   select: { city: "address.city", _count: true, avgAge: { avg: "age" } },
   *   groupBy: ["address.city"],
   *   orderBy: [{ _count: "desc" }],
   * });
   * ```
   */
  aggregate<const A extends WithPluginArgs<AggregateArgs<TD, S>, P, "aggregate">>(
    args: A,
  ): ReadResult<AggregateShape<TD, A["select"]>[], A>
  /** How some rows match — `SELECT count() … GROUP ALL`. */
  count<const A extends WithPluginArgs<CountArgs<TD, S>, P, "count">>(
    args?: A,
  ): ReadResult<number, A>
  /**
   * Create one record — `CREATE [] t[:id] CONTENT $p`. `data` is codec-validated (an
   * expression in a field splics it and server-enforced); `relate` adds edges in the same batch.
   *
   * ```ts
   * const user = await client.users.create({ data: { name: "Aeon", age: 30 } });
   * ```
   */
  create<const A extends WithPluginArgs<CreateArgs<TD>, P, "create">>(
    args: A,
  ): CreatedResult<TD, A, S>
  /** Create some in ONE round-trip (implicit transaction); `skipDuplicates` needs explicit ids. */
  createMany<const A extends WithPluginArgs<CreateManyArgs<TD>, P, "createMany">>(
    args: A,
  ): BatchWriteResult<TD, A, S>
  /**
   * A keyset page (`after`/`before`) ordered by unique fields (the last one is the tiebreaker,
   * `id` by default). One probe statement (`LIMIT n+1`) per page. `select` may omit the `orderBy`
   * fields — the compiler appends reserved `_keyset_<n>` aliases for the keyset and strips them,
   * so `data` carries  the selection.
   */
  cursor<const A extends WithPluginArgs<CursorArgs<TD, S>, P, "cursor">>(
    args: A,
  ): ReadResult<CursorResult<ResultOf<TD, A, S>>, A>
  /** Delete the uniquely-targeted record (`RETURN BEFORE` default / `NONE`). */
  delete<const A extends WithPluginArgs<DeleteArgs<TD, S>, P, "delete">>(
    args: A,
  ): DeletedResult<TD, A, S>
  /** Delete every matching row; without `where`, `all: true` requires it. */
  deleteMany<const A extends WithPluginArgs<DeleteManyArgs<TD, S>, P, "deleteMany">>(
    args: A,
  ): BatchWriteResult<TD, A, S>
  /** Does any row match — `SELECT VALUE id … LIMIT 1`. */
  exists<const A extends WithPluginArgs<CountArgs<TD, S>, P, "exists">>(
    args?: A,
  ): ReadResult<boolean, A>
  /** The first matching row — a thenable that may miss (`.throw()` for a guaranteed row). */
  findFirst<const A extends WithPluginArgs<FindOneArgs<TD, S>, P, "findFirst">>(
    args?: A,
  ): FindOneResult<TD, A, S>
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
  findMany<const A extends WithPluginArgs<FindManyArgs<TD, S>, P, "findMany">>(
    args?: A,
  ): FindManyResult<TD, A, S>
  /** Alias of {@link Delegate.findFirst}. */
  findOne<const A extends WithPluginArgs<FindOneArgs<TD, S>, P, "findOne">>(
    args?: A,
  ): FindOneResult<TD, A, S>
  /**
   * The row targeted by `where.id` or a single-field UNIQUE index — `FROM  <record>` for an
   * id, `WHERE <unique> = $p LIMIT 1` otherwise. Anything else fails with `UniqueTargetRequired`
   * (which fields are unique is runtime schema metadata, so the check is runtime-side).
   */
  findUnique<const A extends WithPluginArgs<FindUniqueArgs<TD, S>, P, "findUnique">>(
    args: A,
  ): FindUniqueResult<TD, A, S>
  /**
   * Anchor a graph traversal to a record: `delegate.from("table:id").graph(g => g.out(Edge)…)` .
   */
  from(anchor: unknown): GraphEntryPoint
  /** Insert one row keeping its id (`INSERT [IGNORE] … [ON DUPLICATE KEY UPDATE]`). */
  insert<const A extends WithPluginArgs<InsertArgs<TD>, P, "insert">>(
    args: A,
  ): WrittenResult<TD, A, S>
  /** Insert an array in a SINGLE statement; `onDuplicate` decides the conflict policy. */
  insertMany<const A extends WithPluginArgs<InsertManyArgs<TD>, P, "insertMany">>(
    args: A,
  ): BatchWriteResult<TD, A, S>
  /**
   * An offset page plus its count (`limit`/`start`, `count: false` probes `n+1` instead of
   * counting). Both statements ride ONE round-trip.
   */
  paginate<const A extends WithPluginArgs<PaginateArgs<TD, S>, P, "paginate">>(
    args: A,
  ): ReadResult<PaginationResult<ResultOf<TD, A, S>>, A>
  /** JSON Patch by unique target (`UPDATE … PATCH $ops`). */
  patch<const A extends WithPluginArgs<PatchArgs<TD, S>, P, "patch">>(
    args: A,
  ): UpdatedResult<TD, A, S>
  /**
   * Update the record targeted by `where.id` or a single-field UNIQUE index — a miss resolves
   * `null` (`.throw()` for a guaranteed row), never creates. Modes: `merge` (default), `set`,
   * `content`, `replace`, `patch`; `unset` removes fields (a second statement when combined with
   * `data`).
   */
  update<const A extends WithPluginArgs<UpdateArgs<TD, S>, P, "update">>(
    args: A,
  ): UpdatedResult<TD, A, S>
  /**
   * Per-row update — one `UPDATE … WHERE by = $item.by` statement per item (ONE round-trip).
   * Misses land in `skipped` (default) or raise `ResultNotFound` with `onEmpty: 'throw'`.
   */
  updateEach<
    const By extends keyof App<TD> & string = "id",
    const A extends WithPluginArgs<UpdateEachArgs<TD, By>, P, "updateEach"> = WithPluginArgs<
      UpdateEachArgs<TD, By>,
      P,
      "updateEach"
    >,
  >(
    args: A & { readonly by?: By },
  ): BatchWriteResult<TD, A, S>
  /** Update every matching row (`where` optional — the whole table; `rules` guards land in M6). */
  updateMany<const A extends WithPluginArgs<UpdateManyArgs<TD, S>, P, "updateMany">>(
    args: A,
  ): BatchWriteResult<TD, A, S>
  /**
   * Update by id, a single-field UNIQUE index or an inferred `data.id` — STRICT by default: a
   * target that matches nothing (or filters it out by a permission/plugin scope) rejects
   * `ResultNotFound`, never creates. With no target at all (`where` omitted and no `data.id`) the
   * call is a plain CREATE. `data` is one payload for both branches, or `create` + `update` for
   * distinct ones (both require `onMissing: "create"`, which restores create-or-update).
   */
  upsert<const A extends WithPluginArgs<UpsertArgs<TD, S>, P, "upsert">>(
    args: A,
  ): WrittenResult<TD, A, S>
  /**
   * STRICT update by id or a single-field UNIQUE index in ONE round-trip by default, returning
   * the resulting row, the previous row and the field-level delta of DECODED app values
   * (`RETURN VALUE { before: $before, after: $after }` — both snapshots come from the SAME
   * statement, so no concurrent writer can slip between them). A targeted miss rejects
   * `ResultNotFound`; `onMissing: "create"` restores create-or-update. Omit `where` for a plain
   * create (a generated id per the table's `idStrategy`, or `data.id` infers the target).
   *
   * ```ts
   * const { record, created, before, delta, changed } = await client.users.upsertDelta({
   *   where: { id: "user:42" },
   *   data: { name: "Aeon", balance: decimal("12.34") },
   * });
   * if (created) logger.info("created", { id: record.id });
   * if (changed.includes("balance")) ledger.create({ delta: delta!.new.balance });
   * ```
   */
  upsertDelta<const A extends WithPluginArgs<UpsertDeltaArgs<TD, S>, P, "upsertDelta">>(
    args: A,
  ): Promise<UpsertDeltaResult<TD, NoInfer<A>, S>>
  /** Stable overload for `ReturnType<delegate.upsertDelta>`: with no args literal to infer,
   *  `A` fixs it to the args type (not `unknown`), so `result.record.<field>` stays typed. */
  upsertDelta(
    args: UpsertDeltaArgs<TD, S>,
  ): Promise<UpsertDeltaResult<TD, UpsertDeltaArgs<TD, S>, S>>
  /** Upsert some: with ids one `INSERT … ON DUPLICATE`; without, `conflict` resolves each row. */
  upsertMany<const A extends WithPluginArgs<UpsertManyArgs<TD>, P, "upsertMany">>(
    args: A,
  ): BatchWriteResult<TD, A, S>
}

/** The extra surface a RELATION delegate (`relation`) exposes. */
export type RelationDelegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
  P extends PluginList = readonly [],
> = {
  /** Create an edge — `RELATE from->edge[:id]->to [SET …]`. */
  relate<const A extends WithPluginArgs<RelateArgs<TD>, P, "relate">>(
    args: A,
  ): CreatedResult<TD, A, S>
  /** Create some edges in ONE transactional round-trip. */
  relateMany<const A extends WithPluginArgs<RelateManyArgs<TD>, P, "relateMany">>(
    args: A,
  ): BatchWriteResult<TD, A>
  /** Delete the edges between two endpoints. */
  unrelate(args: WithPluginArgs<UnrelateArgs<TD>, P, "unrelate">): Promise<BatchResult<never>>
  /** Delete edges by filter (without `where`, `all: true` requires it). */
  unrelateMany(
    args: WithPluginArgs<UnrelateManyArgs<TD, S>, P, "unrelateMany">,
  ): Promise<BatchResult<never>>
} & Delegate<TD, S, P>

/** The delegate a schema key maps to: a relation carries the RELATE surface, a table does not. */
export type ModelDelegate<
  TD extends AnyTableDef = AnyTableDef,
  S = SchemaInput,
  P extends PluginList = readonly [],
> = (TD extends AnyRelationDef ? RelationDelegate<TD, S, P> : Delegate<TD, S, P>) &
  PluginModelExtras<P>

/** Build a delegate (and its `$model`) for one indexed model. */
export function createDelegate<TD extends AnyTableDef = AnyTableDef>(
  meta: ModelMeta,
  ctx: DelegateContext,
): Delegate<TD> {
  /** Build one delegate variant (state + plugins on/off). */
  const build = (state: PluginState, enabled: boolean): Delegate<TD> => {
    const localCtx: DelegateContext = {
      ...ctx,
      pluginsEnabled: enabled,
      pluginState: state,
    }
    const operations = {
      ...createReadOperations(meta, localCtx),
      ...createWriteOperations(meta, localCtx),
    }
    // The SAME compilers with a compile-context: no connection, no hooks, no rows. Plugin
    // transforms still run, so a `$sql` preview shows the post-policy/post-tenant statement.
    const compileCtx: DelegateContext = {
      ...localCtx,
      compileOnly: true,
      hooks: undefined,
      logger: undefined,
    }
    const compileOperations = {
      ...createReadOperations(meta, compileCtx),
      ...createWriteOperations(meta, compileCtx),
    }
    const delegate: Record<string, unknown> = {
      $model: modelInfo(meta),
      ...wrapOperations(operations, meta, localCtx),
      $sql: wrapOperations(compileOperations, meta, compileCtx),
      $state: state,
      $withoutPlugins: () => build(state, false),
      $withState: (patch: PluginState) => build({ ...state, ...patch }, enabled),
      from: (anchor: unknown) => createGraphEntryPoint(meta, localCtx, anchor),
    }
    const pipeline = localCtx.pipeline
    if (pipeline && enabled) {
      const extensions = pipeline.extendModel({ index: ctx.index, model: delegate }, state)
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const [name, value] of Object.entries(extensions)) {
        if (name in delegate) {
          throw new OrmError(
            "PluginError",
            `extendModel("${name}") collides with an existing delegate member — pick another name.`,
          )
        }
        delegate[name] = value
      }
    }
    return delegate as unknown as Delegate<TD>
  }
  return build(ctx.pluginState ?? {}, ctx.pluginsEnabled !== false)
}

/**
 * Wrap the operation table with the plugin `transform` pipeline: each call builds a mutable
 * {@link RuntimeOperation}, lets the plugins mutate it (possibly re-dispatching to another `kind`),
 * then runs the original compiler. With no transforms this is the identity — zero overhead.
 */
function wrapOperations(
  operations: Record<string, unknown>,
  meta: ModelMeta,
  ctx: DelegateContext,
): Record<string, unknown> {
  const pipeline = ctx.pipeline
  if (!pipeline?.hasTransforms || ctx.pluginsEnabled === false) return operations

  const state = ctx.pluginState ?? {}

  const runOperation = (kind: OperationKind, args: Record<string, unknown>): unknown => {
    const run = operations[kind]
    if (typeof run !== "function")
      throw new OrmError("PluginError", `transform: no operation "${kind}" to dispatch to.`)

    return (run as (args: Record<string, unknown>) => unknown)(args)
  }

  const dispatch = (
    kind: OperationKind,
    args: Record<string, unknown>,
    transformed = false,
  ): unknown => {
    if (transformed) return runOperation(kind, args)

    const op = new RuntimeOperation(
      kind,
      meta.name,
      args,
      state,
      ctx.index,
      args.meta as Record<string, unknown> | undefined,
    )
    if (pipeline.transform(op)) return Promise.resolve(undefined)

    if (op.kind !== kind) return dispatch(op.kind, op.args, true)

    return runOperation(op.kind, op.args)
  }

  const out: Record<string, unknown> = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const kind of Object.keys(operations)) {
    out[kind] = (args: Record<string, unknown> = {}): unknown =>
      dispatch(kind as OperationKind, args)
  }
  return out
}

function modelInfo(meta: ModelMeta): ModelInfo {
  if ("schemaless" in meta) {
    return {
      dbName: meta.name,
      hasField: () => true,
      // Schemaless entries can't declare `.idStrategy(...)` — they ride the uniform `ulid` default.
      idStrategy: "ulid",
      key: meta.key,
      kind: "schemaless",
      name: meta.name,
      relations: { incoming: [], outgoing: [] },
    }
  }
  return {
    dbName: meta.name,
    key: meta.key,
    kind: meta.kind,
    name: meta.name,
    ...(meta.singletonId === undefined ? {} : { singletonId: meta.singletonId }),
    hasField: (field) => meta.columns.has(field),
    idStrategy: meta.idStrategy,
    relations: {
      incoming: meta.incoming.map((edge) => edge.name),
      outgoing: meta.outgoing.map((edge) => edge.name),
    },
  }
}
