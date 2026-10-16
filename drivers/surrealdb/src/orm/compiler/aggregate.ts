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
import { escapeIdentSafe as escapeIdent } from "../../ident";
import type {
  ColumnMeta,
  FieldFamily,
  ModelMeta,
  SchemaIndex,
  TableMeta,
} from "../meta";
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
import { compileWhere, mergeScope } from "./where";

/** The clauses `count`/`exists` accept (no projection/order — they don't apply). */
export interface CountArgs {
  where?: unknown;
  range?: unknown;
  with?: unknown;
  timeout?: unknown;
  version?: unknown;
  meta?: Record<string, unknown>;
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown;
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
  options: { readonly index?: SchemaIndex } = {},
): string {
  rejectRemovedArgs(args, operation);
  const parts: string[] = [
    "SELECT count()",
    `FROM ${aggregateTarget(meta, args.range, operation)}`,
  ];
  if (args.with !== undefined)
    parts.push(compileWithClause(args.with, operation));
  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
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
  options: { readonly index?: SchemaIndex } = {},
): string {
  rejectRemovedArgs(args, operation);
  const parts: string[] = [
    "SELECT VALUE id",
    `FROM ${aggregateTarget(meta, args.range, operation)}`,
  ];
  if (args.with !== undefined)
    parts.push(compileWithClause(args.with, operation));
  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
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
  meta?: Record<string, unknown>;
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown;
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

/**
 * The aggregators whose operand MUST be a numeric leaf.
 *
 * `math::*` is number-only on SurrealDB — and NOT uniformly wrong when fed something else: `sum`
 * over a string or an unknown path answers `0`, `median` answers `{}`, and `min`/`max` over a
 * string/datetime/bool answer `null` (all live-probed on 3.3.4). Since every one of those looks
 * like a real result, the operand is validated here and the message points at the form that does
 * work (`array::min(array::group(…))` for non-numbers — also live-verified).
 */
const NUMBER_ONLY_OPS: ReadonlySet<string> = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "stddev",
  "variance",
]);

/**
 * Reject an aggregate operand the server would silently answer with a lie.
 *
 * `math::*` over a grouped set NEVER fails on a wrong operand — it answers `0` for an unknown path,
 * for a `string` column and for a link path, `null` for `math::min(string)`, and `{}` for
 * `math::median(string)` (all live-probed on 3.3.4). A report showing `R$ 0,00` with no signal is
 * worse than a compile error, so the operand is checked against the authored schema here.
 *
 * Only what the schema KNOWS is enforced: a schemaless entry, a non-SCHEMAFULL table (a view), or
 * a path that walks into a flexible object has no column to check and stays permissive.
 */
function assertAggregateOperand(
  meta: ModelMeta,
  key: string,
  op: string,
  path: string,
  operation: string,
  options: { readonly throughSplit?: boolean } = {},
): void {
  if (!isTableMeta(meta)) return;
  if (meta.def.config.schemafull === false) return;
  const table = meta.name;
  const columns = meta.columns;
  const fail = (reason: string): never => {
    throw compileError(
      "ValidationError",
      `${operation}: select."${key}".${op} can't run over "${path}" — ${reason}`,
      { operation, table },
    );
  };

  const segments = pathSegments(path);
  const first = segments[0] as string;
  // A split aggregate's operand names a column of the split ELEMENT — a different table, which this
  // meta cannot describe. Only a path that stays on the parent is checkable; the rest is left to the
  // server (which is exactly where the 0/null came from — but here it is a deliberate, documented
  // escape, not a silent wrong answer on a field the schema DOES know).
  if (options.throughSplit === true && !checkableThroughSplit(meta, first, segments))
    return;
  // A SCHEMAFULL table rejects unknown fields server-side; catch the typo with the field list.
  const found = columns.get(first);
  if (!found)
    fail(
      `"${first}" is not a field of "${table}". Known fields: ${[...columns.keys()].join(", ")} — or pass a surql fragment.`,
    );
  const base: ColumnMeta = found as ColumnMeta;

  // Walk every segment but the last: a path may only descend through a plain object. A record link
  // or an array/set holds many values per grouped row — that is what SPLIT exists for.
  let column = base;
  for (let i = 0; i < segments.length - 1; i++) {
    if (column.family === "object") return; // flexible object: the leaf's family is unknown here
    const segment = segments[i] as string;
    if (column.record !== undefined)
      fail(
        `"${column.name}" is a ${column.record.list === true ? "list of " : ""}record link — math::* aggregates ONE field per grouped row, so it can't reach through it. Use \`aggregate({ split: "${column.name}", select: { ${key}: { ${op}: "…${segment}" } } })\` for the per-element total, or a surql fragment with array::flatten.`,
      );
    if (column.family === "array" || column.family === "set")
      fail(
        `"${column.name}" is ${articleFor(column.family)} — math::* aggregates ONE field per grouped row. Use \`aggregate({ split: "${column.name}", … })\` to aggregate per element, or a surql fragment with array::flatten.`,
      );
    // A scalar intermediate (the schema has no column for it) cannot be walked either.
    return;
  }

  const last = column;
  if (last.family === "object" || last.family === "any") return;
  if (NUMBER_ONLY_OPS.has(op) && last.family !== "number")
    fail(
      `math::${MATH_OPS[op] as string} only aggregates NUMBERS and "${last.name}" is ${articleFor(last.family)} — the server would answer ${
        op === "min" || op === "max" ? "null" : op === "median" ? "an empty object" : "0"
      } for it, with no error. For a ${last.family} ${op === "min" || op === "max" ? "extremum" : "total"} use a surql fragment (\`array::${op === "min" || op === "max" ? op : "sort"}…\` over \`array::group(${renderPath(path)})\`), or { collect: "${path}" } and reduce in JS.`,
    );
}

/**
 * Can this split operand still be checked against the PARENT table? Only a path that stays on the
 * parent rows (`lines` is a plain array of scalars, or a bare field name) — anything else names the
 * element's table, which this meta cannot describe.
 */
function checkableThroughSplit(
  meta: TableMeta,
  first: string,
  segments: readonly string[],
): boolean {
  const base = meta.columns.get(first);
  if (!base) return false;
  if (segments.length < 2) return true;
  if (base.record === undefined) return true;
  return base.family !== "array" && base.family !== "set";
}

/** A field family as an English noun phrase (`a string field`, `an array field`). */
function articleFor(family: FieldFamily): string {
  const noun = family === "bool" ? "boolean" : family;
  return `${"aeiou".includes(noun[0] as string) ? "an" : "a"} ${noun} field`;
}

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
  options: { readonly index?: SchemaIndex } = {},
): CompiledAggregate {
  rejectRemovedArgs(args, operation);
  if (args.having !== undefined)
    throw compileError(
      "HavingUnsupported",
      `${operation}: HAVING does not exist in SurrealQL — filter the grouped rows with a subquery via $query, or aggregate in two steps.`,
      { operation },
    );
  // SPLIT + GROUP cannot share a SELECT (the server rejects it), so a split aggregate lowers to the
  // UNWIND-then-GROUP shape: the split runs in an inner subquery, the grouping outside. See
  // `compileSplitAggregate` — which owns the `groupBy`/`groupAll` guard on that path.
  if (args.split !== undefined) {
    if (typeof args.split !== "string" || args.split.trim().length === 0)
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "split" must be a field path (an array/set field to unfold) — SurrealDB evaluates SPLIT before GROUP, and only a field is a valid split idiom.`,
        { operation },
      );
    return compileSplitAggregate(meta, args, binds, operation, options);
  }

  const groupBy = pathList(args.groupBy, "groupBy", operation);
  const groupAll = args.groupAll === true;
  if (groupBy.length > 0 && groupAll)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: pass "groupBy" OR "groupAll", not both.`,
      { operation },
    );

  const { parts, fields, projectedKeys, hasExpression } =
    compileAggregateSelect(meta, args.select, binds, operation);
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one aggregator or group key.`,
      { operation },
    );

  // SurrealDB requires every GROUP BY key in the projection ("Missing group idiom"); catch it here
  // with a teaching error when the projection is statically analyzable. Both forms are valid group
  // keys (live-verified): the OUTPUT KEY of an alias (`SELECT tenant AS t … GROUP BY t`) and the
  // PATH it projects (`… GROUP BY tenant`) — so the check accepts either spelling.
  if (groupBy.length > 0 && !hasExpression)
    for (const key of groupBy)
      if (!projectedKeys.has(key))
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
  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
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
    projection: { star: false, fields, omit: [], value: false, includes: [] },
  };
}

// --- aggregate over split (UNWIND + GROUP) --------------------------------------------------------

/** The reserved prefix of the columns the split subquery projects for the outer aggregate. */
const SPLIT_COLUMN_PREFIX = "_split_";

/** The outer projection of one entry: the alias itself when it already carries the output name. */
function outerProjection(key: string, alias: string): string {
  const out = escapeIdent(key);
  return out === alias ? alias : `${escapeIdent(alias)} AS ${out}`;
}

/**
 * `aggregate({ split })` — the UNWIND-then-GROUP lowering.
 *
 * SurrealDB evaluates `SPLIT` BEFORE `GROUP` inside one SELECT, so `SELECT … SPLIT f GROUP ALL` is
 * a parse error (`Missing split idiom`/mutually-exclusive — live-verified on 3.3.4). The split is
 * therefore pushed into an inner subquery and the grouping happens over its rows:
 *
 * ```surql
 * SELECT name, math::sum(_split_quantity) AS qty
 * FROM (SELECT name, products AS _split_products, products[*].quantity AS _split_quantity
 *       FROM customer SPLIT products)
 * GROUP BY name
 * ```
 *
 * Two live-verified facts shape the lowering: the inner SELECT must carry the split field as its
 * own idiom (aliased or not), and each `select` entry is rewritten to the reserved column the inner
 * query projected it under — so the call-site keeps reading `products[*].quantity` while the server
 * aggregates the flattened column.
 */
function compileSplitAggregate(
  meta: ModelMeta,
  args: AggregateArgs,
  binds: Binds,
  operation: string,
  options: { readonly index?: SchemaIndex },
): CompiledAggregate {
  const split = args.split as string;
  const groupBy = pathList(args.groupBy, "groupBy", operation);
  const groupAll = args.groupAll === true;
  if (groupBy.length > 0 && groupAll)
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

  // The inner query projects: the split idiom itself, every group key (under its group alias) and
  // every operand path the outer aggregate reads. `id` rides along so a `count()` per group is
  // still countable, and it is what makes the shape predictable for the decoder.
  const inner: string[] = [];
  const outer: string[] = [];
  const fields: ProjectedField[] = [];
  const outerKeys = new Set<string>();
  const innerColumns = new Set<string>();
  const columnFor = (path: string): string => {
    const alias = `${SPLIT_COLUMN_PREFIX}${pathSegments(path).join("_")}`;
    innerColumns.add(alias);
    return alias;
  };

  for (const [key, entry] of Object.entries(args.select)) {
    if (entry === undefined || entry === false) continue;
    if (entry === true) {
      if (key === "_count") {
        outer.push(`count() AS _count`);
        fields.push({
          out: ["_count"],
          source: ["_count"],
          expr: "count()",
          each: false,
        });
        outerKeys.add("_count");
        continue;
      }
      // A projected path: group key (a parent field) or a raw column of the split element. The
      // group key keeps its call-site name so `groupBy: ["name"]` still finds it in the projection.
      const isGroupKey = groupBy.includes(key);
      const alias = isGroupKey ? key : columnFor(key);
      inner.push(`${renderPath(key)} AS ${escapeIdent(alias)}`);
      outer.push(outerProjection(key, alias));
      outerKeys.add(key);
      // A leaf either way: a group key decodes with the field's own codec; a non-group column is
      // the FIRST value of its group (the server already reduced it), decoded the same way.
      fields.push(projectedFieldFor(meta, [key], [key], pathSegments(key)));
      continue;
    }
    if (typeof entry === "string") {
      // `{ customerName: "customer.name" }` — a parent path, usable as a group key. The group key
      // must keep the call-site alias so the outer `GROUP BY` and the decode agree.
      const alias = groupBy.includes(key) ? key : columnFor(entry);
      inner.push(`${renderPath(entry)} AS ${escapeIdent(alias)}`);
      outer.push(outerProjection(key, alias));
      outerKeys.add(key);
      if (groupBy.includes(key))
        fields.push(
          projectedFieldFor(meta, [key], [key], pathSegments(entry)),
        );
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
      // With a split, the operand IS a column of the split ELEMENT, so the table's own columns
      // can't vouch for it (the element lives in another table) — the server is the only judge.
      // With a split, the operand is a column of the split ELEMENT (another table), so the parent
      // schema can't vouch for it — only the parent-reachable paths are checked.
      assertAggregateOperand(meta, key, op, operand, operation, {
        throughSplit: true,
      });
      const alias = columnFor(operand);
      inner.push(`${renderPath(operand)} AS ${escapeIdent(alias)}`);
      const mathFn = MATH_OPS[op];
      if (mathFn !== undefined) {
        outer.push(`math::${mathFn}(${escapeIdent(alias)}) AS ${escapeIdent(key)}`);
        // min/max return ONE value of the element's type, so the leaf decodes with the ELEMENT's
        // codec (`products[*].price` -> the price codec), never the array/link codec of the split
        // field itself.
        fields.push(
          projectedFieldFor(meta, [key], [key], pathSegments(operand), [
            ...pathSegments(split),
          ]),
        );
      } else if (op === "collect" || op === "distinct") {
        outer.push(
          `${op === "collect" ? "array::group" : "array::distinct"}(${escapeIdent(alias)}) AS ${escapeIdent(key)}`,
        );
        fields.push({
          ...projectedFieldFor(meta, [key], [key], pathSegments(operand)),
          each: true,
        });
      } else {
        throw compileError(
          "ValidationError",
          `${operation}: unknown aggregator "${op}" — use sum/avg/min/max/median/stddev/variance/collect/distinct.`,
          { operation },
        );
      }
      outerKeys.add(key);
      continue;
    }
    if (isLowerableValue(entry)) {
      // A fragment reads the SPLIT ROW (the element, plus whatever the parent projected) — the same
      // rows a `findMany({ split })` returns — so it composes instead of being rejected.
      const expr = renderValue(entry, binds, binds.ctx());
      const alias = columnFor(`expr_${key}`);
      inner.push(`${expr} AS ${escapeIdent(alias)}`);
      outer.push(`${escapeIdent(alias)} AS ${escapeIdent(key)}`);
      fields.push({ out: [key], source: [key], expr, each: false });
      outerKeys.add(key);
      continue;
    }
    throw compileError(
      "ValidationError",
      `${operation}: select entry "${key}" must be true, a path, an aggregator object or a fragment (got ${describeValue(entry)}).`,
      { operation },
    );
  }

  if (outer.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one aggregator or group key.`,
      { operation },
    );
  for (const key of groupBy)
    if (!outerKeys.has(key))
      throw compileError(
        "ValidationError",
        `${operation}: groupBy key "${key}" is missing from select — add it as \`${key}: "${key}"\` (SurrealDB requires every group key in the projection).`,
        { operation },
      );

  // The split idiom: the field itself, projected into the inner query so the server accepts the
  // SPLIT clause (live-verified — an inner `SPLIT f` whose field is not selected is a parse error).
  inner.unshift(`${renderPath(split)} AS ${escapeIdent(columnFor(split))}`);

  const innerStatement: string[] = [
    `SELECT ${inner.join(", ")}`,
    `FROM ${escapeIdent(meta.name)}`,
  ];
  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
  });
  if (where) innerStatement.push(`WHERE ${where}`);
  innerStatement.push(`SPLIT ${renderPath(split)}`);

  const statement: string[] = [
    `SELECT ${outer.join(", ")}`,
    `FROM (${innerStatement.join(" ")})`,
  ];
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
  if (args.timeout !== undefined)
    statement.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`);

  return {
    sql: statement.join(" "),
    projection: { star: false, fields, omit: [], value: false, includes: [] },
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
  /**
   * Every spelling a `groupBy` key may take: the OUTPUT key of an alias AND the path it projects.
   * SurrealDB accepts both (`SELECT tenant AS t … GROUP BY t` and `… GROUP BY tenant` — live 3.3.4),
   * so an aliased group key must not be rejected for "not being its own path".
   */
  projectedKeys: Set<string>;
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
  const projectedKeys = new Set<string>();
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
      projectedKeys.add(key);
      fields.push(projectedFieldFor(meta, [key], [key], [key]));
      continue;
    }
    if (typeof entry === "string") {
      parts.push(`${renderPath(entry)} AS ${escapeIdent(key)}`);
      // The ALIAS is the output key; the path it projects is a valid group key too.
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
        assertAggregateOperand(meta, key, op, field, operation);
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
  return { parts, fields, projectedKeys, hasExpression };
}
