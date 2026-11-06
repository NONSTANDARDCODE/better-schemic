import { BoundQuery, RecordId } from "surrealdb";
import { fragOf } from "../pure";
import { isExpr, mkRef, toExpr } from "../surql/predicate";
import type { GraphBuilderState, GraphStep } from "./compiler/graph";
import { compileGraph } from "./compiler/graph";
import { createBinds } from "./compiler/shared";
import { decodeRows } from "./decode";
import type { DelegateContext } from "./delegate";
import { execute } from "./execute";
import type { ModelMeta, SchemaIndex } from "./meta";
import { attachExplain, lazyResult } from "./results";

export interface GraphEntryPoint<TD, S, P> {
  graph(fn: (g: any) => any): any;
  // tagged template deferred
}

export function createGraphEntryPoint(
  meta: ModelMeta,
  ctx: DelegateContext,
  anchor: unknown,
): any {
  const entry = {
    graph(fn: (g: any) => any) {
      const builder = createBuilder(meta, ctx, anchor);
      const terminal = fn(builder);
      return finishGraph(meta, ctx, terminal);
    },
    traverse(strings: TemplateStringsArray, ...values: any[]) {
      const path = strings.reduce(
        (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""),
        "",
      );
      const builder = createBuilder(meta, ctx, anchor);
      parseTraversalPath(path, builder, meta, ctx);
      return finishGraph(meta, ctx, builder);
    },
  };
  return entry;
}

function createBuilder(
  meta: ModelMeta,
  ctx: DelegateContext,
  anchor: unknown,
): any {
  const state: any = {
    anchor,
    steps: [],
    _meta: meta,
    _ctx: ctx,
    repeat: undefined,
    // tagged template path (Slice B) — runtime-parsed steps
    rawPath: undefined,
  };

  const edgeStep = (
    direction: "out" | "in" | "both",
    edge: any,
    opts?: any,
  ) => {
    const resolved = resolveEdgeRuntime(metaFor(state), edge, direction);
    const newOpts = opts ? { ...opts } : undefined;
    if (newOpts && typeof newOpts.where === "function") {
      const proxy = makeNodeProxy();
      const res = newOpts.where(proxy);
      const f = fragOf(res);
      newOpts.where = f !== undefined ? f : res;
    }
    const s: any = {
      direction,
      kind: "edge",
      edgeName: resolved.edgeName,
      edge,
      opts: newOpts,
      targets: [],
      rawWhere: newOpts?.where,
    };
    state.steps.push(s);
    return api;
  };

  const step = (direction: "out" | "in" | "both", edge: any, opts?: any) => {
    const resolved = resolveEdgeRuntime(metaFor(state), edge, direction);
    const newOpts = opts ? { ...opts } : undefined;
    if (newOpts && typeof newOpts.where === "function") {
      const proxy = makeNodeProxy();
      const res = newOpts.where(proxy);
      const f = fragOf(res);
      newOpts.where = f !== undefined ? f : res;
    }
    const s: GraphStep = {
      direction,
      kind: "node",
      edgeName: resolved.edgeName,
      opts: newOpts,
      targets: resolved.targets,
      rawWhere: newOpts?.where,
    };
    state.steps.push(s);
    return api;
  };

  const api: any = {
    _state: state,
    out(edge: any, opts?: any) {
      return step("out", edge, opts);
    },
    in(edge: any, opts?: any) {
      return step("in", edge, opts);
    },
    both(edge: any, opts?: any) {
      return step("both", edge, opts);
    },
    outEdges(edge: any, opts?: any) {
      return edgeStep("out", edge, opts);
    },
    inEdges(edge: any, opts?: any) {
      return edgeStep("in", edge, opts);
    },
    bothEdges(edge: any, opts?: any) {
      return edgeStep("both", edge, opts);
    },
    node(targets?: any) {
      const last: any = state.steps[state.steps.length - 1];
      if (last && last.kind === "edge") {
        last.kind = "node";
        if (targets) {
          last.targets = Array.isArray(targets)
            ? targets.map((t: any) => t?.name ?? t)
            : [targets?.name ?? targets];
        } else {
          const cfg = last.edge?.config?.relation ?? {};
          const derived =
            last.direction === "out"
              ? [...(cfg.to ?? [])]
              : last.direction === "in"
                ? [...(cfg.from ?? [])]
                : [...new Set([...(cfg.to ?? []), ...(cfg.from ?? [])])];
          last.targets = derived.length ? derived : [];
        }
      }
      return api;
    },
    where(filter: any) {
      const last: any = state.steps[state.steps.length - 1];
      let raw: any = filter;
      if (typeof filter === "function") {
        const proxy = makeNodeProxy();
        const res = filter(proxy);
        const f = fragOf(res);
        raw = f !== undefined ? f : res;
      }
      if (last && last.kind === "edge") {
        last.edgeRawWhere = raw;
      } else {
        state.finalWhere = raw;
      }
      return api;
    },
    select(shape: any) {
      if (typeof shape === "function") {
        const proxy = makeNodeProxy();
        const res = shape(proxy);
        state.select = convertSelectRuntime(res);
      } else {
        state.select = shape;
      }
      return api;
    },
    distinct() {
      state.distinct = true;
      return api;
    },
    repeat(depth: any, fn: (g: any) => any, opts?: any) {
      const innerBuilder = createBuilder(meta, ctx, anchor);
      const innerTerminal = fn(innerBuilder);
      const innerState = innerTerminal?._state ?? innerTerminal;
      state.repeat = { depth, steps: innerState.steps ?? [], opts: opts ?? {} };
      state.steps = [];
      return api;
    },
    collect() {
      if (state.repeat)
        state.repeat.opts = { ...(state.repeat.opts ?? {}), collect: true };
      return api;
    },
    paths() {
      if (state.repeat)
        state.repeat.opts = { ...(state.repeat.opts ?? {}), paths: true };
      return api;
    },
    shortest(target: any) {
      if (state.repeat)
        state.repeat.opts = {
          ...(state.repeat.opts ?? {}),
          shortest: target instanceof RecordId ? String(target) : target,
        };
      return api;
    },
    // biome-ignore lint/suspicious/noThenProperty: a lazy thenable is the point — await starts it.
    then(onFulfilled?: any, onRejected?: any) {
      // lazy compile
      const result = finishGraph(state._meta, state._ctx, api);
      return Promise.resolve(result).then(onFulfilled, onRejected);
    },
  };
  return api;
}

function metaFor(state: any): ModelMeta {
  // current node meta: last step's target or anchor meta
  return state._meta;
}

function findEdgeDef(
  index: SchemaIndex,
  name: string,
  fromMeta?: ModelMeta,
): any {
  // search anchor meta's adjacent edges first
  const candidates: any[] = [];
  if (fromMeta) {
    for (const e of (fromMeta as any).outgoing ?? [])
      if (e.name === name || e.key === name) candidates.push(e.def);
    for (const e of (fromMeta as any).incoming ?? [])
      if (e.name === name || e.key === name) candidates.push(e.def);
  }
  if (candidates.length) return candidates[0];
  // fallback: search all tables
  for (const m of (index as any).tables?.values?.() ?? []) {
    for (const e of (m as any).outgoing ?? [])
      if (e.name === name || e.key === name) return e.def;
    for (const e of (m as any).incoming ?? [])
      if (e.name === name || e.key === name) return e.def;
  }
  return { name };
}

function parseTraversalPath(
  path: string,
  builder: any,
  meta: ModelMeta,
  ctx: DelegateContext,
) {
  const index = ctx.index;
  // regex: (->|<-|<->) name (->|<-|<->) name  ... consume edge+target pairs
  const re = /(->|<-|<->)\s*(\w+)\s*(->|<-|<->)\s*(\w+)/g;
  let currentMeta: any = meta;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const arrow1 = m[1];
    const edgeName = m[2];
    const edgeDef = findEdgeDef(index, edgeName, currentMeta);
    const dir = arrow1 === "->" ? "out" : arrow1 === "<-" ? "in" : "both";
    if (dir === "out") builder.out(edgeDef);
    else if (dir === "in") builder.in(edgeDef);
    else builder.both(edgeDef);
    // advance currentMeta to target (m[4])
    const targetName = m[4];
    const tm = (index as any).byName?.get?.(targetName);
    if (tm) currentMeta = tm;
  }
}

function resolveEdgeRuntime(
  meta: ModelMeta,
  edge: any,
  explicit: "out" | "in" | "both",
) {
  // edge is a RelationDef instance; use its name
  const edgeName = edge?.name ?? String(edge);
  const index = (meta as any).__index; // not available; need ctx. We'll resolve lazily in compileGraph instead.
  // We don't have index here; store edgeName and resolve targets later. But targets needed for path.
  // Use edge.endpointDefs? Runtime edge has targets in config.
  const cfg = edge?.config?.relation ?? {};
  let targets: string[] = [];
  if (explicit === "out") targets = [...(cfg.to ?? [])];
  else if (explicit === "in") targets = [...(cfg.from ?? [])];
  else targets = [...new Set([...(cfg.to ?? []), ...(cfg.from ?? [])])];
  return { edgeName, targets };
}

function finishGraph(
  meta: ModelMeta,
  ctx: DelegateContext,
  terminal: any,
): any {
  const state = terminal?._state ?? terminal;
  const index = ctx.index;
  const binds = createBinds();
  const anchor = state.anchor;
  const builderState = {
    anchor,
    steps: state.steps,
    finalWhere: state.finalWhere,
    select: state.select,
    distinct: state.distinct,
    repeat: state.repeat,
  };
  const compiled = compileGraph(
    meta,
    { index },
    anchor,
    builderState as any,
    binds,
    "graph",
  );
  const decode = (rows: readonly unknown[]) => {
    const raw = rows[0];
    const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return decodeRows(arr, compiled.finalMeta, compiled.spec, index);
  };
  const prepared = {
    meta: compiled.finalMeta,
    operation: "graph",
    statements: [
      {
        statement: { sql: compiled.sql, vars: compiled.binds.vars },
        key: "data",
      },
    ],
    where: undefined,
    resultMode: "many" as const,
    explain: false,
    decode,
    context: undefined,
    hookMeta: undefined,
  };
  const runPrepared = async () => {
    const out = await execute(ctx.conn, {
      statements: prepared.statements.map((e: any) => e.statement),
      operation: prepared.operation,
      table: prepared.meta.name,
      debug: ctx.debug,
      logger: ctx.logger,
    });
    return prepared.decode(out.rows);
  };
  const explainPrepared = async () => {
    const out = await execute(ctx.conn, {
      statements: prepared.statements.map((e: any) => ({
        sql: `EXPLAIN ${e.statement.sql}`,
        vars: e.statement.vars,
      })),
      operation: prepared.operation,
      table: prepared.meta.name,
      debug: ctx.debug,
      logger: ctx.logger,
    });
    return {
      driver: "surrealdb" as const,
      operation: prepared.operation,
      statements: prepared.statements.map((e: any, i: number) => ({
        key: e.key,
        surql: e.statement.sql,
        vars: e.statement.vars ?? {},
        plan: out.rows[i],
      })),
      ignoredOptions: [],
    };
  };
  const result = lazyResult(() => runPrepared());
  return attachExplain(result, () => explainPrepared());
}

// imports resolved via require to avoid circular? Use direct imports instead.
function makeNodeProxy(): any {
  const proxy: any = new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (key === "match") {
        return (member: any, fn: (n: any) => any) => {
          const memberName =
            typeof member === "string"
              ? member
              : (member?.name ?? String(member));
          const memberProxy = makeNodeProxy();
          const res = fn(memberProxy);
          if (isExpr(res)) {
            // where predicate: guard AND pred
            const guard = new BoundQuery(
              `record::tb(id) = '${memberName}'`,
              {},
            );
            const guardExpr = toExpr(guard);
            return guardExpr.and(res as any);
          }
          // select value: conditional
          const frag = fragOf(res);
          if (frag) {
            const text = `IF record::tb(id) = '${memberName}' THEN ${frag.query} ELSE NONE END`;
            return new BoundQuery(text, { ...frag.bindings });
          }
          return res;
        };
      }
      return mkRef({ root: { col: key }, kind: "other" });
    },
  });
  return proxy;
}

function convertSelectRuntime(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(convertSelectRuntime);
  if (typeof value === "function") return value;
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const f = fragOf(v);
    out[k] = f !== undefined ? f : convertSelectRuntime(v);
  }
  return out;
}
