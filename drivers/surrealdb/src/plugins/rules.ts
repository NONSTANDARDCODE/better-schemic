/**
 * `@better-schemic/surrealdb/plugins/rules` — guardrails that fail fast BEFORE a statement reaches
 * the database: no raw `$unsafe`, no destructive write without a filter, a required limit (and a
 * max), an orderBy for cursors, and optional `strict` field checking against the schema.
 *
 * ```ts
 * import { recommended } from "@better-schemic/surrealdb/plugins/rules";
 * const client = betterSchemic(db, { schema, plugins: [recommended({ maxLimit: 100 })] });
 * ```
 */

import { BetterSchemicError } from "../orm/errors";
import type { SchemaIndex } from "../orm/meta";
import { definePlugin } from "../orm/plugins";
import type { Plugin } from "../orm/types/plugins";

/** The guardrails the `rules` plugin can enforce. */
export interface RulesOptions {
  /** Reject `$unsafe` (the parameterized `$raw`/`$query` stay available). */
  readonly noRawUnsafe?: boolean;
  /** Reject `updateMany`/`deleteMany` with no `where` (unless `all: true`). */
  readonly destructiveWriteWithoutWhere?: boolean;
  /** Require an explicit `limit` on `findMany`. */
  readonly requireLimit?: boolean;
  /** Require an explicit `orderBy` on `cursor`. */
  readonly requireOrderByForCursor?: boolean;
  /** Reject a `limit` above this number (`findMany`/`paginate`). */
  readonly maxLimit?: number;
  /** Reject unknown fields in `data`/`where`/`select` (`UnknownField`). */
  readonly strict?: boolean;
}

const LOGICAL = new Set(["AND", "OR", "NOT"]);

const fail = (message: string, operation: string, table?: string): never => {
  throw new BetterSchemicError("UnsafeMutation", message, {
    operation,
    ...(table ? { table } : {}),
  });
};

/** Known keys of a model: columns, links, adjacent edge names and the id. */
function knownFields(
  index: SchemaIndex | undefined,
  table: string,
): Set<string> {
  const meta = index?.byName.get(table);
  const out = new Set<string>(["id"]);
  if (!meta || "schemaless" in meta) return out;
  for (const key of meta.columns.keys()) out.add(key);
  for (const key of meta.links.keys()) out.add(key);
  for (const edge of meta.outgoing) out.add(edge.name);
  for (const edge of meta.incoming) out.add(edge.name);
  return out;
}

/** Check the top-level keys of a filter/payload against the schema. */
function assertFields(
  value: unknown,
  known: Set<string>,
  operation: string,
  table: string,
  what: string,
): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (
      LOGICAL.has(key) ||
      key === "*" ||
      key.includes(".") ||
      key.includes("[")
    )
      continue;
    if (!known.has(key))
      throw new BetterSchemicError(
        "UnknownField",
        `${operation}: "${key}" is not a field of "${table}" (${what}). Known: ${[...known].join(", ")}.`,
        { operation, table, field: key },
      );
  }
}

/**
 * The `rules` guardrail plugin. Presets (`safe`/`recommended`/`strict`) are thin wrappers around it.
 */
export function rules(options: RulesOptions = {}): Plugin {
  let index: SchemaIndex | undefined;
  return definePlugin({
    id: "@better-schemic/surrealdb/rules",
    name: "Rules",
    description: "Guardrails for raw/writes/limits/fields.",
    config: options,
    setup(ctx) {
      index = ctx.index;
    },
    hooks: {
      beforeRaw: ({ operation, surql }) => {
        if (options.noRawUnsafe && operation === "$unsafe")
          throw new BetterSchemicError(
            "UnsafeMutation",
            `rules: $unsafe is disabled by the rules plugin — use $raw/$query (parameterized) instead. ${surql}`,
            { operation },
          );
      },
    },
    transform(op) {
      const kind = op.kind;
      const args = op.args;
      if (
        options.destructiveWriteWithoutWhere &&
        (kind === "updateMany" || kind === "deleteMany") &&
        args.where === undefined &&
        args.all !== true
      )
        fail(
          `rules: ${kind} without a "where" would touch the whole table — add a filter or pass all: true.`,
          kind,
          op.table,
        );
      if (
        options.requireLimit &&
        kind === "findMany" &&
        args.limit === undefined
      )
        fail(
          'rules: findMany requires an explicit "limit" — add one (or use paginate/cursor).',
          kind,
          op.table,
        );
      if (
        options.maxLimit !== undefined &&
        typeof args.limit === "number" &&
        args.limit > options.maxLimit
      )
        fail(
          `rules: limit ${args.limit} exceeds maxLimit ${options.maxLimit}.`,
          kind,
          op.table,
        );
      if (
        options.requireOrderByForCursor &&
        kind === "cursor" &&
        args.orderBy === undefined
      )
        fail('rules: cursor requires an explicit "orderBy".', kind, op.table);
      if (options.strict) {
        const known = knownFields(index, op.table);
        assertFields(op.args.data, known, kind, op.table, "data");
        assertFields(op.args.where, known, kind, op.table, "where");
        assertFields(op.args.select, known, kind, op.table, "select");
      }
    },
  });
}

/** The conservative preset: `$unsafe` off, no unfiltered destructive writes. */
export function safe(options: RulesOptions = {}): Plugin {
  return rules({
    noRawUnsafe: true,
    destructiveWriteWithoutWhere: true,
    ...options,
  });
}

/** The balanced preset: `safe` + a required/max limit. */
export function recommended(
  options: RulesOptions & { maxLimit?: number } = {},
): Plugin {
  return rules({
    noRawUnsafe: true,
    destructiveWriteWithoutWhere: true,
    requireLimit: true,
    maxLimit: options.maxLimit ?? 1000,
    ...options,
  });
}

/** The strict preset: `recommended` + strict field checking + cursor orderBy. */
export function strict(options: RulesOptions = {}): Plugin {
  return rules({
    noRawUnsafe: true,
    destructiveWriteWithoutWhere: true,
    requireLimit: true,
    requireOrderByForCursor: true,
    strict: true,
    maxLimit: options.maxLimit ?? 1000,
    ...options,
  });
}
