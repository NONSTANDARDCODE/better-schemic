/**
 * The GRAPH EDGE branch of the include compiler: per-parent correlated subqueries for target
 * records (`SELECT … FROM ->edge->target`), edge records (`FROM ->edge`), the `{ edge, target }`
 * remount (`out.*`/`in.*`) and wildcard traversals (`->?`). The filter split (edge vs target) and
 * the traversal syntax come from `../where` + `../relations` — never re-implemented here.
 */
import { escapeIdent } from "surrealdb";
import type { EdgeRef, TableMeta } from "../../meta";
import {
  type EdgeDirection,
  edgeTraversal,
  resolveEdge,
  edgeMeta as resolveEdgeMeta,
  targetMetas,
} from "../relations";
import { compileError, describeValue, isPlainObject } from "../shared";
import { compileRelationFilter, compileWhere } from "../where";
import {
  compileEdgeProjection,
  compileIncludeOrderBy,
  compileTargetProjection,
  subquery,
  wildcardTargetText,
} from "./projection";
import type { CompileCtx } from "./specs";

/** Compile one edge include (target/edge projections, filters, order/limit, wildcard). */
export function compileGraphEdge(
  meta: TableMeta,
  key: string,
  edgeRef: EdgeRef | undefined,
  entry: unknown,
  ctx: CompileCtx,
): void {
  const { operation, index } = ctx;
  if (entry !== true && !isPlainObject(entry))
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" must be true or an options object, got ${describeValue(entry)}.`,
      { operation, field: key },
    );
  const options: Record<string, unknown> = entry === true ? {} : entry;
  const allowed = new Set([
    "select",
    "target",
    "edge",
    "where",
    "orderBy",
    "limit",
    "start",
    "direction",
    "wildcard",
  ]);
  for (const option of Object.keys(options))
    if (!allowed.has(option))
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}" has unknown option "${option}" — edge includes accept ${[...allowed].join(", ")}.`,
        { operation, field: key },
      );
  const wildcard = options.wildcard === true;
  if (!edgeRef && !wildcard)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" is not an edge — pass { wildcard: true } to traverse ANY edge from "${meta.name}".`,
      { operation, field: key },
    );
  if (wildcard && edgeRef)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" is a declared edge — drop "wildcard: true" (the wildcard is for undeclared edge names).`,
      { operation, field: key },
    );
  if (options.target !== undefined && options.select !== undefined)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}": pass "select" (target shorthand) OR "target", not both.`,
      { operation, field: key },
    );

  const requested = parseDirection(options.direction, ctx, key);
  const resolved = edgeRef
    ? resolveEdge(meta, key, requested, operation)
    : undefined;
  const direction: EdgeDirection = requested ?? resolved?.direction ?? "out";
  const edgeMeta = resolved
    ? resolveEdgeMeta(index, resolved.edge.name)
    : undefined;
  const targets = resolved ? targetMetas(index, resolved.targets) : [];

  const hasEdge = options.edge !== undefined && options.edge !== false;
  const targetSelect = unwrapTargetOption(options.target ?? options.select);
  const hasTarget = targetSelect !== undefined;

  if (hasEdge && hasTarget && direction === "both")
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}" cannot project the edge and the target with direction "both" — there is no single target endpoint (pass direction "out"/"in", or project only one side).`,
      { operation, field: key },
    );

  if (hasEdge && !hasTarget) {
    compileEdgeOnly(key, options, ctx, { direction, edgeMeta });
    return;
  }
  if (hasEdge && hasTarget) {
    compileEdgeAndTarget(key, targetSelect, options, ctx, {
      direction,
      edgeMeta,
      targets,
    });
    return;
  }
  compileTargetOnly(key, options, targetSelect, ctx, {
    direction,
    edgeMeta,
    targets,
  });
}

/** Parse `direction`. */
function parseDirection(
  raw: unknown,
  ctx: CompileCtx,
  key: string,
): EdgeDirection | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "out" && raw !== "in" && raw !== "both")
    throw compileError(
      "ValidationError",
      `${ctx.operation}: include."${key}.direction" must be "out", "in" or "both" (got ${describeValue(raw)}).`,
      { operation: ctx.operation, field: key },
    );
  return raw;
}

/** `target`/`select` unwrap: `{ select }` -> the projection, `true` stays `true`. */
function unwrapTargetOption(raw: unknown): unknown {
  if (isPlainObject(raw) && "select" in raw) {
    const unknown = Object.keys(raw).find((k) => k !== "select");
    if (unknown)
      throw compileError(
        "ValidationError",
        `a target projection only accepts "select" (got "${unknown}").`,
      );
    return raw.select;
  }
  return raw;
}

/** The traversal refs an edge form shares. */
interface EdgeScope {
  readonly direction: EdgeDirection;
  readonly edgeMeta: TableMeta | undefined;
  readonly targets: readonly TableMeta[];
}

/** The rendered edge ref (`likes` / `?`) for a scope. */
function edgeNameOf(scope: EdgeScope): string {
  return scope.edgeMeta ? scope.edgeMeta.name : "?";
}

/** Edge records alone: `(SELECT <edgeProj> FROM ->edge [WHERE <edgePred>])`. */
function compileEdgeOnly(
  key: string,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  scope: {
    readonly direction: EdgeDirection;
    readonly edgeMeta: TableMeta | undefined;
  },
): void {
  const { binds, index, operation } = ctx;
  const projection = compileEdgeProjection(options.edge, scope.edgeMeta, ctx);
  if (!scope.edgeMeta) {
    // Undeclared (wildcard) edge records — the row IS the edge; the filter applies to it.
    const predicate = compileWhere(options.where, binds, { index, operation });
    pushEdgeSubquery(ctx, key, {
      projection: projection.text,
      from: edgeTraversal({
        edge: "?",
        direction: scope.direction,
        ...(predicate ? { edgeFilter: predicate } : {}),
      }),
      orderBy: compileIncludeOrderBy(
        options.orderBy,
        projection.spec,
        ctx,
        key,
        "edge",
      ),
      options,
    });
    ctx.specs.push({
      kind: "edge",
      shape: "edge",
      key,
      edge: projection.projection,
    });
    return;
  }
  const compiled = compileRelationFilter({
    where: options.where,
    edge: scope.edgeMeta,
    targets: [],
    idOwner: "edge",
    index,
    binds,
    operation,
    context: `include.${key}`,
  });
  if (compiled.target !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" projects only edge records, but the filter constrains the target — project target records ("target"/"select") or move the filter onto the edge.`,
      { operation, field: key },
    );
  const predicate = compiled.edge ?? compiled.fragment;
  pushEdgeSubquery(ctx, key, {
    projection: projection.text,
    from: edgeTraversal({
      edge: scope.edgeMeta.name,
      direction: scope.direction,
      ...(predicate ? { edgeFilter: predicate } : {}),
    }),
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      projection.spec,
      ctx,
      key,
      "edge",
    ),
    options,
  });
  ctx.specs.push({
    kind: "edge",
    shape: "edge",
    key,
    edge: projection.projection,
  });
}

/** Target records alone: `(SELECT <targetProj> FROM ->edge->target [WHERE <targetPred>])`. */
function compileTargetOnly(
  key: string,
  options: Record<string, unknown>,
  targetSelect: unknown,
  ctx: CompileCtx,
  scope: EdgeScope,
): void {
  const { binds, index, operation } = ctx;
  const target = compileTargetProjection(scope.targets, targetSelect, ctx);
  const compiled = compileRelationFilter({
    where: options.where,
    ...(scope.edgeMeta ? { edge: scope.edgeMeta } : {}),
    targets: scope.targets,
    idOwner: "target",
    index,
    binds,
    operation,
    context: `include.${key}`,
  });
  const targetWhere = [compiled.target, compiled.fragment]
    .filter(Boolean)
    .join(" AND ");
  const from = edgeTraversal({
    edge: edgeNameOf(scope),
    direction: scope.direction,
    ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
    ...(scope.edgeMeta
      ? { targets: scope.targets.map((meta) => meta.name) }
      : {}),
  });
  const projection = scope.edgeMeta
    ? target.text
    : wildcardTargetText(
        targetSelect,
        scope.direction === "in" ? "in" : "out",
        ctx,
      );
  pushEdgeSubquery(ctx, key, {
    projection,
    from,
    ...(targetWhere ? { where: targetWhere } : {}),
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      target.projection.entries[0]?.spec,
      ctx,
      key,
      "target",
    ),
    options,
  });
  ctx.specs.push({
    kind: "edge",
    shape: "target",
    key,
    target: target.projection,
  });
}

/** Edge + target: `(SELECT <edge…>, out.* FROM ->edge WHERE out.<targetPred>)` -> `{ edge, target }`. */
function compileEdgeAndTarget(
  key: string,
  targetSelect: unknown,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  scope: EdgeScope,
): void {
  const { binds, index, operation } = ctx;
  const edgeProjection = compileEdgeProjection(
    options.edge,
    scope.edgeMeta,
    ctx,
  );
  const target = compileTargetProjection(scope.targets, targetSelect, ctx);
  const alias = scope.direction === "in" ? "in" : "out";
  const compiled = compileRelationFilter({
    where: options.where,
    ...(scope.edgeMeta ? { edge: scope.edgeMeta } : {}),
    targets: scope.targets,
    idOwner: "target",
    prefix: alias,
    index,
    binds,
    operation,
    context: `include.${key}`,
  });
  const targetWhere = [compiled.target, compiled.fragment]
    .filter(Boolean)
    .join(" AND ");
  // The row is the EDGE — `out.*`/`in.*` materializes the target, so the traversal STOPS at the
  // edge (following to the target would make `out` undefined and silently return `{}`, see the map).
  const from = edgeTraversal({
    edge: edgeNameOf(scope),
    direction: scope.direction,
    ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
  });
  pushEdgeSubquery(ctx, key, {
    projection: `${edgeProjection.text}, ${alias}.*`,
    from,
    ...(targetWhere ? { where: targetWhere } : {}),
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      edgeProjection.spec,
      ctx,
      key,
      "edge",
    ),
    options,
  });
  ctx.specs.push({
    kind: "edge",
    shape: "edge-target",
    key,
    alias,
    target: target.projection,
    edge: edgeProjection.projection,
  });
}

/** Assemble + claim one edge subquery part (`(SELECT …) AS <key>`). */
function pushEdgeSubquery(
  ctx: CompileCtx,
  key: string,
  args: {
    readonly projection: string;
    readonly from: string;
    readonly where?: string;
    readonly orderBy?: string;
    readonly options: Record<string, unknown>;
  },
): void {
  const sql = subquery({
    projection: args.projection,
    from: args.from,
    ...(args.where ? { where: args.where } : {}),
    ...(args.orderBy ? { orderBy: args.orderBy } : {}),
    limit: args.options.limit,
    start: args.options.start,
    binds: ctx.binds,
    operation: ctx.operation,
  });
  ctx.parts.push(`${sql} AS ${escapeIdent(key)}`);
}
