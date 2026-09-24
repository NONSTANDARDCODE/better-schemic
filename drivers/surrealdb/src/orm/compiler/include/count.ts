/**
 * The `_count` branch of the include compiler — correlated `count(->edge->target)` /
 * `count(arrayLink[WHERE …])` (NONE-safe, unlike `array::len`), remounted by the decoder as one
 * `_count` object.
 */
import { escapeIdent } from "surrealdb";
import { BetterSchemicError } from "../../errors";
import type { TableMeta } from "../../meta";
import {
  type EdgeDirection,
  edgeTraversal,
  findEdge,
  resolveEdge,
  edgeMeta as resolveEdgeMeta,
  targetMetas,
} from "../relations";
import {
  compileError,
  describeValue,
  isPlainObject,
  renderPath,
} from "../shared";
import { compileRelationFilter, compileWhere } from "../where";
import type { CompileCtx, CountIncludeSpec } from "./specs";

/** Compile `_count: { select: { <link/edge>: true | { where, direction } } }`. */
export function compileCount(
  meta: TableMeta,
  entry: unknown,
  ctx: CompileCtx,
): void {
  const { operation } = ctx;
  if (!isPlainObject(entry) || !isPlainObject(entry.select))
    throw compileError(
      "ValidationError",
      `${operation}: include._count must be { select: { … } }, got ${describeValue(entry)}.`,
      { operation },
    );
  const select = entry.select as Record<string, unknown>;
  const unknown = Object.keys(entry).find((k) => k !== "select");
  if (unknown)
    throw compileError(
      "ValidationError",
      `${operation}: include._count has unknown option "${unknown}" — only "select".`,
      { operation },
    );
  const keys = Object.keys(select).filter((k) => select[k] !== undefined);
  if (keys.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: include._count.select is empty — count at least one relation.`,
      { operation },
    );

  for (const key of keys) {
    const options = select[key];
    if (options !== true && !isPlainObject(options))
      throw compileError(
        "ValidationError",
        `${operation}: include._count.select."${key}" must be true or { where, direction }, got ${describeValue(options)}.`,
        { operation, field: key },
      );
    if (isPlainObject(options))
      for (const option of Object.keys(options))
        if (option !== "where" && option !== "direction")
          throw compileError(
            "ValidationError",
            `${operation}: include._count.select."${key}" has unknown option "${option}" — accepts "where" and "direction".`,
            { operation, field: key },
          );
    const source = `_count_${key}`;
    ctx.claimFlat(source);

    const link = meta.links.get(key);
    if (link) {
      compileLinkCount(key, link, options, ctx, source);
      continue;
    }
    if (!findEdge(meta, key))
      throw new BetterSchemicError(
        "UnknownField",
        `${operation}: _count."${key}" is not a link or edge of "${meta.name}".`,
        { table: meta.name, field: key, operation },
      );
    compileEdgeCount(meta, key, options, ctx, source);
  }
}

/** `count(friends[WHERE …])` — an array link (NONE-safe). */
function compileLinkCount(
  key: string,
  link: {
    readonly cardinality: "one" | "many";
    readonly targets?: readonly string[];
  },
  options: unknown,
  ctx: CompileCtx,
  source: string,
): void {
  const { operation, binds, index } = ctx;
  if (link.cardinality === "one")
    throw compileError(
      "ValidationError",
      `${operation}: _count."${key}" is a single link — counts need an array link or an edge (use where: { ${key}: { is: … } }).`,
      { operation, field: key },
    );
  if (isPlainObject(options) && options.direction !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: _count."${key}" is an array link — "direction" only applies to edges.`,
      { operation, field: key },
    );
  const where = isPlainObject(options) ? options.where : undefined;
  const targets = targetMetas(index, link.targets);
  const predicate = where
    ? compileWhere(where, binds, {
        ...(targets.length === 1 ? { meta: targets[0] } : {}),
        index,
        operation,
      })
    : undefined;
  ctx.parts.push(
    `count(${renderPath(key)}${predicate ? `[WHERE ${predicate}]` : ""}) AS ${escapeIdent(source)}`,
  );
  ctx.specs.push({ kind: "count", key, source });
}

/** `count(->edge->(target WHERE …))` — a graph edge. */
function compileEdgeCount(
  meta: TableMeta,
  key: string,
  options: unknown,
  ctx: CompileCtx,
  source: string,
): void {
  const { operation, binds, index } = ctx;
  const direction = countDirection(options, ctx, key);
  const resolved = resolveEdge(meta, key, direction, operation);
  const edgeMeta = resolveEdgeMeta(index, resolved.edge.name);
  const targets = targetMetas(index, resolved.targets);
  const compiled = compileRelationFilter({
    where: isPlainObject(options) ? options.where : undefined,
    ...(edgeMeta ? { edge: edgeMeta } : {}),
    targets,
    idOwner: "target",
    index,
    binds,
    operation,
    context: `_count.${key}`,
  });
  const targetWhere = [compiled.target, compiled.fragment]
    .filter(Boolean)
    .join(" AND ");
  const traversal = edgeTraversal({
    edge: resolved.edge.name,
    direction: resolved.direction,
    ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
    targets: resolved.targets,
    ...(targetWhere ? { targetFilter: targetWhere } : {}),
  });
  const spec: CountIncludeSpec = { kind: "count", key, source };
  ctx.parts.push(`count(${traversal}) AS ${escapeIdent(source)}`);
  ctx.specs.push(spec);
}

/** `direction` for an edge `_count` key. */
function countDirection(
  options: unknown,
  ctx: CompileCtx,
  key: string,
): EdgeDirection | undefined {
  const raw = isPlainObject(options) ? options.direction : undefined;
  if (raw === undefined) return undefined;
  if (raw !== "out" && raw !== "in" && raw !== "both")
    throw compileError(
      "ValidationError",
      `${ctx.operation}: include._count.select."${key}.direction" must be "out", "in" or "both" (got ${describeValue(raw)}).`,
      { operation: ctx.operation, field: key },
    );
  return raw;
}
