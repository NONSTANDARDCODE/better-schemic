/**
 * The `select` compilation SHARED by every aggregate lowering — the single place an
 * `aggregate({ select })` entry becomes SQL.
 *
 * Two lowerings consume it: the plain one (`SELECT … FROM t GROUP …`) and the split one
 * (`aggregate({ split })` — UNWIND in an inner subquery, GROUP outside; see `aggregate-split.ts`).
 * They read the same `select`, dispatch the same entry shapes and render the same aggregator calls.
 * They differ only in how a path becomes a column (the path itself vs. the reserved column the
 * inner subquery flattened it into) and in what the operand guard can prove — both expressed as a
 * {@link ColumnResolver}. That keeps ONE loop instead of two edited in lockstep, so a new aggregator
 * or a changed operator table can no longer land in one half and silently disagree with the other.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident";
import type { AggregateArgs } from "./aggregate";
import type { ModelMeta } from "../meta";
import { type ProjectedField, projectedFieldFor } from "./projection";
import { assertAggregateOperand } from "./aggregate-operand";
import { compileOrderBy } from "./select";
import {
  type Binds,
  compileError,
  datetimeLiteral,
  describeValue,
  durationLiteral,
  isLowerableValue,
  isPlainObject,
  nonNegativeInt,
  pathSegments,
  pathList,
  renderPath,
  renderValue,
} from "./shared";

/**
 * The math aggregators (API name -> `math::<fn>`). `avg` maps to `math::mean`: SurrealDB 3.x has no
 * `math::avg` (live-verified — it's a parse error), while the API keeps the SQL-familiar name.
 */
export const MATH_OPS: Readonly<Record<string, string>> = {
  sum: "sum",
  avg: "mean",
  min: "min",
  max: "max",
  median: "median",
  stddev: "stddev",
  variance: "variance",
} as const;

/** The value aggregators: `collect` keeps every value, `distinct` deduplicates. */
export const VALUE_OPS: Readonly<Record<string, string>> = {
  collect: "array::group",
  distinct: "array::distinct",
} as const;

/** `min`/`max` return ONE value of the field's own type; every other math op returns a number. */
function scalarOp(op: string): boolean {
  return op === "min" || op === "max";
}

/** True when `op` is an aggregator this compiler knows (so the guard and the call agree). */
function isAggregator(op: string): boolean {
  return MATH_OPS[op] !== undefined || VALUE_OPS[op] !== undefined;
}

/**
 * The decode leaf an aggregator's result gets.
 *
 * Three shapes, and the difference is load-bearing:
 * - `collect`/`distinct` return an ARRAY of the column's own type, so the column's codec applies —
 *   with `each: true`;
 * - `min`/`max` return ONE value of the column's own type (`min(price)` is a price), so the codec
 *   applies unchanged;
 * - every OTHER math op returns a number the SERVER computed (`math::mean(int)` is a float, `sum`
 *   is a float). The column's codec does not apply to it — decoding `math::mean(age)` through the
 *   `int` codec of `age` rejects the server's own answer — so the leaf is deliberately blank.
 */
function aggregatedLeaf(op: string, leaf: ProjectedField): ProjectedField {
  if (VALUE_OPS[op] !== undefined) return { ...leaf, each: true };
  if (scalarOp(op)) return leaf;
  return { out: leaf.out, source: leaf.source, expr: "", each: false };
}

/**
 * Render one aggregator over an already-rendered column: `math::sum(_split_qty)`, `array::group(x)`.
 * The column is the caller's job, so both lowerings share the operator table.
 */
function aggregateCall(op: string, column: string, operation: string): string {
  const math = MATH_OPS[op];
  if (math !== undefined) return `math::${math}(${column})`;
  const value = VALUE_OPS[op];
  if (value !== undefined) return `${value}(${column})`;
  throw compileError(
    "ValidationError",
    `${operation}: unknown aggregator "${op}" — use ${[...Object.keys(MATH_OPS), ...Object.keys(VALUE_OPS)].join("/")}, or a surql fragment.`,
    { operation },
  );
}

/**
 * How one lowering turns a `select` path into the column an aggregator reads, what the inner SPLIT
 * subquery must project for that column to exist, and how much the schema can prove about the
 * operand.
 */
export interface ColumnResolver {
  /**
   * The column expression an aggregator or leaf reads for `path`, projected under the entry's
   * OUTPUT KEY `out`. `out` matters: a `groupBy` names the output key, so only the resolver can tell
   * a group key (kept as-is) from an operand (flattened under a reserved column).
   */
  of(path: string, out: string): string;
  /** The SQL the SPLIT subquery must project for `path`/`out`; absent when there is no inner query. */
  inner?(path: string, out: string): string;
  /**
   * Extra path segments every decode leaf inherits — the split ELEMENT's prefix, so
   * `products[*].price` decodes with the element's codec rather than the array field's.
   */
  prefix(): readonly string[];
  /**
   * The SQL the inner SPLIT subquery must project. REQUIRED (the plain lowering passes `[]`): the
   * resolver owns the list because a `fragment` entry contributes to it mid-loop, so an optional
   * field here would mean a silent empty list for a lowering that forgot to provide one.
   */
  readonly inners: string[];
  /** Refuse an operand the schema knows to be un-aggregatable (teaching error). */
  guard?(key: string, op: string, operand: string, operation: string): void;
  /**
   * A server-side expression entry. The plain lowering evaluates it once per group; the split
   * lowering evaluates it once per split ROW (inside the subquery), which is the only way a fragment
   * can read the element. Returns the SQL for the OUTER select.
   */
  fragment?(expr: string, key: string): string;
}

/**
 * The plain resolver: the path IS the column, nothing is projected in front of it, and every operand
 * is judged against the table's own columns.
 */
export function directColumns(meta: ModelMeta): ColumnResolver {
  return {
    inners: [],
    of: (path) => renderPath(path),
    prefix: () => [],
    guard: (key, op, operand, operation) =>
      assertAggregateOperand(meta, key, op, operand, operation),
  };
}

/** The compiled `select`: the projected SQL, the decode leaves, and the group-key spellings. */
export interface CompiledSelect {
  /** The `SELECT` list, each entry aliased to its own key. */
  parts: string[];
  /** One decode leaf per entry, in entry order. */
  fields: ProjectedField[];
  /**
   * Every spelling a `groupBy` key may take: the OUTPUT key of an alias AND the path it projects.
   * SurrealDB accepts both (`SELECT tenant AS t … GROUP BY t` and `… GROUP BY tenant` — live 3.3.4),
   * so an aliased group key must not be rejected for "not being its own path".
   */
  projectedKeys: Set<string>;
  /** Whether any entry is a server-side expression (then the group-key check is the server's). */
  hasExpression: boolean;
  /** What the SPLIT subquery must project; empty for a plain aggregate. */
  inners: string[];
}

/**
 * Compile the `select` entries into SQL + decode leaves.
 *
 * One loop, two lowerings — the only thing that varies is the {@link ColumnResolver}.
 *
 * `select` is taken as a validated non-empty plain object: both callers run
 * {@link assertAggregateShape} first, so re-checking the shape here would be a second copy of a
 * guard that cannot fire.
 */
export function compileAggregateSelect(
  meta: ModelMeta,
  select: Record<string, unknown>,
  binds: Binds,
  operation: string,
  columns: ColumnResolver,
): CompiledSelect {
  const parts: string[] = [];
  const fields: ProjectedField[] = [];
  const projectedKeys = new Set<string>();
  const { inners } = columns;
  let hasExpression = false;
  const prefix = columns.prefix();
  /** Project `path` under the output name `out`, recording the inner SQL the split needs. */
  const column = (path: string, out: string): string => {
    const inner = columns.inner?.(path, out);
    if (inner !== undefined) inners.push(inner);
    const expr = columns.of(path, out);
    // One rule for both lowerings: an output name identical to its expression is not re-aliased.
    return expr === escapeIdent(out) ? expr : `${expr} AS ${escapeIdent(out)}`;
  };

  for (const [key, entry] of Object.entries(select)) {
    if (entry === undefined || entry === false) continue;
    if (entry === true) {
      // `_count` is the count() shorthand; any other `true` projects the field itself.
      if (key === "_count") {
        parts.push("count() AS _count");
        fields.push({ out: [key], source: [key], expr: "count()", each: false });
        projectedKeys.add(key);
        continue;
      }
      parts.push(column(key, key));
      projectedKeys.add(key);
      fields.push(projectedFieldFor(meta, [key], [key], [key]));
      continue;
    }
    if (typeof entry === "string") {
      // `{ customerName: "customer.name" }` — the ALIAS is the output key; the path it projects is a
      // valid group key too (the server accepts both spellings).
      parts.push(column(entry, key));
      projectedKeys.add(key);
      projectedKeys.add(entry);
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
      const [op, operand] = ops[0] as [string, unknown];
      if (typeof operand !== "string" || !operand)
        throw compileError(
          "ValidationError",
          `${operation}: select."${key}".${op} must be a field path.`,
          { operation },
        );
      if (isAggregator(op)) columns.guard?.(key, op, operand, operation);
      const leaf = projectedFieldFor(meta, [key], [key], [
        ...prefix,
        ...pathSegments(operand),
      ]);
      parts.push(
        `${aggregateCall(op, columns.of(operand, key), operation)} AS ${escapeIdent(key)}`,
      );
      projectedKeys.add(key);
      const inner = columns.inner?.(operand, key);
      if (inner !== undefined) inners.push(inner);
      fields.push(aggregatedLeaf(op, leaf));
      continue;
    }
    if (isLowerableValue(entry)) {
      hasExpression = true;
      const expr = renderValue(entry, binds, binds.ctx());
      parts.push(columns.fragment?.(expr, key) ?? `${expr} AS ${escapeIdent(key)}`);
      projectedKeys.add(key);
      fields.push({ out: [key], source: [key], expr, each: false });
      continue;
    }
    throw compileError(
      "ValidationError",
      `${operation}: select entry "${key}" must be true, a path, an aggregator object or a fragment (got ${describeValue(entry)}).`,
      { operation },
    );
  }

  return { parts, fields, projectedKeys, hasExpression, inners };
}

/**
 * The clause suffix every aggregate shares: `GROUP BY`/`GROUP ALL`, then `ORDER BY`/`LIMIT`/`START`
 * (plus `TIMEOUT`, and `VERSION` on the plain lowering only). Returned as an array so the caller
 * splices it onto whichever statement it built.
 */
export function aggregateTail(
  args: AggregateArgs,
  groupBy: readonly string[],
  binds: Binds,
  operation: string,
  options: { readonly version?: boolean } = {},
): string[] {
  const tail: string[] = [
    groupBy.length > 0
      ? `GROUP BY ${groupBy.map(renderPath).join(", ")}`
      : "GROUP ALL",
  ];
  if (args.orderBy !== undefined)
    tail.push(compileOrderBy(args.orderBy, binds, operation));
  if (args.limit !== undefined)
    tail.push(`LIMIT ${binds.add(nonNegativeInt(args.limit, "limit", operation))}`);
  if (args.start !== undefined)
    tail.push(`START ${binds.add(nonNegativeInt(args.start, "start", operation))}`);
  if (options.version === true && args.version !== undefined)
    tail.push(`VERSION ${datetimeLiteral(args.version, operation)}`);
  if (args.timeout !== undefined)
    tail.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);
  return tail;
}

/**
 * The guards BOTH lowerings run before compiling anything: `groupBy` is a path list, `groupBy` and
 * `groupAll` are alternatives (never both), and `select` is a non-empty object. Returns the group
 * keys so the caller doesn't re-validate them.
 */
export function assertAggregateShape(
  args: AggregateArgs,
  operation: string,
): string[] {
  const groupBy = [...pathList(args.groupBy, "groupBy", operation)];
  if (groupBy.length > 0 && args.groupAll === true)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: pass "groupBy" OR "groupAll", not both.`,
      { operation },
    );
  if (!isPlainObject(args.select) || Object.keys(args.select).length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select must be a non-empty object of aggregators/group keys (got ${describeValue(args.select)}).`,
      { operation },
    );
  return groupBy;
}

/**
 * Every `groupBy` key must be in the projection (SurrealDB: "Missing group idiom"). Guarded only
 * when the projection is statically analyzable — an expression entry makes the check the server's.
 */
export function assertGroupKeysProjected(
  groupBy: readonly string[],
  projectedKeys: ReadonlySet<string>,
  hasExpression: boolean,
  operation: string,
): void {
  if (groupBy.length === 0 || hasExpression) return;
  for (const key of groupBy)
    if (!projectedKeys.has(key))
      throw compileError(
        "ValidationError",
        `${operation}: groupBy key "${key}" is missing from select — add it as \`${key}: "${key}"\` (SurrealDB requires every group key in the projection).`,
        { operation },
      );
}