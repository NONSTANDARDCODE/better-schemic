/**
 * The `include` compiler — links (`FETCH`/flat remounting), graph edges (per-parent subqueries,
 * `edge`/`target`, wildcards) and `_count`, lowered into projection expressions plus the
 * {@link IncludeSpec}s `../decode` hydrates.
 *
 * Every lowering here follows the live-verified map (`docs/orm-syntax-map.md` §5.1):
 * - links: `FETCH` is the LAST clause and the link must be in the selection; a projected link
 *   flattens (`author.id AS author_id`) and is remounted client-side.
 * - edges: the target records come from a correlated subquery (`SELECT … FROM ->edge->target`);
 *   the edge filter sits in `->(edge WHERE …)`, the target filter in the subquery's `WHERE` (or
 *   `WHERE out.<field>` when the edge itself is projected too — `out.*` + `->(target WHERE)` is a
 *   silent `[{}]`, see the map).
 * - `_count`: correlated `count(->edge…)` / `count(field[WHERE …])` (NONE-safe, unlike `array::len`).
 */
import { escapeIdent } from "surrealdb";
import { BetterSchemicError } from "../errors";
import type { EdgeRef, ModelMeta, SchemaIndex, TableMeta } from "../meta";
import { compileProjection, type ProjectionSpec } from "./projection";
import {
  classifyWhereByOwner,
  type EdgeDirection,
  edgesOf,
  findEdge,
  resolveEdge,
  edgeMeta as resolveEdgeMeta,
  targetMetas,
} from "./relations";
import {
  type Binds,
  compileError,
  describeValue,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  nonNegativeInt,
  paren,
  pathSegments,
  renderPath,
  renderValue,
} from "./shared";
import { compileWhere } from "./where";

// --- specs (consumed by ../decode) ---------------------------------------------------------------

/** A relation hydration entry produced by the include compiler. */
export type IncludeSpec =
  | LinkFetchSpec
  | LinkProjectionSpec
  | EdgeIncludeSpec
  | CountIncludeSpec;

/** `include: { author: true }` / `{ author: { include: … } }` — FETCH materializes the link. */
export interface LinkFetchSpec {
  readonly kind: "link-fetch";
  readonly key: string;
  readonly list: boolean;
  /** Physical target names (empty = a bare `record` — decode by the row's own id table). */
  readonly targets: readonly string[];
  readonly nested: readonly IncludeSpec[];
}

/** `include: { author: { select: … } }` — flat columns remounted into the link object. */
export interface LinkProjectionSpec {
  readonly kind: "link-projection";
  readonly key: string;
  readonly list: boolean;
  readonly targets: readonly string[];
  readonly leaves: readonly LinkLeafSpec[];
}

/** One flat link leaf: `author.id AS author_id` -> `author: { id }`. */
export interface LinkLeafSpec {
  /** Path inside the remounted object (`["address", "city"]`). */
  readonly out: readonly string[];
  /** The flat top-level key in the raw row (`author_address_city`). */
  readonly source: string;
  /** Path in the TARGET shape (brackets preserved) for codec resolution. */
  readonly schemaPath: readonly string[];
}

/** The decoded projection of one target table. */
export interface TargetEntry {
  /** Physical target name (`""` for the wildcard passthrough entry). */
  readonly name: string;
  readonly meta?: TableMeta;
  readonly spec: ProjectionSpec;
}

/** How to decode the target records of an edge include. */
export interface TargetProjection {
  readonly entries: readonly TargetEntry[];
  /** No declared targets (`->?`) — rows pass through undecoded. */
  readonly wildcard: boolean;
}

/** The edge projection of an `edge:` entry. */
export interface EdgeProjection {
  readonly meta?: TableMeta;
  readonly spec: ProjectionSpec;
  readonly wildcard: boolean;
}

/** `include: { likes: … }` — a per-parent traversal subquery. */
export interface EdgeIncludeSpec {
  readonly kind: "edge";
  readonly key: string;
  readonly shape: "target" | "edge" | "edge-target";
  readonly direction: EdgeDirection;
  /** The materialized target key inside an edge+target row (`out`/`in`; `?` for wildcards). */
  readonly alias: "out" | "in" | "?";
  readonly target: TargetProjection;
  readonly edge?: EdgeProjection;
}

/** One `_count` key — `count(->likes) AS _count_likes`. */
export interface CountIncludeSpec {
  readonly kind: "count";
  readonly key: string;
  /** The flat raw key holding the number. */
  readonly source: string;
}

/** The compiled `include` of one read. */
export interface IncludeCompiled {
  /** SQL expressions appended to the projection. */
  readonly parts: readonly string[];
  /** FETCH paths (`FETCH author.profile, editor`) — the clause is emitted last. */
  readonly fetch: readonly string[];
  /** Top-level link fields materialized by FETCH (the base `*` decode must pass them through). */
  readonly passthrough: readonly string[];
  /** Hydration specs. */
  readonly specs: readonly IncludeSpec[];
  /** Top-level keys the include occupies (for conflict checks). */
  readonly keys: readonly string[];
}

const EMPTY: IncludeCompiled = {
  parts: [],
  fetch: [],
  passthrough: [],
  specs: [],
  keys: [],
};

/** Compile the `include` arg of a read into projection parts + FETCH + hydration specs. */
export function compileIncludes(args: {
  readonly meta: ModelMeta;
  readonly include: unknown;
  readonly binds: Binds;
  readonly index: SchemaIndex;
  readonly operation: string;
}): IncludeCompiled {
  const { meta, include, binds, index, operation } = args;
  if (include === undefined || include === null) return EMPTY;
  if (!isPlainObject(include))
    throw compileError(
      "ValidationError",
      `${operation}: include must be an object of relation keys, got ${describeValue(include)}.`,
      { operation },
    );
  if (!isTableMeta(meta))
    throw compileError(
      "ValidationError",
      `${operation}: include needs a typed table — schemaless models have no relation metadata.`,
      { operation },
    );

  const parts: string[] = [];
  const fetch: string[] = [];
  const passthrough: string[] = [];
  const specs: IncludeSpec[] = [];
  const keys: string[] = [];
  const flat = new Set<string>();

  const claim = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  const claimFlat = (key: string) => {
    if (flat.has(key) || meta.columns.has(key))
      throw compileError(
        "ValidationError",
        `${operation}: include alias "${key}" collides with a field of "${meta.name}" — alias/rename the projected link fields.`,
        { table: meta.name, field: key, operation },
      );
    flat.add(key);
  };
  const ctx: CompileCtx = {
    binds,
    index,
    operation,
    parts,
    specs,
    claimFlat,
  };

  for (const [key, entry] of Object.entries(include)) {
    if (entry === undefined || entry === false) continue;
    claim(key);
    if (key === "_count") {
      compileCount(meta, entry, ctx);
      continue;
    }
    const wildcardEdge = isPlainObject(entry) && entry.wildcard === true;
    const link = wildcardEdge ? undefined : meta.links.get(key);
    if (key === "id" && link)
      throw compileError(
        "ValidationError",
        `${operation}: include."id" is the record identity — nothing to fetch; select it instead.`,
        { operation, field: key },
      );
    if (link) {
      compileLink(key, link, entry, ctx, fetch, passthrough);
      continue;
    }
    const edge = wildcardEdge ? undefined : findEdge(meta, key);
    if (edge || wildcardEdge) {
      compileGraphEdge(meta, key, edge, entry, ctx);
      continue;
    }
    const known = [...meta.links.keys()]
      .filter((field) => field !== "id")
      .concat(edgesOf(meta).map((e) => e.name));
    throw new BetterSchemicError(
      "UnknownField",
      `${operation}: include."${key}" is not a link or edge of "${meta.name}". Known relations: ${known.length ? known.join(", ") : "(none)"} (plus "_count").`,
      { table: meta.name, field: key, operation, details: { known } },
    );
  }

  return { parts, fetch, passthrough, specs, keys };
}

// --- links ---------------------------------------------------------------------------------------

interface CompileCtx {
  readonly binds: Binds;
  readonly index: SchemaIndex;
  readonly operation: string;
  readonly parts: string[];
  readonly specs: IncludeSpec[];
  readonly claimFlat: (key: string) => void;
}

/** Compile one link include (`true`, `{ select }`, `{ include }`). */
function compileLink(
  key: string,
  link: {
    readonly targets?: readonly string[];
    readonly cardinality: "one" | "many";
  },
  entry: unknown,
  ctx: CompileCtx,
  fetch: string[],
  passthrough: string[],
): void {
  const { operation } = ctx;
  const list = link.cardinality === "many";
  const targets = link.targets ? [...link.targets] : [];
  const isFetch =
    entry === true ||
    (isPlainObject(entry) &&
      (onlyStar(entry) ||
        (isPlainObject(entry.select) && onlyStar(entry.select))));
  if (isFetch) {
    passthrough.push(key);
    fetch.push(key);
    ctx.specs.push({ kind: "link-fetch", key, list, targets, nested: [] });
    return;
  }
  if (!isPlainObject(entry))
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" must be true, { select } or { include }, got ${describeValue(entry)}.`,
      { operation, field: key },
    );

  const select = entry.select;
  const nested = entry.include;
  const unknownKey = Object.keys(entry).find(
    (k) => k !== "select" && k !== "include",
  );
  if (unknownKey)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" has unknown option "${unknownKey}" — a link include accepts "select" and "include".`,
      { operation, field: key },
    );
  if (select !== undefined && nested !== undefined)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}" cannot combine "select" and "include" — project the link fields OR fetch the nested link.`,
      { operation, field: key },
    );

  if (nested !== undefined) {
    if (targets.length !== 1)
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.include" needs a single target table (got ${targets.length || "any"}) — fetch the union link and query it separately.`,
        { operation, field: key },
      );
    if (!isPlainObject(nested))
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.include" must be an object, got ${describeValue(nested)}.`,
        { operation, field: key },
      );
    const target = ctx.index.byName.get(targets[0] as string);
    if (!target || !isTableMeta(target))
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.include" targets "${targets[0]}", which is not a typed table of this schema.`,
        { operation, field: key },
      );
    const linksOnly: IncludeSpec[] = [];
    for (const [nestedKey, nestedEntry] of Object.entries(nested)) {
      if (nestedEntry === undefined || nestedEntry === false) continue;
      const nestedLink = target.links.get(nestedKey);
      if (!nestedLink)
        throw compileError(
          "ValidationError",
          `${operation}: include."${key}.include"."${nestedKey}" is not a link of "${target.name}" — only link nesting is supported (no edges inside a FETCH).`,
          { operation, field: nestedKey },
        );
      if (
        nestedEntry !== true &&
        !(isPlainObject(nestedEntry) && onlyStar(nestedEntry))
      )
        throw compileError(
          "ClauseNotSupported",
          `${operation}: include."${key}.include"."${nestedKey}" only supports true (a nested projected link would need a second statement — use $raw).`,
          { operation, field: nestedKey },
        );
      fetch.push(`${key}.${nestedKey}`);
      linksOnly.push({
        kind: "link-fetch",
        key: nestedKey,
        list: nestedLink.cardinality === "many",
        targets: nestedLink.targets ? [...nestedLink.targets] : [],
        nested: [],
      });
    }
    passthrough.push(key);
    ctx.specs.push({
      kind: "link-fetch",
      key,
      list,
      targets,
      nested: linksOnly,
    });
    return;
  }

  const { parts, leaves } = compileLinkSelect(key, select, ctx);
  for (const part of parts) {
    ctx.parts.push(part.sql);
    ctx.claimFlat(part.flatKey);
  }
  ctx.specs.push({
    kind: "link-projection",
    key,
    list,
    targets,
    leaves,
  });
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

/** `{ '*': true }` alone — equivalent to `true` (FETCH). */
function onlyStar(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry).filter((k) => entry[k] !== undefined);
  return keys.length === 1 && keys[0] === "*" && entry["*"] === true;
}

/** Compile a projected link (`select`) into flat SQL parts + leaves. */
function compileLinkSelect(
  key: string,
  select: unknown,
  ctx: CompileCtx,
): {
  parts: { sql: string; flatKey: string }[];
  leaves: LinkLeafSpec[];
} {
  const { operation } = ctx;
  if (select === undefined || select === null)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" needs "select" (or pass true to FETCH the whole link).`,
      { operation, field: key },
    );
  const parts: { sql: string; flatKey: string }[] = [];
  const leaves: LinkLeafSpec[] = [];
  const seen = new Set<string>();

  const add = (
    outPath: readonly string[],
    schemaPath: readonly string[],
  ): void => {
    const flatKey = `${key}_${outPath.join("_")}`;
    if (seen.has(flatKey))
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.select" produces "${flatKey}" twice — alias the fields so each leaf is unique.`,
        { operation, field: key },
      );
    seen.add(flatKey);
    parts.push({
      sql: `${renderPath([key, ...schemaPath].join("."))} AS ${escapeIdent(flatKey)}`,
      flatKey,
    });
    leaves.push({ out: outPath, source: flatKey, schemaPath });
  };

  const walk = (
    value: unknown,
    outPrefix: readonly string[],
    pathPrefix: readonly string[],
  ): void => {
    if (value === true) {
      const path = pathPrefix.join(".");
      add([...outPrefix, ...pathSegments(path)], path.split("."));
      return;
    }
    if (typeof value === "string") {
      if (outPrefix.length > 0)
        throw compileError(
          "ValidationError",
          `${operation}: include."${key}.select" aliases are only supported at the top level.`,
          { operation, field: key },
        );
      add([value], value.split("."));
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        if (child === undefined || child === false) continue;
        walk(
          child,
          [...outPrefix, ...pathSegments(childKey)],
          [...pathPrefix, childKey],
        );
      }
      return;
    }
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.select" entries must be true, a path string or a nested object, got ${describeValue(value)}.`,
      { operation, field: key },
    );
  };

  if (Array.isArray(select)) {
    if (select.length === 0)
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.select" is empty — project at least one field.`,
        { operation, field: key },
      );
    for (const field of select) {
      if (typeof field !== "string")
        throw compileError(
          "ValidationError",
          `${operation}: include."${key}.select" array entries must be field names, got ${describeValue(field)}.`,
          { operation, field: key },
        );
      add(pathSegments(field), field.split("."));
    }
  } else if (isPlainObject(select)) {
    const keys = Object.keys(select).filter((k) => select[k] !== undefined);
    if (keys.length === 0)
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.select" is empty — project at least one field.`,
        { operation, field: key },
      );
    for (const childKey of keys) {
      if (childKey === "*")
        throw compileError(
          "ClauseNotSupported",
          `${operation}: include."${key}.select" cannot mix "*" with explicit fields — use true to FETCH the whole link.`,
          { operation, field: key },
        );
      const child = select[childKey];
      if (child === undefined || child === false) continue;
      if (child === true) {
        add(pathSegments(childKey), childKey.split("."));
        continue;
      }
      if (typeof child === "string") {
        add([childKey], child.split("."));
        continue;
      }
      if (isPlainObject(child)) {
        walk(child, pathSegments(childKey), childKey.split("."));
        continue;
      }
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.select"."${childKey}" must be true, a path string or a nested object, got ${describeValue(child)}.`,
        { operation, field: key },
      );
    }
  } else {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.select" must be an array of fields or a projection object, got ${describeValue(select)}.`,
      { operation, field: key },
    );
  }

  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.select" is empty — project at least one field.`,
      { operation, field: key },
    );

  return { parts, leaves };
}

// --- graph edges ---------------------------------------------------------------------------------

/** Compile one edge include (target/edge projections, filters, order/limit, wildcard). */
function compileGraphEdge(
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

  const direction = parseDirection(options.direction, ctx, key);
  const resolved = edgeRef
    ? resolveEdge(meta, key, direction, operation)
    : undefined;
  const arrows =
    (direction ?? resolved?.direction) === "in"
      ? { open: "<-", close: "<-" }
      : (direction ?? resolved?.direction) === "both"
        ? { open: "<->", close: "<->" }
        : { open: "->", close: "->" };
  const alias: "out" | "in" | "?" =
    arrows.open === "<-" ? "in" : arrows.open === "<->" ? "?" : "out";
  const wantsTarget =
    options.target !== undefined || options.select !== undefined;
  if (!edgeRef && arrows.open === "<->" && wantsTarget)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}" cannot project a target with direction "both" — pass direction "out"/"in", or project the edge records (edge: true).`,
      { operation, field: key },
    );
  const edgeMeta = resolved
    ? resolveEdgeMeta(index, resolved.edge.name)
    : undefined;
  const targets = resolved ? targetMetas(index, resolved.targets) : [];

  const hasEdge = options.edge !== undefined && options.edge !== false;
  const targetSelect = unwrapTargetOption(options.target ?? options.select);
  const hasTarget = targetSelect !== undefined;

  if (hasEdge && !hasTarget) {
    compileEdgeOnly(key, options, ctx, { arrows, edgeMeta });
    return;
  }
  if (hasEdge && hasTarget) {
    compileEdgeAndTarget(key, targetSelect, options, ctx, {
      arrows,
      edgeMeta,
      targets,
      alias,
    });
    return;
  }
  compileTargetOnly(key, options, targetSelect, ctx, {
    arrows,
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

/** The traversal refs every edge form shares. */
interface EdgeParts {
  readonly arrows: { readonly open: string; readonly close: string };
  readonly edgeMeta: TableMeta | undefined;
  readonly targets: readonly TableMeta[];
}

/** Edge records alone: `(SELECT <edgeProj> FROM ->edge [WHERE <edgePred>])`. */
function compileEdgeOnly(
  key: string,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  parts: {
    readonly arrows: EdgeParts["arrows"];
    readonly edgeMeta: TableMeta | undefined;
  },
): void {
  const { operation, binds, index } = ctx;
  const projection = compileEdgeProjection(options.edge, parts.edgeMeta, ctx);
  const owned = classifyWhereByOwner({
    where: options.where,
    edge: parts.edgeMeta,
    targets: [],
    idOwner: "edge",
    operation,
    context: `include.${key}`,
  });
  const predicate = owned.edge
    ? compileWhere(owned.edge, binds, {
        meta: parts.edgeMeta,
        index,
        operation,
      })
    : owned.fragment !== undefined
      ? paren(renderValue(owned.fragment, binds, binds.ctx()))
      : undefined;
  const edgeName = parts.edgeMeta ? escapeIdent(parts.edgeMeta.name) : "?";
  const sql = subquery({
    projection: projection.text,
    from: `${parts.arrows.open}${edgeName}`,
    where: predicate,
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      projection.spec,
      ctx,
      key,
      "edge",
    ),
    limit: options.limit,
    start: options.start,
    binds,
    operation,
  });
  ctx.parts.push(`${sql} AS ${escapeIdent(key)}`);
  ctx.specs.push({
    kind: "edge",
    key,
    shape: "edge",
    direction: "out",
    alias: "out",
    target: { entries: [], wildcard: true },
    edge: projection.projection,
  });
}

/** Target records alone: `(SELECT <targetProj> FROM ->edge->target [WHERE <targetPred>])`. */
function compileTargetOnly(
  key: string,
  options: Record<string, unknown>,
  targetSelect: unknown,
  ctx: CompileCtx,
  parts: EdgeParts,
): void {
  const { operation, binds, index } = ctx;
  const target = compileTargetProjection(parts.targets, targetSelect, ctx);
  const owned = classifyWhereByOwner({
    where: options.where,
    edge: parts.edgeMeta,
    targets: parts.targets,
    idOwner: "target",
    operation,
    context: `include.${key}`,
  });
  const edgePredicate = owned.edge
    ? compileWhere(owned.edge, binds, {
        meta: parts.edgeMeta,
        index,
        operation,
      })
    : undefined;
  const targetPredicate = owned.target
    ? compileWhere(owned.target, binds, {
        ...(parts.targets.length === 1 ? { meta: parts.targets[0] } : {}),
        index,
        operation,
      })
    : undefined;
  const fragment = owned.fragment
    ? paren(renderValue(owned.fragment, binds, binds.ctx()))
    : undefined;
  const where = [targetPredicate, fragment].filter(Boolean).join(" AND ");

  const edgeName = parts.edgeMeta ? escapeIdent(parts.edgeMeta.name) : "?";
  const from = parts.edgeMeta
    ? `${parts.arrows.open}${edgePredicate ? `(${edgeName} WHERE ${edgePredicate})` : edgeName}${parts.arrows.close}${targetRef(parts.targets)}`
    : `${parts.arrows.open}${edgeName}`;
  const projection = parts.edgeMeta
    ? target.text
    : wildcardTargetText(
        targetSelect,
        parts.arrows.open === "<-" ? "in" : "out",
      );
  const sql = subquery({
    projection,
    from,
    where: where || undefined,
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      target.projection.entries[0]?.spec,
      ctx,
      key,
      "target",
    ),
    limit: options.limit,
    start: options.start,
    binds,
    operation,
  });
  ctx.parts.push(`${sql} AS ${escapeIdent(key)}`);
  ctx.specs.push({
    kind: "edge",
    key,
    shape: "target",
    direction: directionOf(parts.arrows),
    alias: "out",
    target: target.projection,
  });
}

/** Edge + target: `(SELECT <edge…>, out.* FROM ->edge WHERE out.<targetPred>)` -> `{ edge, target }`. */
function compileEdgeAndTarget(
  key: string,
  targetSelect: unknown,
  options: Record<string, unknown>,
  ctx: CompileCtx,
  parts: EdgeParts & { readonly alias: "out" | "in" | "?" },
): void {
  const { operation, binds, index } = ctx;
  const edgeProjection = compileEdgeProjection(
    options.edge,
    parts.edgeMeta,
    ctx,
  );
  const target = compileTargetProjection(parts.targets, targetSelect, ctx);
  const owned = classifyWhereByOwner({
    where: options.where,
    edge: parts.edgeMeta,
    targets: parts.targets,
    idOwner: "target",
    operation,
    context: `include.${key}`,
  });
  const edgePredicate = owned.edge
    ? compileWhere(owned.edge, binds, {
        meta: parts.edgeMeta,
        index,
        operation,
      })
    : undefined;
  const targetPredicate = owned.target
    ? compileWhere(owned.target, binds, {
        ...(parts.targets.length === 1 ? { meta: parts.targets[0] } : {}),
        index,
        prefix: parts.alias === "?" ? undefined : parts.alias,
        operation,
      })
    : undefined;
  const fragment = owned.fragment
    ? paren(renderValue(owned.fragment, binds, binds.ctx()))
    : undefined;
  const where = [targetPredicate, fragment].filter(Boolean).join(" AND ");

  const edgeName = parts.edgeMeta ? escapeIdent(parts.edgeMeta.name) : "?";
  // The row is the EDGE — `out.*`/`in.*` materializes the target, so the traversal STOPS at the
  // edge (following to the target would make `out` undefined and silently return `{}`).
  const from = `${parts.arrows.open}${edgePredicate ? `(${edgeName} WHERE ${edgePredicate})` : edgeName}`;
  const sql = subquery({
    projection: `${edgeProjection.text}, ${parts.alias}.*`,
    from,
    where: where || undefined,
    orderBy: compileIncludeOrderBy(
      options.orderBy,
      edgeProjection.spec,
      ctx,
      key,
      "edge",
    ),
    limit: options.limit,
    start: options.start,
    binds,
    operation,
  });
  ctx.parts.push(`${sql} AS ${escapeIdent(key)}`);
  ctx.specs.push({
    kind: "edge",
    key,
    shape: "edge-target",
    direction: directionOf(parts.arrows),
    alias: parts.alias,
    target: target.projection,
    edge: edgeProjection.projection,
  });
}

/** The direction an arrow pair encodes. */
function directionOf(arrows: { readonly open: string }): EdgeDirection {
  if (arrows.open === "<-") return "in";
  if (arrows.open === "<->") return "both";
  return "out";
}

/** The projection text of a wildcard target (`out.*` / `out.<path>` — the target is undeclared). */
function wildcardTargetText(rawSelect: unknown, alias: string): string {
  if (rawSelect === undefined || rawSelect === true) return `${alias}.*`;
  if (Array.isArray(rawSelect))
    return rawSelect
      .map((field) => `${alias}.${renderPath(String(field))}`)
      .join(", ");
  if (!isPlainObject(rawSelect))
    throw compileError(
      "ValidationError",
      `a wildcard target projection must be true, { select } or a field list (got ${describeValue(rawSelect)}).`,
    );
  const parts: string[] = [];
  const walk = (
    value: unknown,
    prefix: readonly string[],
    outPrefix: readonly string[],
  ): void => {
    if (value === true) {
      const path = prefix.join(".");
      parts.push(
        `${alias}.${renderPath(path)} AS ${escapeIdent([...outPrefix, ...pathSegments(path)].join("_"))}`,
      );
      return;
    }
    if (typeof value === "string") {
      parts.push(
        `${alias}.${renderPath(value)} AS ${escapeIdent(outPrefix[0] ?? value)}`,
      );
      return;
    }
    if (isPlainObject(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        if (child === undefined || child === false) continue;
        walk(
          child,
          [...prefix, childKey],
          [...outPrefix, ...pathSegments(childKey)],
        );
      }
      return;
    }
    throw compileError(
      "ValidationError",
      `a wildcard target projection entry must be true, a path string or a nested object (got ${describeValue(value)}).`,
    );
  };
  for (const [key, value] of Object.entries(rawSelect)) {
    if (value === undefined || value === false) continue;
    if (key === "*") {
      if (value !== true)
        throw compileError(
          "ValidationError",
          'wildcard target "*" only accepts true.',
        );
      parts.push(`${alias}.*`);
      continue;
    }
    if (value === true) {
      parts.push(
        `${alias}.${renderPath(key)} AS ${escapeIdent(pathSegments(key).join("_"))}`,
      );
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${alias}.${renderPath(value)} AS ${escapeIdent(key)}`);
      continue;
    }
    if (isPlainObject(value)) {
      walk(value, key.split("."), pathSegments(key));
      continue;
    }
    throw compileError(
      "ValidationError",
      `wildcard target projection "${key}" must be true, a path string or a nested object (got ${describeValue(value)}).`,
    );
  }
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      "a wildcard target projection is empty — project at least one field.",
    );
  return parts.join(", ");
}

/** `post` / `(post, user)` / `?` — the target ref of an edge traversal. */
function targetRef(targets: readonly TableMeta[]): string {
  if (targets.length === 0) return "?";
  if (targets.length === 1) return escapeIdent(targets[0]?.name as string);
  return `(${targets.map((t) => escapeIdent(t.name)).join(", ")})`;
}

/** Compile the target projection (`select`/`target`/`true`) + its per-table decode specs. */
function compileTargetProjection(
  targets: readonly TableMeta[],
  rawSelect: unknown,
  ctx: CompileCtx,
): { text: string; projection: TargetProjection } {
  const { binds, operation } = ctx;
  if (
    rawSelect !== undefined &&
    rawSelect !== true &&
    !isPlainObject(rawSelect) &&
    !Array.isArray(rawSelect)
  )
    throw compileError(
      "ValidationError",
      `${operation}: a target projection must be true, { select } or a field list (got ${describeValue(rawSelect)}).`,
      { operation },
    );
  const select = rawSelect === true ? undefined : rawSelect;
  if (targets.length === 0) {
    // Wildcard/undeclared targets — project and pass through.
    const { text, spec } = compileProjection(
      { key: "", name: "", schemaless: true },
      select,
      undefined,
      false,
      binds,
      operation,
    );
    return {
      text,
      projection: { entries: [{ name: "", spec }], wildcard: true },
    };
  }
  const compiled = targets.map((meta) => {
    const { text, spec } = compileProjection(
      meta,
      select,
      undefined,
      false,
      binds,
      operation,
    );
    return { name: meta.name, meta, spec, text };
  });
  const first = compiled[0] as (typeof compiled)[number];
  return {
    text: first.text,
    projection: {
      entries: compiled.map(({ name, meta, spec }) => ({ name, meta, spec })),
      wildcard: false,
    },
  };
}

/** Compile the `edge:` projection (`true` = full edge, `{ select }` = projected). */
function compileEdgeProjection(
  edge: unknown,
  edgeMeta: TableMeta | undefined,
  ctx: CompileCtx,
): { text: string; spec: ProjectionSpec; projection: EdgeProjection } {
  const { binds, operation } = ctx;
  const select = isPlainObject(edge) ? edge.select : undefined;
  if (edgeMeta) {
    const { text, spec } = compileProjection(
      edgeMeta,
      select,
      undefined,
      false,
      binds,
      operation,
    );
    return {
      text,
      spec,
      projection: { meta: edgeMeta, spec, wildcard: false },
    };
  }
  const { text, spec } = compileProjection(
    { key: "", name: "", schemaless: true },
    select,
    undefined,
    false,
    binds,
    operation,
  );
  return { text, spec, projection: { spec, wildcard: true } };
}

/** Assemble a correlated subquery (`SELECT <proj> FROM <from> [WHERE] [ORDER] [LIMIT] [START]`). */
function subquery(args: {
  readonly projection: string;
  readonly from: string;
  readonly where?: string;
  readonly orderBy?: string;
  readonly limit?: unknown;
  readonly start?: unknown;
  readonly binds: Binds;
  readonly operation: string;
}): string {
  const { projection, from, where, orderBy, limit, start, binds, operation } =
    args;
  const parts = [`SELECT ${projection} FROM ${from}`];
  if (where) parts.push(`WHERE ${where}`);
  if (orderBy) parts.push(orderBy);
  if (limit !== undefined)
    parts.push(`LIMIT ${binds.add(nonNegativeInt(limit, "limit", operation))}`);
  if (start !== undefined)
    parts.push(`START ${binds.add(nonNegativeInt(start, "start", operation))}`);
  return paren(parts.join(" "));
}

/** `ORDER BY …` inside an include subquery — the order idiom must be in the projection. */
function compileIncludeOrderBy(
  orderBy: unknown,
  spec: ProjectionSpec | undefined,
  ctx: CompileCtx,
  key: string,
  scope: "edge" | "target",
): string | undefined {
  if (orderBy === undefined) return undefined;
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  const star = spec?.star === true;
  const projected = new Set<string>();
  for (const field of spec?.fields ?? []) {
    projected.add(field.out.join("."));
    projected.add(field.source.join("."));
  }
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry === undefined) continue;
    if (isLowerableValue(entry)) {
      parts.push(renderValue(entry, ctx.binds, ctx.binds.ctx()));
      continue;
    }
    if (!isPlainObject(entry))
      throw compileError(
        "ValidationError",
        `${ctx.operation}: include."${key}.orderBy" entries must be { field: "asc" | "desc" } or a fragment, got ${describeValue(entry)}.`,
        { operation: ctx.operation, field: key },
      );
    for (const [field, dir] of Object.entries(entry)) {
      if (dir === undefined) continue;
      if (
        typeof dir !== "string" ||
        (dir.toUpperCase() !== "ASC" && dir.toUpperCase() !== "DESC")
      )
        throw compileError(
          "ValidationError",
          `${ctx.operation}: include."${key}.orderBy.${field}" must be "asc" or "desc" (got ${describeValue(dir)}).`,
          { operation: ctx.operation, field: key },
        );
      if (!star && !projected.has(field))
        throw compileError(
          "ValidationError",
          `${ctx.operation}: include."${key}.orderBy" field "${field}" is not in the ${scope} projection — SurrealDB requires the order idiom in the selection (project "*" or add the field to "select").`,
          { operation: ctx.operation, field },
        );
      parts.push(`${renderPath(field)} ${dir.toUpperCase()}`);
    }
  }
  if (parts.length === 0) return undefined;
  return `ORDER BY ${parts.join(", ")}`;
}

// --- _count --------------------------------------------------------------------------------------

/** Compile `_count: { select: { <link/edge>: true | { where, direction } } }`. */
function compileCount(meta: TableMeta, entry: unknown, ctx: CompileCtx): void {
  const { operation, binds, index, claimFlat } = ctx;
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
    const source = `_count_${key}`;
    claimFlat(source);
    const link = meta.links.get(key);
    if (link) {
      if (link.cardinality === "one")
        throw compileError(
          "ValidationError",
          `${operation}: _count."${key}" is a single link — counts need an array link or an edge (use where: { ${key}: { is: … } }).`,
          { operation, field: key },
        );
      const targets = targetMetas(index, link.targets);
      const where = isPlainObject(options) ? options.where : undefined;
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
      continue;
    }
    const edge = findEdge(meta, key);
    if (!edge)
      throw new BetterSchemicError(
        "UnknownField",
        `${operation}: _count."${key}" is not a link or edge of "${meta.name}".`,
        { table: meta.name, field: key, operation },
      );
    const direction =
      isPlainObject(options) && options.direction !== undefined
        ? parseDirection(options.direction, ctx, key)
        : undefined;
    const resolved = resolveEdge(meta, key, direction, operation);
    const arrows = {
      open: arrowsFor(resolved.direction).open,
      close: arrowsFor(resolved.direction).close,
    };
    const edgeMeta = resolveEdgeMeta(index, resolved.edge.name);
    const targets = targetMetas(index, resolved.targets);
    const owned = classifyWhereByOwner({
      where: isPlainObject(options) ? options.where : undefined,
      edge: edgeMeta,
      targets,
      idOwner: "target",
      operation,
      context: `_count.${key}`,
    });
    const edgePredicate = owned.edge
      ? compileWhere(owned.edge, binds, { meta: edgeMeta, index, operation })
      : undefined;
    const targetPredicate = owned.target
      ? compileWhere(owned.target, binds, {
          ...(targets.length === 1 ? { meta: targets[0] } : {}),
          index,
          operation,
        })
      : undefined;
    const fragment = owned.fragment
      ? paren(renderValue(owned.fragment, binds, binds.ctx()))
      : undefined;
    const targetWhere = [targetPredicate, fragment]
      .filter(Boolean)
      .join(" AND ");
    const edgeName = escapeIdent(resolved.edge.name);
    const edgeRef = edgePredicate
      ? `(${edgeName} WHERE ${edgePredicate})`
      : edgeName;
    const target = targetWhere
      ? `(${targetRef(targets)} WHERE ${targetWhere})`
      : targetRef(targets);
    ctx.parts.push(
      `count(${arrows.open}${edgeRef}${arrows.close}${target}) AS ${escapeIdent(source)}`,
    );
    ctx.specs.push({ kind: "count", key, source });
  }
}

/** The arrow pair of a direction. */
function arrowsFor(direction: EdgeDirection): {
  readonly open: string;
  readonly close: string;
} {
  if (direction === "in") return { open: "<-", close: "<-" };
  if (direction === "both") return { open: "<->", close: "<->" };
  return { open: "->", close: "->" };
}
