/**
 * The hook runtime — turns one or more {@link Hooks} sources (the client's `hooks` option plus the
 * hooks each plugin contributes) into a single dispatcher the operation runtimes call.
 *
 * When no hook registers it, {@link createHookDispatcher} returns `undefined` and the runtime keeps
 * its original fast path (no payload building, no `await`). Hook errors follow the contract from
 * `./types/hooks`: `before*` propagates (aborting the operation), `after*` routs it to `onError`
 * without undoing the work, and an `onError` that throws swallows it to the console.
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
} from "./types/hooks"

/** The delegate-op families a hook (or plugin) classifies an operation by. */
export type OperationFamily = "create" | "delete" | "query" | "relate" | "update"

const FAMILY_BY_OPERATION: Record<OperationKind, OperationFamily> = {
  aggregate: "query",
  count: "query",
  create: "create",
  createMany: "create",
  cursor: "query",
  delete: "delete",
  deleteMany: "delete",
  exists: "query",
  findFirst: "query",
  findMany: "query",
  findOne: "query",
  findUnique: "query",
  insert: "create",
  insertMany: "create",
  paginate: "query",
  patch: "update",
  relate: "relate",
  relateMany: "relate",
  unrelate: "relate",
  unrelateMany: "relate",
  update: "update",
  updateEach: "update",
  updateMany: "update",
  upsert: "update",
  upsertDelta: "update",
  upsertMany: "update",
}

/** The family of one operation — the ONE classification hooks and plugins share. */
export function operationFamily(operation: OperationKind): OperationFamily {
  return FAMILY_BY_OPERATION[operation]
}

/** Reads — `SELECT`-family ops. */
export const isReadOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "query"

/** Creation — `CREATE`/`INSERT`. */
export const isCreateOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "create"

/** Mutation — `UPDATE`/`UPSERT`/`PATCH`. */
export const isUpdateOperation = (operation: OperationKind): boolean =>
  FAMILY_BY_OPERATION[operation] === "update"

/** The observer the operation runtimes drive (built once per client). */
export type HookDispatcher = {
  /** Delegate-op `after*` (routes to `afterQuery`/`afterCreate`/…). */
  after(operation: OperationKind, payload: AfterHookPayload): Promise<void>
  afterRaw(payload: RawAfterHookPayload): Promise<void>
  afterTransactionCommit(payload: TransactionAfterHookPayload): Promise<void>
  afterTransactionRollback(payload: TransactionRollbackHookPayload): Promise<void>
  /** Delegate-op `before*` (routes to `beforeQuery`/`beforeCreate`/…). */
  before(operation: OperationKind, payload: HookPayload): Promise<void>
  beforeRaw(payload: RawHookPayload): Promise<void>
  beforeTransaction(payload: TransactionHookPayload): Promise<void>
  /** Any failed operation → `onError`. */
  error(payload: ErrorHookPayload): Promise<void>
  rawError(payload: RawErrorHookPayload): Promise<void>
  transactionError(payload: TransactionRollbackHookPayload): Promise<void>
}

type Handler = (info: never) => Promise<void> | void

/** The hooks of one event, from every source, in order. */
function collect(sources: readonly Hooks[], key: keyof Hooks): readonly Handler[] {
  const out: Handler[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const source of sources) {
    const handler: unknown = (source as Record<string, unknown>)[key]
    if (typeof handler === "function") out.push(handler as Handler)
  }
  return out
}

/** How some records a decoded result represents (the `after*` `count`). */
export function resultCount(result: unknown): number {
  if (typeof result === "number") return result

  if (typeof result === "boolean") return result ? 1 : 0

  if (Array.isArray(result)) return result.length

  if (result !== null && typeof result === "object") {
    const shaped = result as { count?: unknown; data?: unknown }
    // `.data` first: a page's `count` is the total, but the hook reports the rows RETURNED.
    if (Array.isArray(shaped.data)) return shaped.data.length

    if (typeof shaped.count === "number") return shaped.count
  }
  return result === null || result === undefined ? 0 : 1
}

/**
 * Run a delegate operation through the hook pipeline: `before` fires (a throw aborts the op), then
 * `execute`, then `after` with the decoded result/duration/count; a failure routs it to `onError`
 * without undoing the work. With no dispatcher this is a bare `execute()` (the fast path). This is
 * the ONE place the delegate hook contract lives — reads, writes and any future op share it.
 */
export async function runWithHooks<T>(
  hooks: HookDispatcher | undefined,
  payload: HookPayload,
  execute: () => Promise<T>,
): Promise<T> {
  if (!hooks) return execute()

  await hooks.before(payload.operation, payload)
  const started = performance.now()
  try {
    const result = await execute()
    await hooks.after(payload.operation, {
      ...payload,
      count: resultCount(result),
      durationMs: performance.now() - started,
      result,
    })
    return result
  } catch (error) {
    await hooks.error({ ...payload, error })
    throw error
  }
}

/** The raw counterpart of {@link runWithHooks} (its own `beforeRaw`/`afterRaw`/`onRawError` family). */
export async function runWithRawHooks<T>(
  hooks: HookDispatcher | undefined,
  payload: RawHookPayload,
  execute: () => Promise<T>,
): Promise<T> {
  if (!hooks) return execute()

  await hooks.beforeRaw(payload)
  const started = performance.now()
  try {
    const result = await execute()
    await hooks.afterRaw({
      ...payload,
      durationMs: performance.now() - started,
      result,
    })
    return result
  } catch (error) {
    await hooks.rawError({ ...payload, error })
    throw error
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
    if (!source) return false

    return Object.values(source).some((value) => typeof value === "function")
  })
  if (present.length === 0) return undefined

  const query = {
    after: collect(present, "afterQuery"),
    before: collect(present, "beforeQuery"),
  }
  const create = {
    after: collect(present, "afterCreate"),
    before: collect(present, "beforeCreate"),
  }
  const update = {
    after: collect(present, "afterUpdate"),
    before: collect(present, "beforeUpdate"),
  }
  const remove = {
    after: collect(present, "afterDelete"),
    before: collect(present, "beforeDelete"),
  }
  const relate = {
    after: collect(present, "afterRelate"),
    before: collect(present, "beforeRelate"),
  }
  const onError = collect(present, "onError")
  const beforeRaw = collect(present, "beforeRaw")
  const afterRaw = collect(present, "afterRaw")
  const onRawError = collect(present, "onRawError")
  const beforeTransaction = collect(present, "beforeTransaction")
  const afterCommit = collect(present, "afterTransactionCommit")
  const afterRollback = collect(present, "afterTransactionRollback")
  const onTransactionError = collect(present, "onTransactionError")

  /** The `before`/`after` handlers per family — the ONE routing table `before`/`after` read. */
  const families: Record<
    OperationFamily,
    { readonly after: readonly Handler[]; readonly before: readonly Handler[] }
  > = {
    create,
    delete: remove,
    query,
    relate,
    update,
  }

  /** Run `before*` handlers in order; a throw propagates (aborting the operation). */
  const runBefore = async (handlers: readonly Handler[], payload: unknown): Promise<void> => {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const handler of handlers) await handler(payload as never)
  }

  /** Route a hook failure to `onError` (console when nobody listens). */
  const report = async (payload: ErrorHookPayload): Promise<void> => {
    if (onError.length === 0) {
      console.error(
        "[better-schemic] hook: an after-hook failed (the operation stands).",
        payload.error,
      )
      return
    }
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const handler of onError) {
      try {
        await handler(payload as never)
      } catch (error) {
        console.error("[better-schemic] onError hook threw.", error)
      }
    }
  }

  /** Run `after*`/`on*Error` handlers; their own failures report them, never rethrown. */
  const runObserved = async (
    handlers: readonly Handler[],
    payload: {
      readonly meta?: Record<string, unknown>
      readonly operation?: ErrorHookPayload["operation"]
      readonly surql?: string
      readonly table?: string
      readonly vars?: Record<string, unknown>
    },
    fallback: ErrorHookPayload["operation"],
  ): Promise<void> => {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const handler of handlers) {
      try {
        await handler(payload as never)
      } catch (error) {
        await report({
          ...(payload.table === undefined ? {} : { table: payload.table }),
          error: error,
          operation: payload.operation ?? fallback,
          ...(payload.surql === undefined ? {} : { surql: payload.surql }),
          ...(payload.vars === undefined ? {} : { vars: payload.vars }),
          ...(payload.meta === undefined ? {} : { meta: payload.meta }),
        })
      }
    }
  }

  const runAfter = (handlers: readonly Handler[], payload: AfterHookPayload): Promise<void> =>
    runObserved(handlers, payload, payload.operation)

  return {
    after: (operation, payload) => runAfter(families[operationFamily(operation)].after, payload),
    afterRaw: (payload) => runObserved(afterRaw, payload, payload.operation),
    afterTransactionCommit: (payload) => runObserved(afterCommit, payload, "transaction"),
    afterTransactionRollback: (payload) => runObserved(afterRollback, payload, "transaction"),
    before: (operation, payload) => runBefore(families[operationFamily(operation)].before, payload),
    beforeRaw: (payload) => runBefore(beforeRaw, payload),
    beforeTransaction: (payload) => runBefore(beforeTransaction, payload),
    error: (payload) => runObserved(onError, payload, payload.operation),
    rawError: (payload) => runObserved(onRawError, payload, payload.operation),
    transactionError: (payload) => runObserved(onTransactionError, payload, "transaction"),
  }
}
