/**
 * The LIVE SELECT compiler — `LIVE SELECT [DIFF] <projeção> FROM <tabela> [WHERE …] [FETCH …]`.
 *
 * The typed `where` reuses the read lowering (`compileWhere`) so binds/fragments behave exactly like
 * a read; `fetch` reuses the `include` link-fetch lowering (`compileIncludes`) so the projection
 * carries the hydration spec and a fetched link decodes through the TARGET codec.
 *
 * Live-probed constraints (`docs/orm-syntax-map.md` §7): `DIFF` sits right after `SELECT` and takes
 * NO projection; `FROM ONLY`/record targets are errors; `ORDER BY`/`LIMIT`/`GROUP`/`SPLIT` do not
 * exist in a LIVE SELECT; a record leaving the `WHERE` filter emits nothing.
 */
import { escapeIdent } from "surrealdb";
import type { ModelMeta, SchemaIndex } from "../meta";
import { compileIncludes, type IncludeCompiled } from "./include";
import { compileProjection, type ProjectionSpec } from "./projection";
import {
  type Binds,
  compileError,
  describeValue,
  isPlainObject,
  isTableMeta,
  pathList,
  renderPath,
} from "./shared";
import { compileWhere } from "./where";

/** The compiled live statement + its decode spec. */
export interface CompiledLive {
  readonly sql: string;
  readonly projection: ProjectionSpec;
  readonly diff: boolean;
}

const LIVE_KEYS = new Set(["where", "select", "diff", "fetch", "meta"]);

/** Compile `LIVE SELECT [DIFF] <projeção> FROM <tabela> [WHERE …] [FETCH …]`. */
export function compileLive(
  meta: ModelMeta,
  args: unknown,
  binds: Binds,
  operation = "live",
  options: { readonly index?: SchemaIndex } = {},
): CompiledLive {
  if (args !== undefined && !isPlainObject(args))
    throw compileError(
      "ValidationError",
      `${operation}: args must be an object with where/select/diff/fetch (got ${describeValue(args)}).`,
      { operation, table: meta.name },
    );
  const spec = (args ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(spec))
    if (!LIVE_KEYS.has(key))
      throw compileError(
        "ClauseNotSupportedInLive",
        `${operation}: "${key}" is not supported in a live query — live accepts where, select, diff, fetch, meta (ORDER BY/LIMIT/GROUP/SPLIT/include have no meaning in LIVE SELECT).`,
        { operation, table: meta.name },
      );
  const diff = spec.diff === true;
  if (spec.diff !== undefined && typeof spec.diff !== "boolean")
    throw compileError(
      "ValidationError",
      `${operation}: "diff" must be a boolean (got ${describeValue(spec.diff)}).`,
      { operation, table: meta.name },
    );
  if (diff && spec.select !== undefined)
    throw compileError(
      "ClauseNotSupportedInLive",
      `${operation}: "diff" and "select" cannot combine — \`LIVE SELECT DIFF\` takes no projection (docs/orm-syntax-map.md §7).`,
      { operation, table: meta.name },
    );

  // `fetch` rides the SAME link-fetch lowering as a read `include` (projection + hydration spec).
  const fetchList = pathList(spec.fetch, "fetch", operation);
  let fetched: IncludeCompiled | undefined;
  if (fetchList.length > 0) {
    if (!options.index)
      throw compileError(
        "ValidationError",
        `${operation}: fetch needs the schema index (internal).`,
        { operation, table: meta.name },
      );
    fetched = compileIncludes({
      meta,
      include: Object.fromEntries(fetchList.map((field) => [field, true])),
      binds,
      index: options.index,
      operation,
    });
  }
  const { text, spec: baseSpec } = compileProjection(
    meta,
    spec.select,
    undefined,
    false,
    binds,
    operation,
    undefined,
    { parts: fetched?.parts ?? [], passthrough: fetched?.passthrough ?? [] },
  );
  const projection: ProjectionSpec = {
    ...baseSpec,
    includes: fetched?.specs ?? [],
  };
  const parts = [
    `LIVE SELECT ${diff ? "DIFF" : text}`,
    `FROM ${escapeIdent(meta.name)}`,
  ];
  const where = compileWhere(spec.where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    ...(options.index ? { index: options.index } : {}),
    operation,
  });
  if (where) parts.push(`WHERE ${where}`);
  if (fetched && fetched.fetch.length > 0)
    parts.push(`FETCH ${fetched.fetch.map(renderPath).join(", ")}`);

  return { sql: parts.join(" "), projection, diff };
}
