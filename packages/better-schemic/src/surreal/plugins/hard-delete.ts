/**
 * `better-schemic/plugins/hard-delete` — keep `delete` a PHYSICAL delete.
 *
 * The counterpart of `soft-delete`, for the tables where a tombstone is the wrong shape: machine
 * state rewritten on every event (a Signal session key, a queue entry, an idempotency record), where
 * a `deletedAt` tombstone would accumulate garbage and a UNIQUE index over the row would keep
 * blocking the next write.
 *
 * What it does — and, more importantly, what it does NOT:
 * - `delete`/`deleteMany` stay real `DELETE` statements (the server removes the row, edges included);
 * - reads untouch them — no `deleted:` filter injects it, because there is no tombstone to hide;
 * - `purge` is NOT added: that is what `delete` already is. The plugin's whole job is to make the
 * destructive intent EXPLICIT in code review and to be a no-op that documents itself, so it marks
 * the tables it's scoped to.
 *
 * Composing with `soft-delete`: give each plugin a `tables` list and they partition the schema —
 * a tombstoned table keeps its tombstones, a rewritten-state table loses its row. Without scoping,
 * whichever plugin runs first on a delete wins, so scoping is the intended composition, not an
 * error to caughts it.
 *
 * ```ts
 * import { hardDelete } from "./hard-delete";
 * const client = orm(db, { schema, plugins: [hardDelete({ tables: ["session_key"] })] });
 * // client.sessionKey.delete({ where: { id } }) -> DELETE session_key:…
 * ```
 */
import { definePlugin } from "../orm/plugins"
import type { Plugin } from "../orm/types/plugins"

/** The `hard-delete` plugin options. */
export type HardDeleteOptions = {
  /** A one-line reason recorded on the operation (shows up in the query log). */
  readonly reason?: string
  /**
   * The tables this plugin owns. Omitted = every table in the schema. Listing them makes the
   * destructive intent greppable — and lets a soft-deleted table keep its tombstones.
   */
  readonly tables?: readonly string[]
}

/** The plugin id (a second instance with different tables is a distinct plugin). */
const PLUGIN_ID = "better-schemic/hard-delete"

/** The optional reason, as the meta fragment that carries it (empty when none gives it). */
function hardDeleteReason(reason: string | undefined): Record<string, string> {
  return reason === undefined ? {} : { hardDeleteReason: reason }
}

/**
 * Mark `delete`/`deleteMany` as intentionally physical.
 *
 * The compiled statement unchangs it — this is a contract plugin, not a rewriting one: it exists
 * so a reader of the bootstrap knows that a `delete` on these tables loses the row forever, and so
 * the `rules` plugin/hook payload carries that intent (`meta.hardDelete`).
 */
export function hardDelete(options: HardDeleteOptions = {}): Plugin {
  const owned = options.tables ? new Set(options.tables) : undefined
  return definePlugin({
    config: { reason: options.reason, tables: options.tables ?? [] },
    description: "delete removes the row for good — no tombstone, no restore.",
    id: PLUGIN_ID,
    name: "Hard delete",
    transform(op) {
      if (op.kind !== "delete" && op.kind !== "deleteMany") return

      if (owned && !owned.has(op.table)) return

      // The intent travels with the operation: hooks, the rules plugin and the query log all see
      // that this DELETE is permanent (and why, when a reason gives it).
      op.meta = {
        ...op.meta,
        hardDelete: true,
        ...hardDeleteReason(options.reason),
      }
    },
  })
}
