/**
 * Compiler for the typed graph traversal read (`Delegate.from(anchor).graph(...)`).
 *
 * Emits a single `SELECT [DISTINCT] VALUE <traversal> FROM  <anchor>` statement and decodes
 * the resulting node array through the final node's codec/projection. Reuses `edgeTraversal`,
 * `classifyWhereByOwner`, `compileWhere` and `compileProjection` so the surface stays consistent
 * with `include`/`where`.
 */
import { RecordId } from "surrealdb"

import { type Ctx, fragOf } from "../../pure"
import { isExpr, lowerExpr, mkRef } from "../../surql/predicate"
import type { ModelMeta, SchemaIndex } from "../meta"
import { stringCoerce } from "../text"

import { compileProjection } from "./projection"
import { classifyWhereByOwner, edgeMeta, edgeTraversal, targetMetas } from "./relations"
import { type Binds, isTableMeta } from "./shared"
import { compileWhere } from "./where"

export type GraphStep = {
  readonly direction: "both" | "in" | "out"
  /** Compiled edge-side filter (undefined = none). */
  edgeFilter?: string
  readonly edgeName: string
  readonly edgeRawWhere?: unknown
  readonly kind?: "edge" | "node"
  readonly opts?: { readonly where?: unknown }
  readonly rawWhere?: unknown
  /** Target-side filter, once compiled. */
  targetFilter?: string
  /** Physical target table names this step reaches. */
  targets: readonly string[]
}

/** Options of a `repeat(...)` wrapper: the flags the emitter reads. */
type RepeatOpts = {
  readonly collect?: boolean
  readonly paths?: boolean
  readonly shortest?: unknown
  readonly where?: unknown
}

export type GraphBuilderState = {
  readonly anchor: unknown
  readonly distinct?: boolean
  readonly finalWhere?: unknown // object or Expr
  readonly repeat?: {
    readonly depth: unknown
    readonly opts?: RepeatOpts
    readonly steps: readonly GraphStep[]
  }
  readonly select?: unknown // object or callback result
  readonly steps: GraphStep[]
}

export type CompiledGraph = {
  readonly binds: Binds
  readonly finalMeta: ModelMeta
  readonly spec: ReturnType<typeof compileProjection>["spec"]
  readonly sql: string
}

function parseAnchor(anchor: unknown): unknown {
  if (anchor instanceof RecordId) return anchor

  if (typeof anchor === "string") {
    const idx = anchor.indexOf(":")
    if (idx > 0) {
      const table = anchor.slice(0, idx)
      const id = anchor.slice(idx + 1)
      // Strip surrounding angle brackets if present.
      const bare = id.startsWith("⟨") && id.endsWith("⟩") ? id.slice(1, -1) : id
      try {
        return new RecordId(table, bare)
      } catch {
        return anchor
      }
    }
  }
  return anchor
}

export function compileGraph(
  meta: ModelMeta,
  ctx: { readonly index: SchemaIndex },
  anchor: unknown,
  builder: GraphBuilderState & { readonly _binds?: Binds },
  binds: Binds,
  operation = "graph",
): CompiledGraph {
  const index = ctx.index

  const activeSteps = builder.repeat ? builder.repeat.steps : builder.steps
  // Resolve steps' filters into SQL using the shared binds.
  const steps = activeSteps.map((s) => ({ ...s }))

  steps.forEach((step) => {
    // edgeRawWhere (attached via .where() while the step was still an edge) → edge filter
    const eraw = step.edgeRawWhere
    if (eraw !== undefined && eraw !== null) {
      const sql = isExpr(eraw)
        ? lowerExpr(eraw, { vars: binds.vars })
        : compileWhere(eraw, binds, {
            index,
            meta: edgeMeta(index, step.edgeName),
            operation,
          })
      if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql)
    }
    const where = step.opts?.where ?? step.rawWhere
    if (where === undefined || where === null) return

    if (step.kind === "edge") {
      if (isExpr(where)) {
        const c: Ctx = { vars: binds.vars }
        step.edgeFilter = mergeFilter(step.edgeFilter, lowerExpr(where, c))
        return
      }
      const em = edgeMeta(index, step.edgeName)
      const sql = compileWhere(where, binds, { index, meta: em, operation })
      if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql)

      return
    }
    if (isExpr(where)) {
      const c: Ctx = { vars: binds.vars }
      step.targetFilter = mergeFilter(step.targetFilter, lowerExpr(where, c))
      return
    }
    const em = edgeMeta(index, step.edgeName)
    const tms = targetMetas(index, step.targets)
    const owned = classifyWhereByOwner({
      context: `graph.${step.direction}`,
      edge: em,
      idOwner: "target",
      operation,
      targets: tms,
      where,
    })
    if (owned.edge) {
      const sql = compileWhere(owned.edge, binds, {
        index,
        meta: em,
        operation,
      })
      if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql)
    }
    if (owned.target) {
      const sql = compileWhere(owned.target, binds, {
        index,
        meta: tms[0],
        operation,
      })
      if (sql) step.targetFilter = mergeFilter(step.targetFilter, sql)
    }
    if (owned.fragment) {
      // fragment → target side
      const sql = compileWhere(owned.fragment, binds, {
        index,
        meta: tms[0],
        operation,
      })
      if (sql) step.targetFilter = mergeFilter(step.targetFilter, sql)
    }
  })

  // Final node meta.
  let finalMeta: ModelMeta = meta
  const lastStepSource = builder.repeat ? builder.repeat.steps : steps
  const last = lastStepSource.at(-1)
  if (last !== undefined) {
    if (last.kind === "edge") {
      const em = edgeMeta(index, last.edgeName)
      if (em) finalMeta = em
    } else {
      const tms = targetMetas(index, last.targets)
      if (tms.length > 0) finalMeta = tms[0]
    }
  }

  // Final where (object or Expr) → target filter on last step, or anchor-level.
  let finalWhereSql: string | undefined
  if (builder.finalWhere !== undefined && builder.finalWhere !== null) {
    if (isExpr(builder.finalWhere)) {
      const c: Ctx = { vars: binds.vars }
      finalWhereSql = lowerExpr(builder.finalWhere, c)
    } else if (typeof builder.finalWhere === "function") {
      // callback form handled by builder already converted to Expr; if not, invoke.
      const nodeProxy = makeNodeProxy()
      const res = (builder.finalWhere as (n: unknown) => unknown)(nodeProxy)
      if (isExpr(res)) {
        const c: Ctx = { vars: binds.vars }
        finalWhereSql = lowerExpr(res, c)
      } else {
        const sql = compileWhere(res, binds, {
          index,
          meta: isTableMeta(finalMeta) ? finalMeta : undefined,
          operation,
        })
        finalWhereSql = sql ?? undefined
      }
    } else {
      const sql = compileWhere(builder.finalWhere, binds, {
        index,
        meta: isTableMeta(finalMeta) ? finalMeta : undefined,
        operation,
      })
      finalWhereSql = sql ?? undefined
    }
  }

  const targetSteps = builder.repeat ? builder.repeat.steps : steps
  if (finalWhereSql) {
    const last = targetSteps.at(-1)
    if (last === undefined) {
      // zero-hop: cannot filter anchor; leave as-is (documented limitation)
    } else last.targetFilter = mergeFilter(last.targetFilter, finalWhereSql)
  }

  // Rebuild path after mutating last step's targetFilter.
  const finalStepPath = targetSteps
    .map((s) =>
      edgeTraversal({
        direction: s.direction,
        edge: s.edgeName,
        edgeFilter: s.edgeFilter,
        targetFilter: s.targetFilter,
        targets: s.kind === "edge" ? undefined : s.targets,
      }),
    )
    .join("")

  // Repeat wrapper (rebuild).
  let finalPath: string
  if (builder.repeat) {
    const r = builder.repeat
    const depth = r.depth
    const rangeSpec =
      typeof depth === "object" && depth !== null
        ? (depth as { readonly max?: number; readonly min?: number })
        : undefined
    const numeric = typeof depth === "number" ? depth : undefined
    const min = rangeSpec?.min ?? numeric
    const max = rangeSpec?.max ?? numeric
    let range: string
    if (min !== undefined && max !== undefined) range = min === max ? `${min}` : `${min}..${max}`
    else if (min !== undefined) range = `${min}..`
    else if (max === undefined) range = ".."
    else range = `..${max}`

    const opts: RepeatOpts = r.opts ?? {}
    let suffix = ""
    if (opts.collect) suffix += "+collect"

    if (opts.paths) suffix += "+path"

    if (opts.shortest) suffix += `+shortest=${stringCoerce(opts.shortest)}`

    finalPath = `{${range}${suffix}}(${finalStepPath})`
  } else finalPath = finalStepPath

  // Select handling.
  let selectArg: unknown = builder.select
  if (typeof selectArg === "function") {
    const nodeProxy = makeNodeProxy()
    const res = (selectArg as (n: unknown) => unknown)(nodeProxy)
    // convert FieldRefs to fragments
    selectArg = convertSelect(res)
  }

  const hasSelect = selectArg !== undefined && selectArg !== null
  const { spec, text: projText } = compileProjection(
    finalMeta,
    hasSelect ? selectArg : undefined,
    undefined,
    false,
    binds,
    operation,
  )

  let traversalExpr: string
  if (!finalPath) traversalExpr = hasSelect ? projText : "*"
  else if (builder.repeat) traversalExpr = hasSelect ? `${finalPath}.{${projText}}` : finalPath
  else traversalExpr = hasSelect ? `${finalPath}.{${projText}}` : `${finalPath}.*`

  // Bind the anchor AFTER the filters so $p numbering follows clause order.
  const anchorSql = binds.add(parseAnchor(anchor))

  const distinct = builder.distinct ? "DISTINCT " : ""
  const sql = `SELECT ${distinct}VALUE ${traversalExpr} FROM ONLY ${anchorSql}`

  return { binds, finalMeta, spec, sql }
}

function mergeFilter(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return `(${a}) AND (${b})`

  return a ?? b
}

function makeNodeProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_t, key): unknown {
        if (typeof key !== "string" || key === "then") return undefined

        return mkRef({ kind: "other", root: { col: key } })
      },
    },
  )
}

function convertSelect(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) return value.map((item) => convertSelect(item))

  if (typeof value === "function") return value

  if (typeof value !== "object") return value

  const out: Record<string, unknown> = {}

  Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
    const f = fragOf(v)
    out[k] = f ?? convertSelect(v)
  })
  return out
}
