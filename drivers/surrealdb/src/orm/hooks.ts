/**
 * The hook runtime — turns one or more {@link Hooks} sources (the client's `hooks` option plus the
 * hooks each plugin contributes) into a single dispatcher the operation runtimes call.
 *
 * When no hook is registered, {@link createHookDispatcher} returns `undefined` and the runtime keeps
 * its original fast path (no payload building, no `await`). Hook errors follow the contract from
 * `./types/hooks`: `before*` propagates (aborting the operation), `after*` is routed to `onError`
 * without undoing the work, and an `onError` that throws is swallowed to the console.
 */
import type {
  AfterHookPayload,
  ErrorHookPayload,
  HookPayload,
  Hooks,
  OperationKind,
  RawAfterHookPayload,
  RawErrorHookPayload,
  RawHookPayload,
  TransactionAfterHookPayload,
  TransactionHookPayload,
  TransactionRollbackHookPayload,
} from "./types/hooks";

/** The delegate-op families a hook (or plugin) classifies an operation by. */
export type OperationFamily =
  | "query"
  | "create"
  | "update"
  | "delete"
  | "relate";

const FAMILY_BY_OPERATION: Record<OperationKind, OperationFamily> = {
  findMany: "query",
  findFirst: "query",
  findOne: "query",
  findUnique: "query",
  count: "query",
  exists: "query",
  aggregate: "query",
  paginate: "query",
  cursor: "query",
  create: "create",
  createMany: "create",
  insert: "create",
  insertMany: "create",
  update: "update",
  updateMany: "update",
  updateEach: "update",
  upsert: "update",
  upsertMany: "update",
  patch: "update",
  delete: "delete",
  deleteMany: "delete",
  relate: "relate",
  relateMany: "relate",
  unrelate: "relate",
  unrelateMany: "relate",
};

/** The family of one operation — the ONE classification hooks and plugins share. */
export function operationFamily(operation: OperationKind): OperationFamily {
  return FAMILY_BY_OPERATION[operation];
}

/** Reads — `SELECT`-family ops. */
export const isReadOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "query";

/** Creation — `CREATE`/`INSERT`. */
export const isCreateOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "create";

/** Mutation — `UPDATE`/`UPSERT`/`PATCH`. */
export const isUpdateOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "update";

/** The observer the operation runtimes drive (built once per client). */
export interface HookDispatcher {
  /** Delegate-op `before*` (routes to `beforeQuery`/`beforeCreate`/…). */
  before(operation: OperationKind, payload: HookPayload): Promise<void>;
  /** Delegate-op `after*` (routes to `afterQuery`/`afterCreate`/…). */
  after(operation: OperationKind, payload: AfterHookPayload): Promise<void>;
  /** Any failed operation → `onError`. */
  error(payload: ErrorHookPayload): Promise<void>;
  beforeRaw(payload: RawHookPayload): Promise<void>;
  afterRaw(payload: RawAfterHookPayload): Promise<void>;
  rawError(payload: RawErrorHookPayload): Promise<void>;
  beforeTransaction(payload: TransactionHookPayload): Promise<void>;
  afterTransactionCommit(payload: TransactionAfterHookPayload): Promise<void>;
  afterTransactionRollback(
    payload: TransactionRollbackHookPayload,
  ): Promise<void>;
  transactionError(payload: TransactionRollbackHookPayload): Promise<void>;
}

type Handler = (info: never) => void | Promise<void>;

/** The hooks of one event, from every source, in order. */
function collect<K extends keyof Hooks>(
  sources: readonly Hooks[],
  key: K,
): readonly Handler[] {
  const out: Handler[] = [];
  for (const source of sources) {
    const handler = source[key];
    if (typeof handler === "function") out.push(handler as unknown as Handler);
  }
  return out;
}

/** How many records a decoded result represents (the `after*` `count`). */
export function resultCount(result: unknown): number {
  if (typeof result === "number") return result;
  if (typeof result === "boolean") return result ? 1 : 0;
  if (Array.isArray(result)) return result.length;
  if (result !== null && typeof result === "object") {
    const shaped = result as { count?: unknown; data?: unknown };
    // `.data` first: a page's `count` is the total, but the hook reports the rows RETURNED.
    if (Array.isArray(shaped.data)) return shaped.data.length;
    if (typeof shaped.count === "number") return shaped.count;
  }
  return result === null || result === undefined ? 0 : 1;
}

/**
 * Run a delegate operation through the hook pipeline: `before` fires (a throw aborts the op), then
 * `execute`, then `after` with the decoded result/duration/count; a failure is routed to `onError`
 * without undoing the work. With no dispatcher this is a bare `execute()` (the fast path). This is
 * the ONE place the delegate hook contract lives — reads, writes and any future op share it.
 */
export async function runWithHooks<T>(
  hooks: HookDispatcher | undefined,
  payload: HookPayload,
  execute: () => Promise<T>,
): Promise<T> {
  if (!hooks) return execute();
  await hooks.before(payload.operation, payload);
  const started = performance.now();
  try {
    const result = await execute();
    await hooks.after(payload.operation, {
      ...payload,
      result,
      durationMs: performance.now() - started,
      count: resultCount(result),
    });
    return result;
  } catch (error) {
    await hooks.error({ ...payload, error });
    throw error;
  }
}

/** The raw counterpart of {@link runWithHooks} (its own `beforeRaw`/`afterRaw`/`onRawError` family). */
export async function runWithRawHooks<T>(
  hooks: HookDispatcher | undefined,
  payload: RawHookPayload,
  execute: () => Promise<T>,
): Promise<T> {
  if (!hooks) return execute();
  await hooks.beforeRaw(payload);
  const started = performance.now();
  try {
    const result = await execute();
    await hooks.afterRaw({
      ...payload,
      result,
      durationMs: performance.now() - started,
    });
    return result;
  } catch (error) {
    await hooks.rawError({ ...payload, error });
    throw error;
  }
}

/**
 * Build a dispatcher over the given hook sources, or `undefined` when none registers a hook (the
 * caller then keeps its zero-overhead path).
 */
export function createHookDispatcher(
  sources: readonly (Hooks | undefined)[],
): HookDispatcher | undefined {
  const present = sources.filter((source): source is Hooks => {
    if (!source) return false;
    return Object.values(source).some((value) => typeof value === "function");
  });
  if (present.length === 0) return undefined;

  const query = {
    before: collect(present, "beforeQuery"),
    after: collect(present, "afterQuery"),
  };
  const create = {
    before: collect(present, "beforeCreate"),
    after: collect(present, "afterCreate"),
  };
  const update = {
    before: collect(present, "beforeUpdate"),
    after: collect(present, "afterUpdate"),
  };
  const remove = {
    before: collect(present, "beforeDelete"),
    after: collect(present, "afterDelete"),
  };
  const relate = {
    before: collect(present, "beforeRelate"),
    after: collect(present, "afterRelate"),
  };
  const onError = collect(present, "onError");
  const beforeRaw = collect(present, "beforeRaw");
  const afterRaw = collect(present, "afterRaw");
  const onRawError = collect(present, "onRawError");
  const beforeTransaction = collect(present, "beforeTransaction");
  const afterCommit = collect(present, "afterTransactionCommit");
  const afterRollback = collect(present, "afterTransactionRollback");
  const onTransactionError = collect(present, "onTransactionError");

  /** The `before`/`after` handlers per family — the ONE routing table `before`/`after` read. */
  const families: Record<
    OperationFamily,
    { readonly before: readonly Handler[]; readonly after: readonly Handler[] }
  > = {
    query,
    create,
    update,
    delete: remove,
    relate,
  };

  /** Run `before*` handlers in order; a throw propagates (aborting the operation). */
  const runBefore = async (
    handlers: readonly Handler[],
    payload: unknown,
  ): Promise<void> => {
    for (const handler of handlers) await handler(payload as never);
  };

  /** Route a hook failure to `onError` (console when nobody listens). */
  const report = async (payload: ErrorHookPayload): Promise<void> => {
    if (onError.length === 0) {
      console.error(
        "[better-schemic] hook: an after-hook failed (the operation stands).",
        payload.error,
      );
      return;
    }
    for (const handler of onError) {
      try {
        await handler(payload as never);
      } catch (e) {
        console.error("[better-schemic] onError hook threw.", e);
      }
    }
  };

  /** Run `after*`/`on*Error` handlers; their own failures are reported, never rethrown. */
  const runObserved = async (
    handlers: readonly Handler[],
    payload: {
      readonly table?: string;
      readonly operation?: ErrorHookPayload["operation"];
      readonly surql?: string;
      readonly vars?: Record<string, unknown>;
      readonly meta?: Record<string, unknown>;
    },
    fallback: ErrorHookPayload["operation"],
  ): Promise<void> => {
    for (const handler of handlers) {
      try {
        await handler(payload as never);
      } catch (e) {
        await report({
          ...(payload.table !== undefined ? { table: payload.table } : {}),
          operation: payload.operation ?? fallback,
          error: e,
          ...(payload.surql !== undefined ? { surql: payload.surql } : {}),
          ...(payload.vars !== undefined ? { vars: payload.vars } : {}),
          ...(payload.meta !== undefined ? { meta: payload.meta } : {}),
        });
      }
    }
  };

  const runAfter = (
    handlers: readonly Handler[],
    payload: AfterHookPayload,
  ): Promise<void> => runObserved(handlers, payload, payload.operation);

  return {
    before: (operation, payload) =>
      runBefore(families[operationFamily(operation)].before, payload),
    after: (operation, payload) =>
      runAfter(families[operationFamily(operation)].after, payload),
    error: (payload) => runObserved(onError, payload, payload.operation),
    beforeRaw: (payload) => runBefore(beforeRaw, payload),
    afterRaw: (payload) => runObserved(afterRaw, payload, payload.operation),
    rawError: (payload) => runObserved(onRawError, payload, payload.operation),
    beforeTransaction: (payload) => runBefore(beforeTransaction, payload),
    afterTransactionCommit: (payload) =>
      runObserved(afterCommit, payload, "transaction"),
    afterTransactionRollback: (payload) =>
      runObserved(afterRollback, payload, "transaction"),
    transactionError: (payload) =>
      runObserved(onTransactionError, payload, "transaction"),
  };
}
