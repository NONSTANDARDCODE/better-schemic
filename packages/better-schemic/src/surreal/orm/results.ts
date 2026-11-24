/**
 * The result wrappers every delegate operation returns — the honest shapes from the prototype:
 *
 * - reads that may miss -> {@link ThrowingResult} (`await` gives `T | null`, `.throw()` gives `T`)
 * - batches -> {@link BatchResult} (`count` always; `data` when RETURN hands rows back)
 * - raw multi-statement -> {@link StatementResult} (`status` per statement)
 *
 * `attachThrow` mirrors better-drizzle's `attachThrow` (`shared/client/hooks.ts:314-385`): the
 * thenable augments it in place, so there is zero cost when `.throw()` is never called.
 */
import type { QueryResponse } from "surrealdb"

import { normalizeError, OrmError, type OrmErrorOptions } from "./errors"
import type { LogStatement } from "./types/logger"

/** Where-clause preview budget in a log message. */
const WHERE_PREVIEW_LIMIT = 200

/** Context handed to `.throw()` factories so error messages can name the target. */
export type NotFoundInfo = {
  /** The delegate operation, e.g. `"findUnique"` / `"update"` / `"delete"`. */
  readonly operation: string
  /** The SurrealQL emitted for the statement. */
  readonly surql?: string
  /** The table/edge the operation targeted (physical name). */
  readonly table: string
  /** The bound variables of the statement. */
  readonly vars?: Record<string, unknown>
  /** The filter that matched nothing (verbatim, for the factory). */
  readonly where?: unknown
}

/** A read/write that may miss: `await` yields `T | null`; `.throw()` yields `T` or throws. */
export type ThrowingResult<T> = Promise<null | T> & {
  throw(factory?: (info: NotFoundInfo) => Error): Promise<T>
}

/** Short, safe rendering of a filter for the default not-found message. */
function describeWhere(where: unknown): string {
  if (where === undefined) return ""

  let text: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string,@typescript-eslint/no-unnecessary-condition -- stringify de valor opaco é intencional
    text = JSON.stringify(where) ?? String(where)
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- stringify de valor opaco é intencional (toJSON/toString definidos pelo chamador)
    text = String(where)
  }
  return ` matching ${text.length > WHERE_PREVIEW_LIMIT ? `${text.slice(0, WHERE_PREVIEW_LIMIT)}…` : text}`
}

/**
 * Augment a `Promise<T | null>` with `.throw()`: called on a missing (`null`/`undefined`) result it
 * invokes the factory (or throws a default `ResultNotFound`), otherwise it resolves the value.
 */
export function attachThrow<T>(
  promise: Promise<null | T>,
  info: (() => NotFoundInfo) | NotFoundInfo,
): ThrowingResult<T> {
  const getInfo = typeof info === "function" ? info : (): NotFoundInfo => info
  return Object.assign(promise, {
    throw(factory?: (info: NotFoundInfo) => Error): Promise<T> {
      return promise.then((value) => {
        if (value === null || value === undefined) {
          const notFound = getInfo()
          if (factory) throw factory(notFound)

          throw new OrmError(
            "ResultNotFound",
            `${notFound.table}: no record matched ${notFound.operation}${describeWhere(notFound.where)}`,
            {
              details: notFound.where,
              operation: notFound.operation,
              surql: notFound.surql,
              table: notFound.table,
              vars: notFound.vars,
            },
          )
        }
        return value
      })
    },
  })
}

/**
 * A LAZY thenable: the operation  runs when the result awaits it (`then`/`catch`/`onRejected`),
 * so `.explain()` can inspect the compiled statements without executing the query. Compilation
 * itself stays eager — a bad arg throws at call time, not as an unhandled rejection.
 */
export function lazyResult<T>(run: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined
  const get = (): Promise<T> => (started ??= run())
  // A `Promise` needs then/catch/+ the tag, so the annotation IS the contract.
  const thenable: Promise<T> = {
    catch: <TResult = never>(
      onrejected?: ((reason: unknown) => PromiseLike<TResult> | TResult) | null,
    ): Promise<T | TResult> => get().catch(onrejected),
    finally: (onfinally?: (() => void) | null): Promise<T> => get().finally(onfinally),
    [Symbol.toStringTag]: "Promise",
    // eslint-disable-next-line unicorn/no-thenable -- thenable é contrato público: resultado lazy aguardável sem executar
    then: <TResult1 = T, TResult2 = never>(
      onfulfilled?: ((value: T) => PromiseLike<TResult1> | TResult1) | null,
      onrejected?: ((reason: unknown) => PromiseLike<TResult2> | TResult2) | null,
    ): Promise<TResult1 | TResult2> => get().then(onfulfilled, onrejected),
  }
  return thenable
}

/** The statement roles an {@link ExplainResult} can carry. */
export type ExplainKey =
  "count" | "data" | "exists" | "probe:hasNext" | "probe:hasPrevious" | "total"

/** One explained statement: the exact SurrealQL, its binds, and the server's plan. */
export type ExplainStatement = {
  readonly key: ExplainKey
  readonly plan: unknown
  readonly surql: string
  readonly vars: Record<string, unknown>
}

/** The diagnostic plan of a read — `.explain()` / `explain: true` never executes the real query. */
export type ExplainResult = {
  readonly driver: "surrealdb"
  /** Options the plan can't express (kept for parity; today always empty). */
  readonly ignoredOptions: readonly string[]
  readonly operation: string
  readonly statements: readonly ExplainStatement[]
}

/**
 * Augment a lazy read with `.explain()`: calling it runs `EXPLAIN <sql>` for each compiled
 * statement (ONE round-trip) and never touches the real statement.
 */
export function attachExplain<T>(
  result: Promise<T>,
  explain: () => Promise<ExplainResult>,
): Promise<T> & { explain(): Promise<ExplainResult> } {
  return Object.assign(result, { explain })
}

/**
 * A server-free preview of the SurrealQL an operation would send. it's derived from the SAME
 * compiled statements the executor runs (including plugin/`$withContext` lowering), so it cannot
 * drift from the real script — but it never touches the connection, fires no hooks and returns no
 * rows. Binds stay as SDK values (`RecordId`, `Date`, …); they render them for logs, not strings.
 */
export type SqlPreview = {
  readonly driver: "surrealdb"
  readonly operation: string
  /** The exact script the executor would hand to `conn.query` (USE prefix + wrapper + statements). */
  readonly script: string
  /** The user statements in order, with binds (never the `USE`/`BEGIN` control statements). */
  readonly statements: readonly LogStatement[]
  readonly table: string
  /** True when the executor would wrap the batch in `BEGIN/COMMIT`. */
  readonly transactional: boolean
}

/** Attach `.toSQL()` to any result — the mirror of {@link attachExplain}, but synchronous. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types -- tipo `object` é contrato público/duck-typing: trocar por Record<string, unknown> estreita a API e quebra inferência
export function attachSql<T extends object>(
  result: T,
  toSQL: () => SqlPreview,
): T & { toSQL(): SqlPreview } {
  return Object.assign(result, { toSQL })
}

/** The envelope of a batch operation. `count` = affected records; `data` when RETURN yields rows. */
export type BatchResult<T = unknown> = {
  /**
   * How  records the operation affected (`data.length`). `undefined` when the operation ran
   * with `return: 'none'` — the server returns no rows, so the affected count is genuinely unknown.
   */
  readonly count?: number
  /** The returned rows (`return` handed them back, or the driver supports RETURNING). */
  readonly data?: readonly T[]
  /** Items intentionally skipped (e.g. `onEmpty: 'return'`, duplicates with `ignore`). */
  readonly skipped?: number
  /** How some statements the operation compiled into (telemetry). */
  readonly statements: number
}

/** One statement's outcome in a batch `$query` / executor run. */
export type StatementResult<T = unknown> = {
  /** The NORMALIZED failure, present iff `status === "ERR"`. */
  readonly error?: OrmError
  /** The statement's rows (or `undefined` when it failed). */
  readonly result: T
  readonly status: "ERR" | "OK"
  /** Server-reported execution time (e.g. `"1.2ms"`), when stats are available. */
  readonly time?: string
}

/**
 * Map one SDK `QueryResponse` (from `responses()`) to a {@link StatementResult}. The optional
 * `context` (table/operation/statementIndex/surql/vars) attachs it to a failed response's
 * normalized error — that is how the executor attributes a failure to its statement.
 */
export function statementResult<T = unknown>(
  response: QueryResponse<T>,
  context: OrmErrorOptions = {},
): StatementResult<T> {
  if (response.success) {
    const duration = response.stats?.duration
    return {
      result: response.result,
      status: "OK",
      ...(duration === undefined ? {} : { time: String(duration) }),
    }
  }
  return {
    error: normalizeError(response.error, context),
    result: undefined as T,
    status: "ERR",
    ...(response.stats?.duration === undefined ? {} : { time: String(response.stats.duration) }),
  }
}
