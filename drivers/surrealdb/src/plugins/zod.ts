/**
 * `@better-schemic/surrealdb/plugins/zod` — validate a write's `data` with your own Zod schemas
 * before it compiles (the table codec already validates literal fields; this adds app-level rules
 * and produces a `ValidationError` carrying the Zod issue path).
 *
 * ```ts
 * import { zod } from "@better-schemic/surrealdb/plugins/zod";
 * const client = betterSchemic(db, {
 *   schema,
 *   plugins: [zod({ schemas: { user: z.object({ email: z.email() }) } })],
 * });
 * ```
 */
import type { z } from "zod";
import { BetterSchemicError } from "../orm/errors";
import { definePlugin } from "../orm/plugins";
import type { Plugin } from "../orm/types/plugins";

/** The zod plugin options. */
export interface ZodPluginOptions {
  /** A Zod schema per PHYSICAL table name (`user`, `likes`, …). */
  readonly schemas: Record<string, z.ZodType>;
  /** Which write families to validate (default: both). */
  readonly validate?: {
    readonly create?: boolean;
    readonly update?: boolean;
  };
}

const CREATE = new Set(["create", "createMany", "insert", "insertMany"]);
const UPDATE = new Set([
  "update",
  "updateMany",
  "updateEach",
  "upsert",
  "upsertMany",
]);

/** Validate one payload (or every item of a batch) with `schema`. */
function validateData(
  schema: z.ZodType,
  data: unknown,
  operation: string,
  table: string,
): void {
  const items = Array.isArray(data) ? data : [data];
  items.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) return;
    const issue = result.error.issues[0];
    const path = issue?.path?.join(".");
    const where =
      Array.isArray(data) && index !== undefined ? ` (item ${index})` : "";
    throw new BetterSchemicError(
      "ValidationError",
      `zod: ${operation} on "${table}"${where}${path ? ` at "${path}"` : ""}: ${issue?.message ?? "invalid data"}.`,
      { operation, table, field: path, details: result.error.issues },
    );
  });
}

/** The `zod` validation plugin. */
export function zod(options: ZodPluginOptions): Plugin {
  const validate = {
    create: options.validate?.create !== false,
    update: options.validate?.update !== false,
  };
  return definePlugin({
    id: "@better-schemic/surrealdb/zod",
    name: "Zod",
    description: "Validate write data with Zod schemas.",
    config: options,
    transform(op) {
      const isCreate = CREATE.has(op.kind);
      const isUpdate = UPDATE.has(op.kind);
      if (!isCreate && !isUpdate) return;
      if (isCreate && !validate.create) return;
      if (isUpdate && !validate.update) return;
      const schema = options.schemas[op.table];
      if (!schema) return;
      const data = op.args.data;
      if (data === undefined) return;
      validateData(schema, data, op.kind, op.table);
    },
  });
}
