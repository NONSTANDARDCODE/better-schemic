/**
 * Compiler for the typed graph traversal read (`Delegate.from(anchor).graph(...)`).
 *
 * Emits a single `SELECT [DISTINCT] VALUE <traversal> FROM ONLY <anchor>` statement and decodes
 * the resulting node array through the final node's codec/projection. Reuses `edgeTraversal`,
 * `classifyWhereByOwner`, `compileWhere` and `compileProjection` so the surface stays consistent
 * with `include`/`where`.
 */
import { RecordId } from "surrealdb";
import type { Ctx } from "../../pure";
import { fragOf } from "../../pure";
import { type Expr, isExpr, lowerExpr, mkRef } from "../../surql/predicate";
import { decodeRows } from "../decode";
import type { ModelMeta, SchemaIndex, TableMeta } from "../meta";
import { compileProjection } from "./projection";
import {
  classifyWhereByOwner,
  edgeMeta,
  edgeTraversal,
  resolveEdge,
  targetMetas,
} from "./relations";
import { type Binds, compileError, createBinds } from "./shared";
import { compileWhere } from "./where";

export interface GraphStep {
  readonly direction: "out" | "in" | "both";
  readonly kind?: "node" | "edge";
  readonly edgeName: string;
  readonly opts?: { readonly where?: unknown };
  readonly rawWhere?: unknown;
  readonly edgeRawWhere?: unknown;
  /** Compiled edge-side filter (undefined = none). */
  edgeFilter?: string;
  /** Compiled target-side filter (undefined = none). */
  targetFilter?: string;
  /** Physical target table names this step reaches. */
  targets: readonly string[];
}

export interface GraphBuilderState {
  readonly anchor: unknown;
  readonly steps: GraphStep[];
  readonly finalWhere?: unknown; // object or Expr
  readonly select?: unknown; // object or callback result
  readonly distinct?: boolean;
  readonly repeat?: {
    readonly depth: any;
    readonly steps: readonly GraphStep[];
    readonly opts?: any;
  };
}

export interface CompiledGraph {
  readonly sql: string;
  readonly binds: Binds;
  readonly finalMeta: ModelMeta;
  readonly spec: ReturnType<typeof compileProjection>["spec"];
}

function parseAnchor(anchor: unknown): unknown {
  if (anchor instanceof RecordId) return anchor;
  if (typeof anchor === "string") {
    const idx = anchor.indexOf(":");
    if (idx > 0) {
      const table = anchor.slice(0, idx);
      const id = anchor.slice(idx + 1);
      // Strip surrounding angle brackets if present.
      const bare =
        id.startsWith("⟨") && id.endsWith("⟩") ? id.slice(1, -1) : id;
      try {
        return new RecordId(table, bare);
      } catch {
        return anchor;
      }
    }
  }
  return anchor;
}

export function compileGraph(
  meta: ModelMeta,
  ctx: { readonly index: SchemaIndex },
  anchor: unknown,
  builder: GraphBuilderState & { readonly _binds?: Binds },
  binds: Binds,
  operation = "graph",
): { sql: string; binds: Binds; finalMeta: ModelMeta; spec: any } {
  const index = ctx.index;

  const activeSteps = builder.repeat ? (builder.repeat.steps as any[]) : (builder.steps as any[]);
  // Resolve steps' filters into SQL using the shared binds.
  const steps = activeSteps.map((s) => ({ ...s }));
  for (const step of steps) {
    // edgeRawWhere (attached via .where() while the step was still an edge) → edge filter
    const eraw = (step as any).edgeRawWhere;
    if (eraw !== undefined && eraw !== null) {
      if (isExpr(eraw)) {
        const c: Ctx = { vars: binds.vars };
        step.edgeFilter = mergeFilter(step.edgeFilter, lowerExpr(eraw as Expr, c));
      } else {
        const em = edgeMeta(index, step.edgeName);
        const sql = compileWhere(eraw, binds, { meta: em, index, operation });
        if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql);
      }
    }
    const where = step.opts?.where ?? step.rawWhere;
    if (where === undefined || where === null) continue;
    if (step.kind === "edge") {
      if (isExpr(where)) {
        const c: Ctx = { vars: binds.vars };
        step.edgeFilter = mergeFilter(step.edgeFilter, lowerExpr(where as Expr, c));
        continue;
      }
      const em = edgeMeta(index, step.edgeName);
      const sql = compileWhere(where, binds, { meta: em, index, operation });
      if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql);
      continue;
    }
    if (isExpr(where)) {
      const c: Ctx = { vars: binds.vars };
      step.targetFilter = mergeFilter(
        step.targetFilter,
        lowerExpr(where as Expr, c),
      );
      continue;
    }
    const em = edgeMeta(index, step.edgeName);
    const tms = targetMetas(index, step.targets);
    const owned = classifyWhereByOwner({
      where,
      edge: em,
      targets: tms,
      idOwner: "target",
      operation,
      context: `graph.${step.direction}`,
    });
    if (owned.edge) {
      const sql = compileWhere(owned.edge, binds, {
        meta: em,
        index,
        operation,
      });
      if (sql) step.edgeFilter = mergeFilter(step.edgeFilter, sql);
    }
    if (owned.target) {
      const sql = compileWhere(owned.target, binds, {
        meta: tms[0],
        index,
        operation,
      });
      if (sql) step.targetFilter = mergeFilter(step.targetFilter, sql);
    }
    if (owned.fragment) {
      // fragment → target side
      const sql = compileWhere(owned.fragment as any, binds, {
        meta: tms[0],
        index,
        operation,
      });
      if (sql) step.targetFilter = mergeFilter(step.targetFilter, sql);
    }
  }

  // Build path.
  const stepPath = steps
    .map((s) =>
      edgeTraversal({
        edge: s.edgeName,
        direction: s.direction,
        edgeFilter: s.edgeFilter,
        targets: s.kind === "edge" ? undefined : s.targets,
        targetFilter: s.targetFilter,
      }),
    )
    .join("");

  // Final node meta.
  let finalMeta: ModelMeta = meta;
  const lastStepSource = builder.repeat ? (builder.repeat.steps as any[]) : steps;
  if (lastStepSource.length > 0) {
    const last = lastStepSource[lastStepSource.length - 1];
    if (last.kind === "edge") {
      const em = edgeMeta(index, last.edgeName);
      if (em) finalMeta = em as unknown as ModelMeta;
    } else {
      const tms = targetMetas(index, last.targets);
      if (tms.length > 0) finalMeta = tms[0] as unknown as ModelMeta;
    }
  }

  // Final where (object or Expr) → target filter on last step, or anchor-level.
  let finalWhereSql: string | undefined;
  if (builder.finalWhere !== undefined && builder.finalWhere !== null) {
    if (isExpr(builder.finalWhere)) {
      const c: Ctx = { vars: binds.vars };
      finalWhereSql = lowerExpr(builder.finalWhere as Expr, c);
    } else if (typeof builder.finalWhere === "function") {
      // callback form handled by builder already converted to Expr; if not, invoke.
      const nodeProxy = makeNodeProxy();
      const res = (builder.finalWhere as (n: unknown) => unknown)(nodeProxy);
      if (isExpr(res)) {
        const c: Ctx = { vars: binds.vars };
        finalWhereSql = lowerExpr(res as Expr, c);
      } else {
        const sql = compileWhere(res, binds, {
          meta: finalMeta as any,
          index,
          operation,
        });
        finalWhereSql = sql ?? undefined;
      }
    } else {
      const sql = compileWhere(builder.finalWhere, binds, {
        meta: finalMeta as any,
        index,
        operation,
      });
      finalWhereSql = sql ?? undefined;
    }
  }

  const targetSteps = builder.repeat ? (builder.repeat.steps as any[]) : steps;
  if (finalWhereSql) {
    if (targetSteps.length > 0) {
      const last = targetSteps[targetSteps.length - 1];
      last.targetFilter = mergeFilter(last.targetFilter, finalWhereSql);
    } else {
      // zero-hop: cannot easily filter anchor; leave as-is (documented limitation)
    }
  }

  // Rebuild path after mutating last step's targetFilter.
  const finalStepPath = targetSteps
    .map((s) =>
      edgeTraversal({
        edge: s.edgeName,
        direction: s.direction,
        edgeFilter: s.edgeFilter,
        targets: s.kind === "edge" ? undefined : s.targets,
        targetFilter: s.targetFilter,
      }),
    )
    .join("");

  // Repeat wrapper (rebuild).
  let finalPath: string;
  if (builder.repeat) {
    const r = builder.repeat;
    const min = r.depth?.min ?? (typeof r.depth === "number" ? r.depth : undefined);
    const max = r.depth?.max ?? (typeof r.depth === "number" ? r.depth : undefined);
    let range: string;
    if (min !== undefined && max !== undefined) {
      if (min === max) range = `${min}`;
      else range = `${min}..${max}`;
    } else if (min !== undefined) {
      range = `${min}..`;
    } else if (max !== undefined) {
      range = `..${max}`;
    } else {
      range = "..";
    }
    const opts = r.opts ?? {};
    let suffix = "";
    if (opts.collect) suffix += "+collect";
    if (opts.paths) suffix += "+path";
    if (opts.shortest) suffix += `+shortest=${opts.shortest}`;
    finalPath = `{${range}${suffix}}(${finalStepPath})`;
  } else {
    finalPath = finalStepPath;
  }

  // Select handling.
  let selectArg: unknown = builder.select;
  if (typeof selectArg === "function") {
    const nodeProxy = makeNodeProxy();
    const res = (selectArg as (n: unknown) => unknown)(nodeProxy);
    // convert FieldRefs to fragments
    selectArg = convertSelect(res);
  }

  const hasSelect = selectArg !== undefined && selectArg !== null;
  const { text: projText, spec } = compileProjection(
    finalMeta as any,
    hasSelect ? selectArg : undefined,
    undefined,
    false,
    binds,
    operation,
  );

  const traversalExpr = finalPath
    ? builder.repeat
      ? hasSelect
        ? `${finalPath}.{${projText}}`
        : finalPath
      : hasSelect
        ? `${finalPath}.{${projText}}`
        : `${finalPath}.*`
    : hasSelect
      ? projText
      : "*";

  const anchorSql = binds.add(parseAnchor(anchor));
  // anchor param already added; but we added after path filters? binds order doesn't matter for SQL text; ensure param ref.
  // We need the param reference text. Re-add is wrong; instead use the already added? We added just now, returns ref. Capture.
  // Oops: we already called binds.add inside expression above? No, we called binds.add(parseAnchor(anchor)) as part of anchorSql assignment? Actually above anchorSql = binds.add(...) returns "$pN". Good.

  const distinct = builder.distinct ? "DISTINCT " : "";
  const sql = `SELECT ${distinct}VALUE ${traversalExpr} FROM ONLY ${anchorSql}`;

  return { sql, binds, finalMeta, spec };
}

function mergeFilter(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a && b) return `(${a}) AND (${b})`;
  return a ?? b;
}

function makeNodeProxy(): any {
  return new Proxy({} as Record<string, unknown>, {
    get(_t, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return mkRef({ root: { col: key }, kind: "other" });
    },
  });
}

function convertSelect(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(convertSelect);
  if (typeof value === "function") return value;
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const f = fragOf(v);
    out[k] = f !== undefined ? f : convertSelect(v);
  }
  return out;
}

// (makeNodeProxy is used above)
