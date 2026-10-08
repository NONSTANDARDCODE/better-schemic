/**
 * `@better-schemic/surrealdb/plugins/timestamps` — fill `createdAt`/`updatedAt` automatically.
 *
 * Two modes:
 * - `"app"` (default): the client stamps `time::now()` (a `surql` expression) into the payload on
 *   create/update/upsert — the schema does not need `VALUE time::now()`.
 * - `"database"`: the timestamps are owned by the table's `DEFINE FIELD … VALUE time::now()`; the
 *   plugin only ensures no write CLOBBERS the managed value (it strips the columns from the payload).
 *
 * A create-only table (`createOnly()` / `tenant(…, { createOnly: true })`) never gets `updatedAt`:
 * the marker is read per operation, so the skip is independent of plugin registration order.
 *
 * ```ts
 * import { timestamps } from "@better-schemic/surrealdb/plugins/timestamps";
 * const client = betterSchemic(db, { schema, plugins: [timestamps({ createdAt: "createdAt" })] });
 * ```
 */
import { surql } from "../index";
import { isCreateOperation, isUpdateOperation } from "../orm/hooks";
import { definePlugin } from "../orm/plugins";
import type { Plugin } from "../orm/types/plugins";
import { createOnlyTags } from "./create-only-shared";

/** The `timestamps` plugin options. */
export interface TimestampsOptions {
  /** The created-at column (default `"createdAt"`). */
  readonly createdAt?: string;
  /** The updated-at column (default `"updatedAt"`). */
  readonly updatedAt?: string;
  /**
   * `"app"` stamps `time::now()` from the client; `"database"` defers to the schema's
   * `VALUE time::now()` and only strips the columns from writes. Default `"app"`.
   */
  readonly mode?: "app" | "database";
}

/** The `timestamps` plugin. */
export function timestamps(options: TimestampsOptions = {}): Plugin {
  const createdAt = options.createdAt ?? "createdAt";
  const updatedAt = options.updatedAt ?? "updatedAt";
  const mode = options.mode ?? "app";
  return definePlugin({
    id: "@better-schemic/surrealdb/timestamps",
    name: "Timestamps",
    description: "Fill createdAt/updatedAt on writes.",
    config: { createdAt, updatedAt, mode },
    transform(op) {
      const isCreate = isCreateOperation(op.kind);
      const isUpdate = isUpdateOperation(op.kind);
      if (!isCreate && !isUpdate) return;
      // A create-only (append-only) table never carries `updatedAt` — not on create, not on a
      // bypassed update. The per-index lookup is cached; untagged tables take one `Map.has`.
      const createOnly = createOnlyTags(op.index).has(op.table);
      if (mode === "app") {
        if (isCreate) {
          op.data[createdAt] = surql`time::now()`;
          if (!createOnly) op.data[updatedAt] = surql`time::now()`;
        } else if (!createOnly) {
          op.data[updatedAt] = surql`time::now()`;
        }
        return;
      }
      // mode === "database": the schema owns the values — strip them from the payload if present
      // (never materialize `data`: a transform that only reads must not inject an empty object).
      const data = op.args.data;
      if (data !== undefined && !Array.isArray(data)) {
        delete (data as Record<string, unknown>)[createdAt];
        delete (data as Record<string, unknown>)[updatedAt];
      }
    },
  });
}
