/**
 * `better-schemic/plugins/soft-delete` — turn `delete` into a soft delete.
 *
 * - `delete`/`deleteMany` compile as an `UPDATE` that stamps the soft-delete column (with an
 * optional `deletedBy` actor from `meta`), so the row survives.
 * - Reads (`findMany`/`findFirst`/`findOne`/`count`/`exists`/`combine`/`paginate`/`cursor`)
 * hide soft-deleted rows unless the caller opts in with `deleted: "with" | ""`.
 * `findUnique` is EXEMPT: its `where` is the record TARGET (`id`/unique field), so it's never
 * rewritten — a soft-deleted row is still reachable by id (check `deletedAt` yourself, or query
 * with `findFirst({ deleted: "" })`).
 * - `restore({ where })` / `restoreById(id)` clear the column (via `extendModel`).
 *
 * ```ts
 * import { softDelete } from "./soft-delete";
 * const client = orm(db, { schema, plugins: [softDelete({ column: "deletedAt" })] });
 * ```
 */

import { surql } from "../index"
import { isReadOperation } from "../orm/hooks"
import { definePlugin } from "../orm/plugins"

/** The soft-delete plugin options. */
export type SoftDeleteOptions = {
  /** The `meta` key carrying the actor for {@link SoftDeleteOptions.deletedBy} (default `"actor"`). */
  readonly actorMeta?: string
  /** The timestamp column marking a deleted row (default `"deletedAt"`). */
  readonly column?: string
  /** The actor column to stamp (from `meta.<actorMeta>`); omitted when unset. */
  readonly deletedBy?: string
  /**
   * The tables this plugin owns. Omitted = every table. Scoping is what lets a schema mix
   * tombstoned rows with physically-deleted ones (pair it with the `hard-delete` plugin): a `delete`
   * on a table outside this list compiles as a real `DELETE`.
   */
  readonly tables?: readonly string[]
}

/** The `deleted:` read arg values. */
export type DeletedFilter = "only" | "with" | "without"

/** Widen the default read arg to the full filter union — a bare literal would narrow `PluginArgs`
 *  to `"without"` and reject the other `DeletedFilter` values at the call site. */
const defaultReadArgs: { deleted: DeletedFilter } = { deleted: "without" }

/** A delegate method grafted by the plugin. */
type Model = {
  update(args: { unset: readonly string[]; where: unknown }): unknown
}

/** The `soft-delete` plugin. */
export function softDelete(options: SoftDeleteOptions = {}) {
  const column = options.column ?? "deletedAt"
  const actorMeta = options.actorMeta ?? "actor"
  const owned = options.tables ? new Set(options.tables) : undefined
  return definePlugin({
    config: {
      actorMeta,
      column,
      deletedBy: options.deletedBy,
      tables: options.tables ?? [],
    },
    description: "Turn delete into a reversible soft delete.",
    extendModel({ model }) {
      const m = model as Model
      return {
        restore: (args: { where: unknown }) =>
          m.update({
            unset: [column],
            where: args.where,
          }),
        restoreById: (id: unknown) =>
          m.update({
            unset: [column],
            where: { id },
          }),
      }
    },
    id: "better-schemic/soft-delete",
    name: "Soft delete",
    operationArgs: {
      aggregate: defaultReadArgs,
      count: defaultReadArgs,
      cursor: defaultReadArgs,
      exists: defaultReadArgs,
      findFirst: defaultReadArgs,
      findMany: defaultReadArgs,
      findOne: defaultReadArgs,
      paginate: defaultReadArgs,
    },
    transform(op) {
      if (owned && !owned.has(op.table)) return

      if (op.kind === "delete" || op.kind === "deleteMany") {
        op.kind = op.kind === "delete" ? "update" : "updateMany"
        op.data[column] = surql`time::now()`
        const actorColumn = options.deletedBy
        const actor = actorColumn === undefined ? undefined : op.meta?.[actorMeta]
        if (actorColumn !== undefined && actor !== undefined) op.data[actorColumn] = actor

        return
      }
      // `findUnique` is EXEMPT: its `where` is the record TARGET (id/unique), never rewritten.
      if (!isReadOperation(op.kind) || op.kind === "findUnique") return

      const deleted = (op.args as { deleted?: DeletedFilter }).deleted
      if (deleted === "with") return

      if (deleted === "only") {
        op.where[column] = { isNotNone: true }
        return
      }
      op.where[column] = { isNone: true }
    },
  })
}
