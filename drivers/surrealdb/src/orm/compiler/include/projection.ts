/**
 * The include projection compiler — ONE walker for every `select` shape the include surface accepts
 * (link projections, wildcard target projections) plus the correlated-subquery assembler and the
 * in-subquery `ORDER BY` validation.
 *
 * `../projection` owns typed projections (codecs per leaf); this module lowers the include-specific
 * forms: flat `<link>_<path>` aliases for links, `out.<path>` for wildcard targets, and the
 * per-target `ProjectionSpec`s the decoder consumes.
 */
import { escapeIdent } from "surrealdb";
import type { SchemalessMeta, TableMeta } from "../../meta";
import { compileProjection, type ProjectionSpec } from "../projection";
import {
  compileError,
  describeValue,
  isLowerableValue,
  isPlainObject,
  nonNegativeInt,
  paren,
  pathSegments,
  renderPath,
  renderValue,
} from "../shared";
import type {
  CompileCtx,
  EdgeProjection,
  LinkLeafSpec,
  TargetProjection,
} from "./specs";

/** The projection meta of an undeclared/wildcard target (no codec, passes through). */
const SCHEMALESS_TARGET: SchemalessMeta = {
  key: "",
  name: "",
  schemaless: true,
};

/** One selected leaf: how it nests in the remounted object and where it lives in the raw row. */
export interface ProjectionLeaf {
  readonly out: readonly string[];
  readonly source: readonly string[];
}

/** `*` handling + the leaf callback for {@link walkProjection}. */
interface WalkOptions {
  /** Label for teaching messages (`include."author.select"`). */
  readonly label: string;
  readonly onLeaf: (leaf: ProjectionLeaf) => void;
  readonly star:
    | { readonly mode: "no"; readonly error: string }
    | { readonly mode: "top"; readonly onStar: () => void };
}

/**
 * Walk a `select` (array of fields, or a projection object of `true`/alias/nested entries) into
 * flat leaves. Link projections and wildcard target projections share this recursion, so nested
 * selects nest the same way everywhere.
 */
function walkProjection(select: unknown, options: WalkOptions): void {
  const visit = (
    obj: Record<string, unknown>,
    outBase: readonly string[],
    sourceBase: readonly string[],
  ): void => {
    for (const [key, entry] of Object.entries(obj)) {
      if (entry === undefined || entry === false) continue;
      if (key === "*") {
        const star = options.star;
        if (star.mode === "no")
          throw compileError("ClauseNotSupported", star.error);
        if (outBase.length > 0)
          throw compileError(
            "ValidationError",
            `${options.label} only supports "*" at the top level of the projection.`,
          );
        star.onStar();
        continue;
      }
      const out = [...outBase, ...pathSegments(key)];
      if (entry === true) {
        options.onLeaf({ out, source: [...sourceBase, key] });
        continue;
      }
      if (typeof entry === "string") {
        options.onLeaf({ out, source: [...sourceBase, ...entry.split(".")] });
        continue;
      }
      if (isPlainObject(entry)) {
        visit(entry, out, [...sourceBase, key]);
        continue;
      }
      throw compileError(
        "ValidationError",
        `${options.label} entry "${key}" must be true, a path string or a nested object, got ${describeValue(entry)}.`,
      );
    }
  };

  if (Array.isArray(select)) {
    for (const field of select) {
      if (typeof field !== "string")
        throw compileError(
          "ValidationError",
          `${options.label} array entries must be field names, got ${describeValue(field)}.`,
        );
      options.onLeaf({ out: pathSegments(field), source: field.split(".") });
    }
    return;
  }
  if (isPlainObject(select)) {
    visit(select, [], []);
    return;
  }
  throw compileError(
    "ValidationError",
    `${options.label} must be an array of fields or a projection object, got ${describeValue(select)}.`,
  );
}

/** Is this leaf path exactly the target's `id`? */
function isIdPath(source: readonly string[]): boolean {
  return source.length === 1 && source[0] === "id";
}

/**
 * Compile a projected link (`select`) into flat SQL parts + leaves. A projected non-list link also
 * projects a presence-only leaf (`<key>.id`) when `id` isn't selected: it proves the link EXISTS
 * (the decoder returns `null` for an absent link) and picks a union target's codec.
 */
export function compileLinkSelect(
  key: string,
  select: unknown,
  ctx: CompileCtx,
  presence: boolean,
): { parts: { sql: string; flatKey: string }[]; leaves: LinkLeafSpec[] } {
  const { operation } = ctx;
  const label = `${operation}: include."${key}.select"`;
  if (select === undefined || select === null)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" needs "select" (or pass true to FETCH the whole link).`,
      { operation, field: key },
    );

  const parts: { sql: string; flatKey: string }[] = [];
  const leaves: LinkLeafSpec[] = [];
  const seen = new Set<string>();
  const add = (out: readonly string[], source: readonly string[]): void => {
    const flatKey = `${key}_${out.join("_")}`;
    if (seen.has(flatKey))
      throw compileError(
        "ValidationError",
        `${label} produces "${flatKey}" twice — alias the fields so each leaf is unique.`,
        { operation, field: key },
      );
    seen.add(flatKey);
    parts.push({
      sql: `${renderPath([key, ...source].join("."))} AS ${escapeIdent(flatKey)}`,
      flatKey,
    });
    leaves.push({ out, source: flatKey, schemaPath: source });
  };

  walkProjection(select, {
    label,
    onLeaf: ({ out, source }) => add(out, source),
    star: {
      mode: "no",
      error: `${label} cannot mix "*" with explicit fields — use true to FETCH the whole link.`,
    },
  });

  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${label} is empty — project at least one field.`,
      { operation, field: key },
    );

  const presenceKey = `${key}_id`;
  if (
    presence &&
    !seen.has(presenceKey) &&
    !leaves.some((leaf) => isIdPath(leaf.schemaPath))
  ) {
    seen.add(presenceKey);
    parts.push({
      sql: `${renderPath(`${key}.id`)} AS ${escapeIdent(presenceKey)}`,
      flatKey: presenceKey,
    });
    leaves.push({ out: [], source: presenceKey, schemaPath: ["id"] });
  }
  return { parts, leaves };
}

/** The projection text of a wildcard target (`out.*` / `out.<path>` — the target is undeclared). */
export function wildcardTargetText(
  rawSelect: unknown,
  alias: string,
  ctx: CompileCtx,
): string {
  if (rawSelect === undefined || rawSelect === true) return `${alias}.*`;
  if (!Array.isArray(rawSelect) && !isPlainObject(rawSelect))
    throw compileError(
      "ValidationError",
      `${ctx.operation}: a wildcard target projection must be true, { select } or a field list (got ${describeValue(rawSelect)}).`,
    );
  const parts: string[] = [];
  walkProjection(rawSelect, {
    label: `${ctx.operation}: a wildcard target projection`,
    onLeaf: ({ out, source }) => {
      parts.push(
        `${alias}.${renderPath(source.join("."))} AS ${escapeIdent(out.join("_"))}`,
      );
    },
    star: { mode: "top", onStar: () => parts.push(`${alias}.*`) },
  });
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `${ctx.operation}: a wildcard target projection is empty — project at least one field.`,
    );
  return parts.join(", ");
}

/** Compile the target projection (`select`/`target`/`true`) + its per-table decode specs. */
export function compileTargetProjection(
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
      SCHEMALESS_TARGET,
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
export function compileEdgeProjection(
  edge: unknown,
  edgeMeta: TableMeta | undefined,
  ctx: CompileCtx,
): { text: string; spec: ProjectionSpec; projection: EdgeProjection } {
  const { binds, operation } = ctx;
  const select = isPlainObject(edge) ? edge.select : undefined;
  const { text, spec } = compileProjection(
    edgeMeta ?? SCHEMALESS_TARGET,
    select,
    undefined,
    false,
    binds,
    operation,
  );
  return {
    text,
    spec,
    projection: edgeMeta
      ? { meta: edgeMeta, spec, wildcard: false }
      : { spec, wildcard: true },
  };
}

/** Assemble a correlated subquery (`SELECT <proj> FROM <from> [WHERE] [ORDER] [LIMIT] [START]`). */
export function subquery(args: {
  readonly projection: string;
  readonly from: string;
  readonly where?: string;
  readonly orderBy?: string;
  readonly limit?: unknown;
  readonly start?: unknown;
  readonly binds: CompileCtx["binds"];
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
export function compileIncludeOrderBy(
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
