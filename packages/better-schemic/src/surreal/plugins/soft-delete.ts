/**
 * `better-schemic/plugins/soft-delete` — turn `delete` into a soft delete.
 *
 * - `delete`/`deleteMany` compile as an `UPDATE` that stamps the soft-delete column (with an
 *   optional `deletedBy` actor from `meta`), so the row survives.
 * - Reads (`findMany`/`findFirst`/`findOne`/`count`/`exists`/`aggregate`/`paginate`/`cursor`)
 *   hide soft-deleted rows unless the caller opts in with `deleted: "with" | "only"`.
 *   `findUnique` is EXEMPT: its `where` is the record TARGET (`id`/unique field), so it is never
 *   rewritten — a soft-deleted row is still reachable by id (check `deletedAt` yourself, or query
 *   with `findFirst({ deleted: "only" })`).
 * - `restore({ where })` / `restoreById(id)` clear the column (via `extendModel`).
 *
 * ```ts
 * import { softDelete } from "./soft-delete";
 * const client = betterSchemic(db, { schema, plugins: [softDelete({ column: "deletedAt" })] });
 * ```
 */

import { surql } from "../index";
import { isReadOperation } from "../orm/hooks";
import { definePlugin } from "../orm/plugins";

/** The soft-delete plugin options. */
export interface SoftDeleteOptions {
  /** The timestamp column marking a deleted row (default `"deletedAt"`). */
  readonly column?: string;
  /** The actor column to stamp (from `meta.<actorMeta>`); omitted when unset. */
  readonly deletedBy?: string;
  /** The `meta` key carrying the actor for {@link SoftDeleteOptions.deletedBy} (default `"actor"`). */
  readonly actorMeta?: string;
  /**
   * The tables this plugin owns. Omitted = every table. Scoping is what lets a schema mix
   * tombstoned rows with physically-deleted ones (pair it with the `hard-delete` plugin): a `delete`
   * on a table outside this list compiles as a real `DELETE`.
   */
  readonly tables?: readonly string[];
}

/** The `deleted:` read arg values. */
export type DeletedFilter = "with" | "without" | "only";

/** A delegate method grafted by the plugin. */
type Model = {
  update(args: { where: unknown; unset: readonly string[] }): unknown;
};

/** The `soft-delete` plugin. */
export function softDelete(options: SoftDeleteOptions = {}) {
  const column = options.column ?? "deletedAt";
  const actorMeta = options.actorMeta ?? "actor";
  const owned = options.tables ? new Set(options.tables) : undefined;
  return definePlugin({
    id: "better-schemic/soft-delete",
    name: "Soft delete",
    description: "Turn delete into a reversible soft delete.",
    config: {
      column,
      deletedBy: options.deletedBy,
      actorMeta,
      tables: options.tables ?? [],
    },
    operationArgs: {
      findMany: { deleted: "without" as DeletedFilter },
      findFirst: { deleted: "without" as DeletedFilter },
      findOne: { deleted: "without" as DeletedFilter },
      count: { deleted: "without" as DeletedFilter },
      exists: { deleted: "without" as DeletedFilter },
      aggregate: { deleted: "without" as DeletedFilter },
      paginate: { deleted: "without" as DeletedFilter },
      cursor: { deleted: "without" as DeletedFilter },
    },
    transform(op) {
      if (owned && !owned.has(op.table)) return;
      if (op.kind === "delete" || op.kind === "deleteMany") {
        op.kind = op.kind === "delete" ? "update" : "updateMany";
        op.data[column] = surql`time::now()`;
        const actorColumn = options.deletedBy;
        const actor =
          actorColumn !== undefined ? op.meta?.[actorMeta] : undefined;
        if (actorColumn !== undefined && actor !== undefined)
          op.data[actorColumn] = actor;
        return;
      }
      // `findUnique` is EXEMPT: its `where` is the record TARGET (id/unique), never rewritten.
      if (!isReadOperation(op.kind) || op.kind === "findUnique") return;
      const deleted = (op.args as { deleted?: DeletedFilter }).deleted;
      if (deleted === "with") return;
      if (deleted === "only") {
        op.where[column] = { isNotNone: true };
        return;
      }
      op.where[column] = { isNone: true };
    },
    extendModel({ model }) {
      const m = model as Model;
      return {
        restore: (args: { where: unknown }) =>
          m.update({
            where: args.where,
            unset: [column],
          }),
        restoreById: (id: unknown) =>
          m.update({
            where: { id },
            unset: [column],
          }),
      };
    },
  });
}
