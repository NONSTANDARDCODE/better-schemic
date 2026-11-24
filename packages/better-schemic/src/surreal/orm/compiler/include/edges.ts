/**
 * The GRAPH EDGE branch of the include compiler: per-parent correlated subqueries for target
 * records (`SELECT … FROM ->edge->target`), edge records (`FROM ->edge`), the `{ edge, target }`
 * remount (`out.*`/`in.*`) and wildcard traversals (`->?`). The filter split (edge vs target) and
 * the traversal syntax come from `../where` + `../relations` — never re-implemented here.
 */
import { escapeIdentSafe as escapeIdent } from "../../../ident"
import type { EdgeRef, TableMeta } from "../../meta"
import {
  type EdgeDirection,
  edgeMeta as resolveEdgeMeta,
  edgeTraversal,
  resolveEdge,
  targetMetas,
} from "../relations"
import { compileError, describeValue, isPlainObject } from "../shared"
import { compileRelationFilter, compileWhere } from "../where"

import {
  compileEdgeProjection,
  compileIncludeOrderBy,
  compileTargetProjection,
  subquery,
  wildcardTargetText,
} from "./projection"
import type { CompileCtx } from "./specs"

/** Compile one edge include (target/edge projections, filters, order/limit, wildcard). */
export function compileGraphEdge(
  meta: TableMeta,
  key: string,
  edgeRef: EdgeRef | undefined,
  entry: unknown,
  ctx: CompileCtx,
): void {
  const { index, operation } = ctx
  if (entry !== true && !isPlainObject(entry)) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" must be true or an options object, got ${describeValue(entry)}.`,
      { field: key, operation },
    )
  }
  const options: Record<string, unknown> = entry === true ? {} : entry
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
  ])
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const option of Object.keys(options)) {
    if (!allowed.has(option)) {
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}" has unknown option "${option}" — edge includes accept ${[...allowed].join(", ")}.`,
        { field: key, operation },
      )
    }
  }
  const wildcard = options.wildcard === true
  if (!edgeRef && !wildcard) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" is not an edge — pass { wildcard: true } to traverse ANY edge from "${meta.name}".`,
      { field: key, operation },
    )
  }
  if (wildcard && edgeRef) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" is a declared edge — drop "wildcard: true" (the wildcard is for undeclared edge names).`,
      { field: key, operation },
    )
  }
  if (options.target !== undefined && options.select !== undefined) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}": pass "select" (target shorthand) OR "target", not both.`,
      { field: key, operation },
    )
  }

  const requested = parseDirection(options.direction, ctx, key)
  const resolved = edgeRef ? resolveEdge(meta, key, requested, operation) : undefined
  const direction: EdgeDirection = requested ?? resolved?.direction ?? "out"
  const edgeMeta = resolved ? resolveEdgeMeta(index, resolved.edge.name) : undefined
  const targets = resolved ? targetMetas(index, resolved.targets) : []

  const hasEdge = options.edge !== undefined && options.edge !== false
  const targetSelect = unwrapTargetOption(options.target ?? options.select)
  const hasTarget = targetSelect !== undefined

  if (hasEdge && hasTarget && direction === "both") {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}" cannot project the edge and the target with direction "both" — there is no single target endpoint (pass direction "out"/"in", or project only one side).`,
      { field: key, operation },
    )
  }

  if (hasEdge && !hasTarget) {
    compileEdgeOnly(key, options, ctx, { direction, edgeMeta })
    return
  }
  if (hasEdge && hasTarget) {
    compileEdgeAndTarget(key, targetSelect, options, ctx, {
      direction,
      edgeMeta,
      targets,
    })
    return
  }
  compileTargetOnly(key, options, targetSelect, ctx, {
    direction,
    edgeMeta,
    targets,
  })
}

/** Parse `direction`. */
function parseDirection(raw: unknown, ctx: CompileCtx, key: string): EdgeDirection | undefined {
  if (raw === undefined) return undefined

  if (raw !== "out" && raw !== "in" && raw !== "both") {
    throw compileError(
      "ValidationError",
      `${ctx.operation}: include."${key}.direction" must be "out", "in" or "both" (got ${describeValue(raw)}).`,
      { field: key, operation: ctx.operation },
    )
  }
  return raw
}

/** `target`/`select` unwrap: `{ select }` -> the projection, `true` stays `true`. */
function unwrapTargetOption(raw: unknown): unknown {
  if (isPlainObject(raw) && "select" in raw) {
    const unknown = Object.keys(raw).find((k) => k !== "select")
    if (unknown) {
      throw compileError(
        "ValidationError",
        `a target projection only accepts "select" (got "${unknown}").`,
      )
    }
    return raw.select
  }
  return raw
}

/** The traversal refs an edge form shares. */
type EdgeScope = {
  readonly direction: EdgeDirection
  readonly edgeMeta: TableMeta | undefined
  readonly targets: readonly TableMeta[]
}

/** The rendered edge ref (`likes` / `?`) for a scope. */
function edgeNameOf(scope: EdgeScope): string {
  return scope.edgeMeta ? scope.edgeMeta.name : "?"
}

/** Edge records alone: `(SELECT <edgeProj> FROM ->edge [WHERE <edgePred>])`. */
function compileEdgeOnly(
  key: string,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  scope: {
    readonly direction: EdgeDirection
    readonly edgeMeta: TableMeta | undefined
  },
): void {
  const { binds, index, operation } = ctx
  const projection = compileEdgeProjection(options.edge, scope.edgeMeta, ctx)
  if (!scope.edgeMeta) {
    // Undeclared (wildcard) edge records — the row IS the edge; the filter applies to it.
    const predicate = compileWhere(options.where, binds, { index, operation })
    pushEdgeSubquery(ctx, key, {
      from: edgeTraversal({
        direction: scope.direction,
        edge: "?",
        ...(predicate ? { edgeFilter: predicate } : {}),
      }),
      options,
      orderBy: compileIncludeOrderBy(options.orderBy, projection.spec, ctx, key, "edge"),
      projection: projection.text,
    })
    ctx.specs.push({
      edge: projection.projection,
      key,
      kind: "edge",
      shape: "edge",
    })
    return
  }
  const compiled = compileRelationFilter({
    binds,
    context: `include.${key}`,
    edge: scope.edgeMeta,
    idOwner: "edge",
    index,
    operation,
    targets: [],
    where: options.where,
  })
  if (compiled.target !== undefined) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" projects only edge records, but the filter constrains the target — project target records ("target"/"select") or move the filter onto the edge.`,
      { field: key, operation },
    )
  }
  const predicate = compiled.edge ?? compiled.fragment
  pushEdgeSubquery(ctx, key, {
    from: edgeTraversal({
      direction: scope.direction,
      edge: scope.edgeMeta.name,
      ...(predicate ? { edgeFilter: predicate } : {}),
    }),
    options,
    orderBy: compileIncludeOrderBy(options.orderBy, projection.spec, ctx, key, "edge"),
    projection: projection.text,
  })
  ctx.specs.push({
    edge: projection.projection,
    key,
    kind: "edge",
    shape: "edge",
  })
}

/** Target records alone: `(SELECT <targetProj> FROM ->edge->target [WHERE <targetPred>])`. */
function compileTargetOnly(
  key: string,
  options: Record<string, unknown>,
  targetSelect: unknown,
  ctx: CompileCtx,
  scope: EdgeScope,
): void {
  const { binds, index, operation } = ctx
  const target = compileTargetProjection(scope.targets, targetSelect, ctx)
  const compiled = compileRelationFilter({
    where: options.where,
    ...(scope.edgeMeta ? { edge: scope.edgeMeta } : {}),
    binds,
    context: `include.${key}`,
    idOwner: "target",
    index,
    operation,
    targets: scope.targets,
  })
  const targetWhere = [compiled.target, compiled.fragment].filter(Boolean).join(" AND ")
  const from = edgeTraversal({
    direction: scope.direction,
    edge: edgeNameOf(scope),
    ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
    ...(scope.edgeMeta ? { targets: scope.targets.map((meta) => meta.name) } : {}),
  })
  const projection = scope.edgeMeta
    ? target.text
    : wildcardTargetText(targetSelect, scope.direction === "in" ? "in" : "out", ctx)
  pushEdgeSubquery(ctx, key, {
    from,
    projection,
    ...(targetWhere ? { where: targetWhere } : {}),
    options,
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      target.projection.entries[0]?.spec,
      ctx,
      key,
      "target",
    ),
  })
  ctx.specs.push({
    key,
    kind: "edge",
    shape: "target",
    target: target.projection,
  })
}

/** Edge + target: `(SELECT <edge…>, out.* FROM ->edge WHERE out.<targetPred>)` -> `{ edge, target }`. */
function compileEdgeAndTarget(
  key: string,
  targetSelect: unknown,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  scope: EdgeScope,
): void {
  const { binds, index, operation } = ctx
  const edgeProjection = compileEdgeProjection(options.edge, scope.edgeMeta, ctx)
  const target = compileTargetProjection(scope.targets, targetSelect, ctx)
  const alias = scope.direction === "in" ? "in" : "out"
  const compiled = compileRelationFilter({
    where: options.where,
    ...(scope.edgeMeta ? { edge: scope.edgeMeta } : {}),
    binds,
    context: `include.${key}`,
    idOwner: "target",
    index,
    operation,
    prefix: alias,
    targets: scope.targets,
  })
  const targetWhere = [compiled.target, compiled.fragment].filter(Boolean).join(" AND ")
  // The row is the EDGE — `out.*`/`in.*` materializes the target, so the traversal STOPS at the
  // edge (following to the target would make `out` undefined and return `{}`, see the map).
  const from = edgeTraversal({
    direction: scope.direction,
    edge: edgeNameOf(scope),
    ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
  })
  pushEdgeSubquery(ctx, key, {
    from,
    projection: `${edgeProjection.text}, ${alias}.*`,
    ...(targetWhere ? { where: targetWhere } : {}),
    options,
    orderBy: compileIncludeOrderBy(options.orderBy, edgeProjection.spec, ctx, key, "edge"),
  })
  ctx.specs.push({
    alias,
    edge: edgeProjection.projection,
    key,
    kind: "edge",
    shape: "edge-target",
    target: target.projection,
  })
}

/** Assemble + claim one edge subquery part (`(SELECT …) AS <key>`). */
function pushEdgeSubquery(
  ctx: CompileCtx,
  key: string,
  args: {
    readonly from: string
    readonly options: Record<string, unknown>
    readonly orderBy?: string
    readonly projection: string
    readonly where?: string
  },
): void {
  const sql = subquery({
    from: args.from,
    projection: args.projection,
    ...(args.where ? { where: args.where } : {}),
    ...(args.orderBy ? { orderBy: args.orderBy } : {}),
    binds: ctx.binds,
    limit: args.options.limit,
    operation: ctx.operation,
    start: args.options.start,
  })
  ctx.parts.push(`${sql} AS ${escapeIdent(key)}`)
}
