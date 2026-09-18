/**
 * The read-clause compiler — `orderBy`/`limit`/`start`/`range`/`split`/`groupBy`/`groupAll`/`with`/
 * `timeout`/`version` -> one `SELECT` statement, with the projection coming from
 * `./projection` (SQL text + decode spec in one pass).
 *
 * Clause ORDER is not cosmetic: it is live-verified (`docs/orm-syntax-map.md` §3) that `WITH` sits
 * before `WHERE`, `SPLIT` after it, `VERSION` before `TIMEOUT`, and that parenthesized expressions
 * are a parse error in `ORDER BY`. The compiler emits the one accepted order.
 */
import { escapeIdent } from "surrealdb";
import type { ModelMeta } from "../meta";
import { compileProjection, type ProjectionSpec } from "./projection";
import {
  type Binds,
  compileError,
  compileWithClause,
  datetimeLiteral,
  describeValue,
  durationLiteral,
  isPlainObject,
  isTableMeta,
  nonNegativeInt,
  pathList,
  pathSegments,
  rangeTarget,
  rejectRemovedArgs,
  renderBareFragment,
  renderPath,
} from "./shared";
import { compileWhere } from "./where";

/** The compiled form of one read. */
export interface CompiledRead {
  readonly sql: string;
  readonly projection: ProjectionSpec;
  /** `FROM ONLY` — the result is a single object (or a miss). */
  readonly only: boolean;
}

/** The runtime read args the compiler validates (types live in `../types/select`). */
export interface ReadArgs {
  where?: unknown;
  select?: unknown;
  omit?: unknown;
  orderBy?: unknown;
  limit?: unknown;
  start?: unknown;
  range?: unknown;
  split?: unknown;
  groupBy?: unknown;
  groupAll?: unknown;
  only?: unknown;
  value?: unknown;
  with?: unknown;
  timeout?: unknown;
  version?: unknown;
  meta?: unknown;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown;
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown;
  take?: unknown;
  skip?: unknown;
}

/** Compiler overrides for the operations that wrap a read (findUnique targets a record). */
export interface CompileReadOptions {
  /** Replace the `FROM` target (e.g. `ONLY user:aeon`). */
  readonly target?: string;
}

/** Compile a read into its statement + decode spec (binds accumulate into `binds`). */
export function compileRead(
  meta: ModelMeta,
  args: ReadArgs,
  binds: Binds,
  operation = "findMany",
  options: CompileReadOptions = {},
): CompiledRead {
  rejectRemovedArgs(args, operation);

  const only = args.only === true;
  const value = args.value === true;
  const splitPath =
    typeof args.split === "string" ? pathSegments(args.split) : undefined;
  const { text: projectionText, spec } = compileProjection(
    meta,
    args.select,
    args.omit,
    value,
    binds,
    operation,
    splitPath,
  );

  const groupBy = pathList(args.groupBy, "groupBy");
  const groupAll = args.groupAll === true;
  if (args.split !== undefined && (groupBy.length > 0 || groupAll))
    throw compileError(
      "ClauseNotSupported",
      `${operation}: SPLIT and GROUP BY/ALL are mutually exclusive in SurrealQL — group the unsplit rows, or split in a second query.`,
      { operation },
    );
  if (groupBy.length > 0 && groupAll)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: pass "groupBy" OR "groupAll", not both.`,
      { operation },
    );
  if ((groupBy.length > 0 || groupAll) && args.select === undefined && !value)
    throw compileError(
      "ValidationError",
      `${operation}: GROUP BY/ALL needs an explicit "select" (or "value") — a grouped row has no full-table shape. Use aggregate() for counts/sums.`,
      { operation },
    );

  const parts: string[] = [
    `SELECT ${value ? "VALUE " : ""}${projectionText}`,
    `FROM ${
      options.target ?? compileTarget(meta, args.range, only, operation)
    }`,
  ];

  if (args.with !== undefined)
    parts.push(compileWithClause(args.with, operation));
  const where = compileWhere(args.where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
  });
  if (where) parts.push(`WHERE ${where}`);
  if (args.split !== undefined)
    parts.push(`SPLIT ${compileSplit(args.split, binds, operation)}`);
  if (groupAll) parts.push("GROUP ALL");
  else if (groupBy.length > 0)
    parts.push(`GROUP BY ${groupBy.map(renderPath).join(", ")}`);
  if (args.orderBy !== undefined)
    parts.push(compileOrderBy(args.orderBy, binds, operation));
  if (args.limit !== undefined)
    parts.push(
      `LIMIT ${binds.add(nonNegativeInt(args.limit, "limit", operation))}`,
    );
  if (args.start !== undefined)
    parts.push(
      `START ${binds.add(nonNegativeInt(args.start, "start", operation))}`,
    );
  if (args.version !== undefined)
    parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`);
  if (args.timeout !== undefined)
    parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);

  return { sql: parts.join(" "), projection: spec, only };
}

// --- target / clauses ----------------------------------------------------------------------------

/** `FROM <table>` / `FROM ONLY <table>` / `FROM <table>:<start>..<end>`. */
function compileTarget(
  meta: ModelMeta,
  range: unknown,
  only: boolean,
  operation: string,
): string {
  const table = escapeIdent(meta.name);
  if (range === undefined) return only ? `ONLY ${table}` : table;
  if (only)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: "only" and "range" are mutually exclusive — a range can yield many records.`,
      { operation },
    );
  return rangeTarget(meta, range, operation);
}

/** `SPLIT field` / `SPLIT <fragment>`. */
function compileSplit(split: unknown, binds: Binds, operation: string): string {
  if (typeof split === "string") return renderPath(split);
  const bare = renderBareFragment(split, binds);
  if (bare !== undefined) return bare;
  throw compileError(
    "ValidationError",
    `${operation}: split must be a field path or a fragment, got ${describeValue(split)}.`,
    { operation },
  );
}

/** `ORDER BY a ASC, b DESC` (fragments splice bare — parens are a parse error there). */
export function compileOrderBy(
  orderBy: unknown,
  binds: Binds,
  operation: string,
): string {
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (entries.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: orderBy is empty — pass at least one field or expression.`,
      { operation },
    );
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry === undefined) continue;
    const bare = renderBareFragment(entry, binds);
    if (bare !== undefined) {
      parts.push(bare);
      continue;
    }
    if (!isPlainObject(entry))
      throw compileError(
        "ValidationError",
        `${operation}: orderBy entries must be { field: "asc" | "desc" } or a fragment, got ${describeValue(entry)}.`,
        { operation },
      );
    for (const [key, direction] of Object.entries(entry)) {
      if (direction === undefined) continue;
      if (typeof direction === "string") {
        const upper = direction.toUpperCase();
        if (upper !== "ASC" && upper !== "DESC")
          throw compileError(
            "ValidationError",
            `${operation}: orderBy direction must be "asc" or "desc", got "${direction}".`,
            { operation },
          );
        parts.push(`${renderPath(key)} ${upper}`);
        continue;
      }
      const expr = renderBareFragment(direction, binds);
      if (expr !== undefined) {
        parts.push(expr);
        continue;
      }
      throw compileError(
        "ValidationError",
        `${operation}: orderBy entry "${key}" must be "asc" | "desc" or a fragment (got ${describeValue(direction)}).`,
        { operation },
      );
    }
  }
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: orderBy is empty — pass at least one field or expression.`,
      { operation },
    );
  return `ORDER BY ${parts.join(", ")}`;
}

// --- literals & small helpers --------------------------------------------------------------------
