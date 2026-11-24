import { BoundQuery, RecordId } from "surrealdb"

import { fragOf } from "../pure"
import { isExpr, mkRef, toExpr } from "../surql/predicate"

import type { GraphStep } from "./compiler/graph"
import { compileGraph } from "./compiler/graph"
import { createBinds, isTableMeta } from "./compiler/shared"
import { decodeRows } from "./decode"
import type { DelegateContext } from "./delegate"
import { execute, type Statement } from "./execute"
import type { ModelMeta, SchemaIndex } from "./meta"
import { attachExplain, type ExplainKey, lazyResult } from "./results"
import type { AnyRelationDef } from "./types/schema"

type Direction = "both" | "in" | "out"

/** The duck-typed view of a relation def handed to the dynamic graph builder. */
type EdgeLike = {
  readonly config?: {
    readonly relation?: {
      readonly from?: readonly string[]
      readonly to?: readonly string[]
    }
  }
  readonly name?: unknown
}

/** Options accepted by an edge step (`where` may be a predicate callback). */
type StepOpts = {
  [key: string]: unknown
  where?: unknown
}

/** The builder's steps are mutable while chaining; compilation reads them. */
type MutableStep = { -readonly [K in keyof GraphStep]: GraphStep[K] } & {
  edge?: EdgeLike
  edgeRawWhere?: unknown
}

type BuilderState = {
  _ctx: DelegateContext
  _meta: ModelMeta
  anchor: unknown
  distinct?: boolean
  finalWhere?: unknown
  rawPath?: string
  repeat?: { depth: unknown; opts: StepOpts; steps: MutableStep[] }
  select?: unknown
  steps: MutableStep[]
}

/** The fluent graph API — a thenable, so `await delegate.from(x).graph(g => …)` is awaitable. */
export type GraphBuilderApi = {
  readonly _state: BuilderState
  both(edge: unknown, opts?: StepOpts): GraphBuilderApi
  bothEdges(edge: unknown, opts?: StepOpts): GraphBuilderApi
  collect(): GraphBuilderApi
  distinct(): GraphBuilderApi
  in(edge: unknown, opts?: StepOpts): GraphBuilderApi
  inEdges(edge: unknown, opts?: StepOpts): GraphBuilderApi
  node(targets?: unknown): GraphBuilderApi
  out(edge: unknown, opts?: StepOpts): GraphBuilderApi
  outEdges(edge: unknown, opts?: StepOpts): GraphBuilderApi
  paths(): GraphBuilderApi
  repeat(depth: unknown, fn: (g: GraphBuilderApi) => unknown, opts?: StepOpts): GraphBuilderApi
  select(shape: unknown): GraphBuilderApi
  shortest(target: unknown): GraphBuilderApi
  then<Rejected = never, Resolved = unknown>(
    onFulfilled?: ((value: unknown) => PromiseLike<Resolved> | Resolved) | null,
    onRejected?: ((reason: unknown) => PromiseLike<Rejected> | Rejected) | null,
  ): Promise<Rejected | Resolved>
  where(filter: unknown): GraphBuilderApi
}

/** Entry point returned by `delegate.from(anchor)`. */
export type GraphEntryPoint = {
  graph(fn: (g: GraphBuilderApi) => unknown): unknown
  traverse(strings: TemplateStringsArray, ...values: unknown[]): unknown
}

export function createGraphEntryPoint(
  meta: ModelMeta,
  ctx: DelegateContext,
  anchor: unknown,
): GraphEntryPoint {
  return {
    graph(fn) {
      const builder = createBuilder(meta, ctx, anchor)
      const terminal = fn(builder)
      return finishGraph(meta, ctx, terminal)
    },
    traverse(strings, ...values) {
      const path = strings.reduce(
        (acc, s, i) => acc + s + (i < values.length ? valueText(values[i]) : ""),
        "",
      )
      const builder = createBuilder(meta, ctx, anchor)
      parseTraversalPath(path, builder, meta, ctx)
      return finishGraph(meta, ctx, builder)
    },
  }
}

/** Text used by the runtime-parsed traversal path for one interpolated value. */
function valueText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  if (typeof value === "object" && "name" in value) return targetNameOf(value)
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- interpolação legada: o path aceita qualquer valor
  return String(value)
}

/** Duck-type an edge def; non-object inputs carry no config/targets. */
function asEdgeLike(value: unknown): EdgeLike | undefined {
  return typeof value === "object" && value !== null ? value : undefined
}

/** A relation/schema def's public name, used as an edge/target name in the path. */
function targetNameOf(value: unknown): string {
  if (typeof value === "string") return value
  const edge = asEdgeLike(value)
  return typeof edge?.name === "string" ? edge.name : ""
}

/** Extract the builder state from a terminal (a builder or a state bag). */
function stateOf(terminal: unknown): BuilderState {
  if (typeof terminal === "object" && terminal !== null && "_state" in terminal)
    return (terminal as { readonly _state: BuilderState })._state

  return terminal as BuilderState
}

function createBuilder(meta: ModelMeta, ctx: DelegateContext, anchor: unknown): GraphBuilderApi {
  const state: BuilderState = {
    _ctx: ctx,
    _meta: meta,
    anchor,
    // tagged template path (Slice B) — runtime-parsed steps
    rawPath: undefined,
    repeat: undefined,
    steps: [],
  }

  const edgeStep = (direction: Direction, edge: unknown, opts?: StepOpts) => {
    const resolved = resolveEdgeRuntime(edge, direction)
    const newOpts: StepOpts | undefined = opts ? { ...opts } : undefined
    if (newOpts && typeof newOpts.where === "function") {
      const proxy = makeNodeProxy()
      const res = (newOpts.where as (node: unknown) => unknown)(proxy)
      const fragment = fragOf(res)
      newOpts.where = fragment === undefined ? res : fragment
    }
    const step: MutableStep = {
      direction,
      edge: asEdgeLike(edge),
      edgeName: resolved.edgeName,
      kind: "edge",
      opts: newOpts,
      rawWhere: newOpts?.where,
      targets: [],
    }
    state.steps.push(step)
    return api
  }

  const step = (direction: Direction, edge: unknown, opts?: StepOpts) => {
    const resolved = resolveEdgeRuntime(edge, direction)
    const newOpts: StepOpts | undefined = opts ? { ...opts } : undefined
    if (newOpts && typeof newOpts.where === "function") {
      const proxy = makeNodeProxy()
      const res = (newOpts.where as (node: unknown) => unknown)(proxy)
      const fragment = fragOf(res)
      newOpts.where = fragment === undefined ? res : fragment
    }
    const next: MutableStep = {
      direction,
      edgeName: resolved.edgeName,
      kind: "node",
      opts: newOpts,
      rawWhere: newOpts?.where,
      targets: resolved.targets,
    }
    state.steps.push(next)
    return api
  }

  const api: GraphBuilderApi = {
    _state: state,
    both(edge, opts) {
      return step("both", edge, opts)
    },
    bothEdges(edge, opts) {
      return edgeStep("both", edge, opts)
    },
    collect() {
      if (state.repeat) state.repeat.opts = { ...state.repeat.opts, collect: true }

      return api
    },
    distinct() {
      state.distinct = true
      return api
    },
    in(edge, opts) {
      return step("in", edge, opts)
    },
    inEdges(edge, opts) {
      return edgeStep("in", edge, opts)
    },
    node(targets) {
      const last: MutableStep | undefined = state.steps.at(-1)
      if (last?.kind === "edge") {
        last.kind = "node"
        if (targets) {
          last.targets = Array.isArray(targets)
            ? targets.map((target: unknown) => targetNameOf(target))
            : [targetNameOf(targets)]
        } else {
          const cfg = last.edge?.config?.relation ?? {}
          let derived: string[]
          if (last.direction === "out") derived = [...(cfg.to ?? [])]
          else if (last.direction === "in") derived = [...(cfg.from ?? [])]
          else derived = [...new Set([...(cfg.to ?? []), ...(cfg.from ?? [])])]
          last.targets = derived
        }
      }
      return api
    },
    out(edge, opts) {
      return step("out", edge, opts)
    },
    outEdges(edge, opts) {
      return edgeStep("out", edge, opts)
    },
    paths() {
      if (state.repeat) state.repeat.opts = { ...state.repeat.opts, paths: true }

      return api
    },
    repeat(depth, fn, opts) {
      const innerBuilder = createBuilder(meta, ctx, anchor)
      const innerTerminal = fn(innerBuilder)
      const innerState = stateOf(innerTerminal)
      state.repeat = { depth, opts: opts ?? {}, steps: innerState.steps }
      state.steps = []
      return api
    },
    select(shape) {
      if (typeof shape === "function") {
        const proxy = makeNodeProxy()
        const res = (shape as (node: unknown) => unknown)(proxy)
        state.select = convertSelectRuntime(res)
      } else state.select = shape

      return api
    },
    shortest(target) {
      if (state.repeat) {
        state.repeat.opts = {
          ...state.repeat.opts,
          shortest: target instanceof RecordId ? String(target) : target,
        }
      }
      return api
    },
    // eslint-disable-next-line unicorn/no-thenable -- thenable é contrato: o grafo só executa quando aguardado
    then(onFulfilled, onRejected) {
      const result = finishGraph(state._meta, state._ctx, api)
      return Promise.resolve(result).then(onFulfilled, onRejected)
    },
    where(filter) {
      const last: MutableStep | undefined = state.steps.at(-1)
      let raw: unknown = filter
      if (typeof filter === "function") {
        const proxy = makeNodeProxy()
        const res = (filter as (node: unknown) => unknown)(proxy)
        const fragment = fragOf(res)
        raw = fragment === undefined ? res : fragment
      }
      if (last?.kind === "edge") last.edgeRawWhere = raw
      else state.finalWhere = raw

      return api
    },
  }
  return api
}

function findEdgeDef(
  index: SchemaIndex,
  name: string,
  fromMeta?: ModelMeta,
): AnyRelationDef | { readonly name: string } {
  const candidates: AnyRelationDef[] = []
  if (fromMeta && isTableMeta(fromMeta)) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const edge of fromMeta.outgoing)
      if (edge.name === name || edge.key === name) candidates.push(edge.def)

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const edge of fromMeta.incoming)
      if (edge.name === name || edge.key === name) candidates.push(edge.def)
  }
  if (candidates.length > 0) return candidates[0]

  // fallback: search all tables
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const table of index.tables.values()) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const edge of table.outgoing) if (edge.name === name || edge.key === name) return edge.def

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const edge of table.incoming) if (edge.name === name || edge.key === name) return edge.def
  }
  return { name }
}

function parseTraversalPath(
  path: string,
  builder: GraphBuilderApi,
  meta: ModelMeta,
  ctx: DelegateContext,
) {
  const index = ctx.index
  // regex: (->|<-|<->) name (->|<-|<->) name  ... consume edge+target pairs
  const pattern = /(->|<-|<->)\s*(\w+)\s*(->|<-|<->)\s*(\w+)/gu
  let currentMeta: ModelMeta = meta
  let match: null | RegExpExecArray
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while ((match = pattern.exec(path)) !== null) {
    const arrow = match[1]
    const edgeName = match[2]
    const edgeDef = findEdgeDef(index, edgeName, currentMeta)
    let direction: Direction = "both"
    if (arrow === "->") direction = "out"
    else if (arrow === "<-") direction = "in"
    if (direction === "out") builder.out(edgeDef)
    else if (direction === "in") builder.in(edgeDef)
    else builder.both(edgeDef)

    const targetName = match[4]
    const targetMeta = index.byName.get(targetName)
    if (targetMeta) currentMeta = targetMeta
  }
}

/** Endpoint targets of one traversal step, derived from the relation endpoints. */
function targetsFor(
  cfg: { readonly from?: readonly string[]; readonly to?: readonly string[] },
  explicit: Direction,
): string[] {
  if (explicit === "out") return [...(cfg.to ?? [])]
  if (explicit === "in") return [...(cfg.from ?? [])]
  return [...new Set([...(cfg.to ?? []), ...(cfg.from ?? [])])]
}

function resolveEdgeRuntime(edge: unknown, explicit: Direction) {
  // edge is a RelationDef instance; use its name (config carries the declared endpoints).
  const edgeLike = asEdgeLike(edge)
  const edgeName = edgeLike?.name ?? (typeof edge === "string" ? edge : "")
  const cfg = edgeLike?.config?.relation ?? {}
  return { edgeName: targetNameOf(edgeName), targets: targetsFor(cfg, explicit) }
}

function finishGraph(meta: ModelMeta, ctx: DelegateContext, terminal: unknown) {
  const state = stateOf(terminal)
  const binds = createBinds()
  const anchor = state.anchor
  const builderState = {
    anchor,
    distinct: state.distinct,
    finalWhere: state.finalWhere,
    repeat: state.repeat,
    select: state.select,
    steps: state.steps,
  }
  const compiled = compileGraph(meta, { index: ctx.index }, anchor, builderState, binds, "graph")
  const decode = (rows: readonly unknown[]) => {
    const raw = rows[0]
    let arr: readonly unknown[]
    if (Array.isArray(raw)) arr = raw
    else if (raw === null || raw === undefined) arr = []
    else arr = [raw]
    return decodeRows(arr, compiled.finalMeta, compiled.spec, ctx.index)
  }
  const prepared: {
    readonly context: undefined
    readonly decode: typeof decode
    readonly explain: false
    readonly hookMeta: undefined
    readonly meta: ModelMeta
    readonly operation: string
    readonly resultMode: "many"
    readonly statements: readonly { readonly key: ExplainKey; readonly statement: Statement }[]
    readonly where: undefined
  } = {
    context: undefined,
    decode,
    explain: false,
    hookMeta: undefined,
    meta: compiled.finalMeta,
    operation: "graph",
    resultMode: "many",
    statements: [
      {
        key: "data",
        statement: { sql: compiled.sql, vars: compiled.binds.vars },
      },
    ],
    where: undefined,
  }
  const runPrepared = async () => {
    const out = await execute(ctx.conn, {
      debug: ctx.debug,
      logger: ctx.logger,
      operation: prepared.operation,
      statements: prepared.statements.map((entry) => entry.statement),
      table: prepared.meta.name,
    })
    return prepared.decode(out.rows)
  }
  const explainPrepared = async () => {
    const out = await execute(ctx.conn, {
      debug: ctx.debug,
      logger: ctx.logger,
      operation: prepared.operation,
      statements: prepared.statements.map((entry) => ({
        sql: `EXPLAIN ${entry.statement.sql}`,
        vars: entry.statement.vars,
      })),
      table: prepared.meta.name,
    })
    return {
      driver: "surrealdb" as const,
      ignoredOptions: [],
      operation: prepared.operation,
      statements: prepared.statements.map((entry, index) => ({
        key: entry.key,
        plan: out.rows[index],
        surql: entry.statement.sql,
        vars: entry.statement.vars ?? {},
      })),
    }
  }
  const result = lazyResult(() => runPrepared())
  return attachExplain(result, () => explainPrepared())
}

/** Node proxy: field reads become refs, `.match()` becomes a guarded expression or projection. */
function makeNodeProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string" || key === "then") return

        if (key === "match") {
          // eslint-disable-next-line @typescript-eslint/consistent-return -- oProxy.get retorna undefined para chaves especiais
          return (member: unknown, fn: (node: unknown) => unknown) => {
            const memberName = typeof member === "string" ? member : targetNameOf(member)
            const memberProxy = makeNodeProxy()
            const res = fn(memberProxy)
            if (isExpr(res)) {
              const guard = new BoundQuery(`record::tb(id) = '${memberName}'`, {})
              return toExpr(guard).and(res)
            }
            const fragment = fragOf(res)
            if (fragment) {
              const text = `IF record::tb(id) = '${memberName}' THEN ${fragment.query} ELSE NONE END`
              return new BoundQuery(text, { ...fragment.bindings })
            }
            return res
          }
        }
        // eslint-disable-next-line @typescript-eslint/consistent-return -- oProxy.get retorna undefined para chaves especiais
        return mkRef({ kind: "other", root: { col: key } })
      },
    },
  )
}

function convertSelectRuntime(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (Array.isArray(value)) return value.map((entry: unknown) => convertSelectRuntime(entry))

  if (typeof value === "function") return value

  if (typeof value !== "object") return value

  const out: Record<string, unknown> = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fragment = fragOf(entry)
    out[key] = fragment === undefined ? convertSelectRuntime(entry) : fragment
  }
  return out
}
