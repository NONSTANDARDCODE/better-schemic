/**
 * `aggregate({ split })` — the UNWIND-then-GROUP lowering.
 *
 * SurrealDB evaluates `SPLIT` BEFORE `GROUP` inside one SELECT, so `SELECT … SPLIT f GROUP ALL` is a
 * parse error (live-verified on 3.3.4: mutually exclusive / `Missing split idiom`). The split is
 * therefore pushed into an inner subquery and the grouping happens over ITS rows:
 *
 * ```surql
 * SELECT name, math::sum(_split_quantity) AS qty
 * FROM (SELECT name, products AS _split_products, products[*].quantity AS _split_quantity
 *       FROM customer SPLIT products)
 * GROUP BY name
 * ```
 *
 * Two live-verified facts shape it: the inner SELECT must carry the split field as its own idiom
 * (aliased or not — `projection.ts` injects it), and `SELECT *` does NOT expose the element's
 * fields, so the inner projection has to be explicit.
 *
 * The `select` ENTRY dispatch is NOT here: it is the same loop the plain aggregate runs
 * ({@link compileAggregateSelect}), parameterized by the resolver below. Only what is genuinely
 * different about a split lives in this file.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident";
import type { AggregateArgs, CompiledAggregate } from "./aggregate";
import {
  type ColumnResolver,
  aggregateTail,
  assertAggregateShape,
  assertGroupKeysProjected,
  compileAggregateSelect,
} from "./aggregate-entries";
import { assertAggregateOperand } from "./aggregate-operand";
import type { ModelMeta, SchemaIndex } from "../meta";
import {
  type Binds,
  compileError,
  isTableMeta,
  pathSegments,
  renderPath,
} from "./shared";
import { compileWhere, mergeScope } from "./where";

/** The reserved prefix of the columns the split subquery projects for the outer aggregate. */
const SPLIT_COLUMN_PREFIX = "_split_";

/** The reserved column a path is flattened into (`lines[*].qty` -> `_split_lines_qty`). */
function reservedColumn(path: string): string {
  return `${SPLIT_COLUMN_PREFIX}${pathSegments(path).join("_")}`;
}

/**
 * The split resolver. A group key keeps its call-site name (so the outer `GROUP BY` and the decode
 * agree); anything else is flattened under a reserved column the inner query projects. Leaves inherit
 * the split field's prefix, so `lines[*].qty` decodes with the LINE's codec, not the array's. The
 * guard runs with `throughSplit`, because an operand naming the split ELEMENT lives in another table
 * that this meta cannot describe.
 */
function splitResolver(
  meta: ModelMeta,
  split: string,
  groupBy: readonly string[],
): ColumnResolver {
  const inners: string[] = [];
  return {
    inners,
    // A group key is named by its OUTPUT KEY (`groupBy: ["customerName"]`), so it keeps that name;
    // everything else is flattened under the reserved column the inner query projects.
    of: (_path, out) =>
      groupBy.includes(out) ? escapeIdent(out) : escapeIdent(reservedColumn(_path)),
    inner: (path, out) =>
      groupBy.includes(out)
        ? `${renderPath(path)} AS ${escapeIdent(out)}`
        : `${renderPath(path)} AS ${escapeIdent(reservedColumn(path))}`,
    prefix: () => pathSegments(split),
    guard: (key, op, operand, operation) =>
      assertAggregateOperand(meta, key, op, operand, operation, {
        throughSplit: true,
      }),
    // A fragment must read the split ROW (the element plus whatever the parent projected), so it is
    // evaluated in the subquery and the outer select just renames its column — exactly the rows a
    // `findMany({ split })` would return.
    fragment: (expr, key) => {
      const alias = `_split_expr_${key}`;
      inners.push(`${expr} AS ${escapeIdent(alias)}`);
      return `${escapeIdent(alias)} AS ${escapeIdent(key)}`;
    },
  };
}

/** Build the resolver — a thin seam so `meta` stays a parameter of `compileSplitAggregate`. */
export function compileSplitAggregate(
  meta: ModelMeta,
  args: AggregateArgs,
  binds: Binds,
  operation: string,
  options: { readonly index?: SchemaIndex },
): CompiledAggregate {
  const split = args.split as string;
  const groupBy = assertAggregateShape(args, operation);

  const columns = splitResolver(meta, split, groupBy);
  const { parts, fields, projectedKeys, hasExpression } = compileAggregateSelect(
    meta,
    args.select as Record<string, unknown>,
    binds,
    operation,
    columns,
  );
  const { inners } = columns;
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: select is empty — project at least one aggregator or group key.`,
      { operation },
    );
  assertGroupKeysProjected(groupBy, projectedKeys, hasExpression, operation);

  // The inner query projects the split field itself first (the server needs it as the idiom), then
  // every operand path the outer aggregate reads.
  const statement: string[] = [
    `SELECT ${parts.join(", ")}`,
    `FROM (SELECT ${[
      `${renderPath(split)} AS ${escapeIdent(reservedColumn(split))}`,
      ...inners,
    ].join(", ")} FROM ${escapeIdent(meta.name)}`,
  ];
  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    index: options.index,
    operation,
  });
  if (where) statement.push(`WHERE ${where}`);
  statement.push(`SPLIT ${renderPath(split)})`);
  statement.push(...aggregateTail(args, groupBy, binds, operation));

  return {
    sql: statement.join(" "),
    projection: { star: false, fields, omit: [], value: false, includes: [] },
  };
}
