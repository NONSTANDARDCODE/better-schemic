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

/** The delegate-op families a hook is registered under. */
type Family = "query" | "create" | "update" | "delete" | "relate";

const FAMILY_BY_OPERATION: Record<OperationKind, Family> = {
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

  const family = (operation: OperationKind): Family =>
    FAMILY_BY_OPERATION[operation];

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
    async before(operation, payload) {
      const f = family(operation);
      if (f === "query") return runBefore(query.before, payload);
      if (f === "create") return runBefore(create.before, payload);
      if (f === "update") return runBefore(update.before, payload);
      if (f === "delete") return runBefore(remove.before, payload);
      return runBefore(relate.before, payload);
    },
    async after(operation, payload) {
      const f = family(operation);
      if (f === "query") return runAfter(query.after, payload);
      if (f === "create") return runAfter(create.after, payload);
      if (f === "update") return runAfter(update.after, payload);
      if (f === "delete") return runAfter(remove.after, payload);
      return runAfter(relate.after, payload);
    },
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
