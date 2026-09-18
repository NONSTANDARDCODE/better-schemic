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
import type { Queryable } from "./execute";
import type { ModelMeta, SchemaIndex } from "./meta";
import { createReadOperations } from "./reads";
import type { AnyTableDef } from "./types/schema";
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
  /** The wrapped connection (or session). */
  readonly conn: Queryable;
  /** The validated schema metadata pass. */
  readonly index: SchemaIndex;
  /** Attach statement `vars` to thrown errors. */
  readonly debug: boolean;
}

/** A typed model delegate. */
export interface Delegate<TD extends AnyTableDef = AnyTableDef> {
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
  findMany<const A extends FindManyArgs<TD>>(args?: A): FindManyResult<TD, A>;
  /** The first matching row — a thenable that may miss (`.throw()` for a guaranteed row). */
  findFirst<const A extends FindOneArgs<TD>>(args?: A): FindOneResult<TD, A>;
  /** Alias of {@link Delegate.findFirst}. */
  findOne<const A extends FindOneArgs<TD>>(args?: A): FindOneResult<TD, A>;
  /**
   * The row targeted by `where.id` or a single-field UNIQUE index — `FROM ONLY <record>` for an
   * id, `WHERE <unique> = $p LIMIT 1` otherwise. Anything else fails with `UniqueTargetRequired`
   * (which fields are unique is runtime schema metadata, so the check is runtime-side).
   */
  findUnique<const A extends FindUniqueArgs<TD>>(
    args: A,
  ): FindUniqueResult<TD, A>;
  /** How many rows match — `SELECT count() … GROUP ALL`. */
  count<const A extends CountArgs<TD>>(args?: A): ReadResult<number, A>;
  /** Does any row match — `SELECT VALUE id … LIMIT 1`. */
  exists<const A extends CountArgs<TD>>(args?: A): ReadResult<boolean, A>;
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
  aggregate<const A extends AggregateArgs<TD>>(
    args: A,
  ): ReadResult<AggregateShape<TD, A["select"]>[], A>;
  /**
   * An offset page plus its count (`limit`/`start`, `count: false` probes `n+1` instead of
   * counting). Both statements ride ONE round-trip.
   */
  paginate<const A extends PaginateArgs<TD>>(
    args: A,
  ): ReadResult<PaginationResult<ResultOf<TD, A>>, A>;
  /**
   * A keyset page (`after`/`before`) ordered by unique fields (the last one is the tiebreaker,
   * `id` by default). One probe statement (`LIMIT n+1`) per page.
   */
  cursor<const A extends CursorArgs<TD>>(
    args: A,
  ): ReadResult<CursorResult<ResultOf<TD, A>>, A>;
}

/** Build a delegate (and its `$model`) for one indexed model. */
export function createDelegate<TD extends AnyTableDef = AnyTableDef>(
  meta: ModelMeta,
  ctx: DelegateContext,
): Delegate<TD> {
  const delegate = {
    $model: modelInfo(meta),
    ...createReadOperations(meta, ctx),
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
