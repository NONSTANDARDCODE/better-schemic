/**
 * The aggregate compiler — `count`/`exists` and `aggregate`. These reads project ONE computed
 * value per row, so they don't go through `compiler/select`'s projection/decode machinery: each
 * operation compiles its own statement and interprets the raw rows.
 *
 * Live-verified shapes (`docs/orm-syntax-map.md` §3):
 * - `count()` WITHOUT `GROUP ALL` is one row per record — `count` always emits `GROUP ALL`;
 * - `math::*` needs the grouped (array) input `GROUP ALL`/`GROUP BY` provides;
 * - `SELECT VALUE id … LIMIT n` is the exists probe;
 * - `math::avg` does not exist in 3.x — the API's `avg` emits `math::mean`.
 */
import { escapeIdent } from "surrealdb";
import type { ModelMeta } from "../meta";
import {
  type ProjectedField,
  type ProjectionSpec,
  projectedFieldFor,
} from "./projection";
import { compileOrderBy } from "./select";
import {
  type Binds,
  compileError,
  compileWithClause,
  datetimeLiteral,
  describeValue,
  durationLiteral,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  nonNegativeInt,
  pathList,
  pathSegments,
  rangeTarget,
  rejectRemovedArgs,
  renderPath,
  renderValue,
} from "./shared";
import { compileWhere } from "./where";

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export interface CountArgs {
  where?: unknown;
  range?: unknown;
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

/** The `FROM` target of `count`/`exists`: the table, or a record range (`t:1..=2`). */
function aggregateTarget(
  meta: ModelMeta,
  range: unknown,
  operation: string,
): string {
  return range === undefined
    ? escapeIdent(meta.name)
    : rangeTarget(meta, range, operation);
}

/** `SELECT count() FROM <target> [WHERE …] GROUP ALL [VERSION …] [TIMEOUT …]`. */
export function compileCount(
  meta: ModelMeta,
  args: CountArgs,
  binds: Binds,
  operation = "count",
): string {
  rejectRemovedArgs(args, operation);
  const parts: string[] = [
    "SELECT count()",
    `FROM ${aggregateTarget(meta, args.range, operation)}`,
  ];
  if (args.with !== undefined)
    parts.push(compileWithClause(args.with, operation));
  const where = compileWhere(args.where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
  });
  if (where) parts.push(`WHERE ${where}`);
  parts.push("GROUP ALL");
  if (args.version !== undefined)
    parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`);
  if (args.timeout !== undefined)
    parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);
  return parts.join(" ");
}

/** `SELECT VALUE id FROM <target> [WHERE …] LIMIT 1 [VERSION …] [TIMEOUT …]`. */
export function compileExists(
  meta: ModelMeta,
  args: CountArgs,
  binds: Binds,
  operation = "exists",
): string {
  rejectRemovedArgs(args, operation);
  const parts: string[] = [
    "SELECT VALUE id",
    `FROM ${aggregateTarget(meta, args.range, operation)}`,
  ];
  if (args.with !== undefined)
    parts.push(compileWithClause(args.with, operation));
  const where = compileWhere(args.where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
  });
  if (where) parts.push(`WHERE ${where}`);
  parts.push(`LIMIT ${binds.add(1)}`);
  if (args.version !== undefined)
    parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`);
  if (args.timeout !== undefined)
    parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);
  return parts.join(" ");
}

// --- aggregate -----------------------------------------------------------------------------------

/** The clauses `aggregate` accepts (having does NOT exist in SurrealQL — rejected). */
export interface AggregateArgs {
  where?: unknown;
  select?: unknown;
  groupBy?: unknown;
  groupAll?: unknown;
  orderBy?: unknown;
  limit?: unknown;
  start?: unknown;
  with?: unknown;
  timeout?: unknown;
  version?: unknown;
  meta?: unknown;
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown;
  /** Not expressible in SurrealQL — always rejected with `HavingUnsupported`. */
  having?: unknown;
  /** SPLIT and GROUP are mutually exclusive — rejected with `ClauseNotSupported`. */
  split?: unknown;
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown;
  take?: unknown;
  skip?: unknown;
}

/**
 * The math aggregators (API name -> `math::<fn>`). `avg` maps to `math::mean`: SurrealDB 3.x has
 * no `math::avg` (live-verified — it's a parse error), while the API keeps the SQL-familiar name.
 */
const MATH_OPS: Record<string, string> = {
  sum: "sum",
  avg: "mean",
  min: "min",
  max: "max",
  median: "median",
  stddev: "stddev",
  variance: "variance",
};

/** A compiled aggregate: the statement + how to decode its rows. */
export interface CompiledAggregate {
  readonly sql: string;
  readonly projection: ProjectionSpec;
}

/**
 * `aggregate` — `SELECT <agregadores> FROM t [WHERE] GROUP BY/ALL [ORDER BY] [LIMIT/START]`.
 * `having` is rejected (SurrealQL has no HAVING); with neither `groupBy` nor `groupAll`, `GROUP ALL`
 * is implied (one row over the whole filter, the natural aggregate default).
 */
export function compileAggregate(
  meta: ModelMeta,
  args: AggregateArgs,
  binds: Binds,
  operation = "aggregate",
): CompiledAggregate {
  rejectRemovedArgs(args, operation);
  if (args.having !== undefined)
    throw compileError(
      "HavingUnsupported",
      `${operation}: HAVING does not exist in SurrealQL — filter the grouped rows with a subquery via $query, or aggregate in two steps.`,
      { operation },
    );
  if (args.split !== undefined)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: SPLIT and GROUP are mutually exclusive in SurrealQL — aggregate cannot split.`,
      { operation },
    );
  const groupBy = pathList(args.groupBy, "groupBy", operation);
  const groupAll = args.groupAll === true;
  if (groupBy.length > 0 && groupAll)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: pass "groupBy" OR "groupAll", not both.`,
      { operation },
    );

  const { parts, fields, projectedPaths, hasExpression } =
    compileAggregateSelect(meta, args.select, binds, operation);
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one aggregator or group key.`,
      { operation },
    );

  // SurrealDB requires every GROUP BY key in the projection ("Missing group idiom"); catch it here
  // with a teaching error when the projection is statically analyzable.
  if (groupBy.length > 0 && !hasExpression)
    for (const key of groupBy)
      if (!projectedPaths.has(key))
        throw compileError(
          "ValidationError",
          `${operation}: groupBy key "${key}" is missing from select — add it as \`${key}: "${key}"\` (SurrealDB requires every group key in the projection).`,
          { operation },
        );

  const statement: string[] = [
    `SELECT ${parts.join(", ")}`,
    `FROM ${escapeIdent(meta.name)}`,
  ];
  if (args.with !== undefined)
    statement.push(compileWithClause(args.with, operation));
  const where = compileWhere(args.where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
  });
  if (where) statement.push(`WHERE ${where}`);
  statement.push(
    groupBy.length > 0
      ? `GROUP BY ${groupBy.map(renderPath).join(", ")}`
      : "GROUP ALL",
  );
  if (args.orderBy !== undefined)
    statement.push(compileOrderBy(args.orderBy, binds, operation));
  if (args.limit !== undefined)
    statement.push(
      `LIMIT ${binds.add(nonNegativeInt(args.limit, "limit", operation))}`,
    );
  if (args.start !== undefined)
    statement.push(
      `START ${binds.add(nonNegativeInt(args.start, "start", operation))}`,
    );
  if (args.version !== undefined)
    statement.push(`VERSION ${datetimeLiteral(args.version, operation)}`);
  if (args.timeout !== undefined)
    statement.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);

  return {
    sql: statement.join(" "),
    projection: { star: false, fields, omit: [], value: false },
  };
}

/** Compile the aggregate `select` entries into SQL + decode fields. */
function compileAggregateSelect(
  meta: ModelMeta,
  select: unknown,
  binds: Binds,
  operation: string,
): {
  parts: string[];
  fields: ProjectedField[];
  projectedPaths: Set<string>;
  hasExpression: boolean;
} {
  if (!isPlainObject(select) || Object.keys(select).length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select must be a non-empty object of aggregators/group keys (got ${describeValue(select)}).`,
      { operation },
    );
  const parts: string[] = [];
  const fields: ProjectedField[] = [];
  const projectedPaths = new Set<string>();
  let hasExpression = false;

  for (const [key, entry] of Object.entries(select)) {
    if (entry === undefined || entry === false) continue;
    if (entry === true) {
      // `_count` is the count() shorthand; any other `true` projects the field itself.
      if (key === "_count") {
        parts.push("count() AS _count");
        fields.push({
          out: [key],
          source: [key],
          expr: "count()",
          each: false,
        });
        continue;
      }
      parts.push(renderPath(key));
      projectedPaths.add(key);
      fields.push(projectedFieldFor(meta, [key], [key], [key]));
      continue;
    }
    if (typeof entry === "string") {
      parts.push(`${renderPath(entry)} AS ${escapeIdent(key)}`);
      projectedPaths.add(entry);
      fields.push(projectedFieldFor(meta, [key], [key], pathSegments(entry)));
      continue;
    }
    if (isPlainObject(entry)) {
      const ops = Object.entries(entry).filter(([, v]) => v !== undefined);
      if (ops.length !== 1)
        throw compileError(
          "ValidationError",
          `${operation}: select."${key}" must be one aggregator (got ${describeValue(entry)}).`,
          { operation },
        );
      const [op, field] = ops[0] as [string, unknown];
      if (typeof field !== "string" || !field)
        throw compileError(
          "ValidationError",
          `${operation}: select."${key}".${op} must be a field path.`,
          { operation },
        );
      const path = pathSegments(field);
      const mathFn = MATH_OPS[op];
      if (mathFn !== undefined) {
        parts.push(
          `math::${mathFn}(${renderPath(field)}) AS ${escapeIdent(key)}`,
        );
        const leaf =
          op === "min" || op === "max"
            ? projectedFieldFor(meta, [key], [key], path)
            : undefined;
        fields.push(
          leaf ?? { out: [key], source: [key], expr: "", each: false },
        );
        continue;
      }
      if (op === "collect" || op === "distinct") {
        parts.push(
          `${op === "collect" ? "array::group" : "array::distinct"}(${renderPath(field)}) AS ${escapeIdent(key)}`,
        );
        const leaf = projectedFieldFor(meta, [key], [key], path);
        fields.push({ ...leaf, each: true });
        continue;
      }
      throw compileError(
        "ValidationError",
        `${operation}: unknown aggregator "${op}" — use sum/avg/min/max/median/stddev/variance/collect/distinct, or a surql fragment.`,
        { operation },
      );
    }
    if (isLowerableValue(entry)) {
      hasExpression = true;
      const expr = renderValue(entry, binds, binds.ctx());
      parts.push(`${expr} AS ${escapeIdent(key)}`);
      fields.push({ out: [key], source: [key], expr, each: false });
      continue;
    }
    throw compileError(
      "ValidationError",
      `${operation}: select entry "${key}" must be true, a path, an aggregator object or a fragment (got ${describeValue(entry)}).`,
      { operation },
    );
  }
  return { parts, fields, projectedPaths, hasExpression };
}
