/**
 * The result wrappers every delegate operation returns — the honest shapes from the prototype:
 *
 * - reads that may miss -> {@link ThrowingResult} (`await` gives `T | null`, `.throw()` gives `T`)
 * - batches -> {@link BatchResult} (`count` always; `data` when RETURN hands rows back)
 * - raw multi-statement -> {@link StatementResult} (`status` per statement)
 *
 * `attachThrow` mirrors better-drizzle's `attachThrow` (`shared/client/hooks.ts:314-385`): the
 * thenable is augmented in place, so there is zero cost when `.throw()` is never called.
 */
import type { QueryResponse } from "surrealdb";
import {
  BetterSchemicError,
  type BetterSchemicErrorOptions,
  normalizeError,
} from "./errors";

/** Context handed to `.throw()` factories so error messages can name the target. */
export interface NotFoundInfo {
  /** The table/edge the operation targeted (physical name). */
  readonly table: string;
  /** The delegate operation, e.g. `"findUnique"` / `"update"` / `"delete"`. */
  readonly operation: string;
  /** The filter that matched nothing (verbatim, for the factory). */
  readonly where?: unknown;
  /** The SurrealQL emitted for the statement. */
  readonly surql?: string;
  /** The bound variables of the statement. */
  readonly vars?: Record<string, unknown>;
}

/** A read/write that may miss: `await` yields `T | null`; `.throw()` yields `T` or throws. */
export type ThrowingResult<T> = Promise<T | null> & {
  throw(factory?: (info: NotFoundInfo) => Error): Promise<T>;
};

/** Short, safe rendering of a filter for the default not-found message. */
function describeWhere(where: unknown): string {
  if (where === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(where) ?? String(where);
  } catch {
    text = String(where);
  }
  return ` matching ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

/**
 * Augment a `Promise<T | null>` with `.throw()`: called on a missing (`null`/`undefined`) result it
 * invokes the factory (or throws a default `ResultNotFound`), otherwise it resolves the value.
 */
export function attachThrow<T>(
  promise: Promise<T | null>,
  info: NotFoundInfo | (() => NotFoundInfo),
): ThrowingResult<T> {
  const getInfo = typeof info === "function" ? info : () => info;
  return Object.assign(promise, {
    throw(factory?: (info: NotFoundInfo) => Error): Promise<T> {
      return promise.then((value) => {
        if (value === null || value === undefined) {
          const notFound = getInfo();
          if (factory) throw factory(notFound);
          throw new BetterSchemicError(
            "ResultNotFound",
            `${notFound.table}: no record matched ${notFound.operation}${describeWhere(notFound.where)}`,
            {
              table: notFound.table,
              operation: notFound.operation,
              surql: notFound.surql,
              vars: notFound.vars,
              details: notFound.where,
            },
          );
        }
        return value;
      });
    },
  }) as ThrowingResult<T>;
}

/**
 * A LAZY thenable: the operation only runs when the result is awaited (`then`/`catch`/`finally`),
 * so `.explain()` can inspect the compiled statements without executing the query. Compilation
 * itself stays eager — a bad arg throws at call time, not as an unhandled rejection.
 */
export function lazyResult<T>(run: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const get = () => (started ??= run());
  // A `Promise` needs exactly then/catch/finally + the tag, so the annotation IS the contract.
  const thenable: Promise<T> = {
    // biome-ignore lint/suspicious/noThenProperty: a lazy thenable is the point — await starts it.
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): Promise<TResult1 | TResult2> => get().then(onfulfilled, onrejected),
    catch: <TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<T | TResult> => get().catch(onrejected),
    finally: (onfinally?: (() => void) | null): Promise<T> =>
      get().finally(onfinally),
    [Symbol.toStringTag]: "Promise",
  };
  return thenable;
}

/** The statement roles an {@link ExplainResult} can carry. */
export type ExplainKey =
  | "data"
  | "total"
  | "count"
  | "exists"
  | "probe:hasNext"
  | "probe:hasPrevious";

/** One explained statement: the exact SurrealQL, its binds, and the server's plan. */
export interface ExplainStatement {
  readonly key: ExplainKey;
  readonly surql: string;
  readonly vars: Record<string, unknown>;
  readonly plan: unknown;
}

/** The diagnostic plan of a read — `.explain()` / `explain: true` never executes the real query. */
export interface ExplainResult {
  readonly driver: "surrealdb";
  readonly operation: string;
  readonly statements: readonly ExplainStatement[];
  /** Options the plan can't express (kept for parity; today always empty). */
  readonly ignoredOptions: readonly string[];
}

/**
 * Augment a lazy read with `.explain()`: calling it runs `EXPLAIN <sql>` for each compiled
 * statement (ONE round-trip) and never touches the real statement.
 */
export function attachExplain<T>(
  result: Promise<T>,
  explain: () => Promise<ExplainResult>,
): Promise<T> & { explain(): Promise<ExplainResult> } {
  return Object.assign(result, { explain });
}

/** The envelope of a batch operation. `count` = affected records; `data` only when RETURN yields rows. */
export interface BatchResult<T = unknown> {
  /** How many records the operation affected. */
  readonly count: number;
  /** The returned rows (`return` handed them back, or the driver supports RETURNING). */
  readonly data?: readonly T[];
  /** Items intentionally skipped (e.g. `onEmpty: 'return'`, duplicates with `ignore`). */
  readonly skipped?: number;
  /** How many statements the operation compiled into (telemetry). */
  readonly statements: number;
}

/** One statement's outcome in a batch `$query` / executor run. */
export interface StatementResult<T = unknown> {
  /** The statement's rows (or `undefined` when it failed). */
  readonly result: T;
  readonly status: "OK" | "ERR";
  /** Server-reported execution time (e.g. `"1.2ms"`), when stats are available. */
  readonly time?: string;
  /** The NORMALIZED failure, present iff `status === "ERR"`. */
  readonly error?: BetterSchemicError;
}

/**
 * Map one SDK `QueryResponse` (from `responses()`) to a {@link StatementResult}. The optional
 * `context` (table/operation/statementIndex/surql/vars) is attached to a failed response's
 * normalized error — that is how the executor attributes a failure to its statement.
 */
export function statementResult<T = unknown>(
  response: QueryResponse<T>,
  context: BetterSchemicErrorOptions = {},
): StatementResult<T> {
  if (response.success) {
    const duration = response.stats?.duration;
    return {
      result: response.result,
      status: "OK",
      ...(duration !== undefined ? { time: String(duration) } : {}),
    };
  }
  return {
    result: undefined as T,
    status: "ERR",
    error: normalizeError(response.error, context),
    ...(response.stats?.duration !== undefined
      ? { time: String(response.stats.duration) }
      : {}),
  };
}
