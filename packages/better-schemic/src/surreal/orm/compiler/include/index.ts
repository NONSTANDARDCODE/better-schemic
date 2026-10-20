/**
 * The `include` compiler — dispatches relation keys to their lowering:
 * links (`./links`), graph edges (`./edges`) and `_count` (`./count`), producing projection
 * expressions, FETCH paths and the {@link IncludeSpec}s `../decode` hydrates.
 *
 * Every lowering follows the live-verified map (`docs/orm-syntax-map.md` §5): FETCH is the LAST
 * clause and the link must be in the selection; graph targets come from a correlated subquery; the
 * edge filter sits in `->(edge WHERE …)`, the target filter in the subquery's `WHERE` (or
 * `WHERE out.<field>` when the row is the edge); `_count` uses NONE-safe `count(...)`.
 */
import { BetterSchemicError } from "../../errors";
import type { ModelMeta, SchemaIndex } from "../../meta";
import { availableKeys, findEdge } from "../relations";
import type { Binds } from "../shared";
import {
  compileError,
  describeValue,
  isPlainObject,
  isTableMeta,
} from "../shared";
import { compileCount } from "./count";
import { compileGraphEdge } from "./edges";
import { compileLink } from "./links";
import {
  type CompileCtx,
  EMPTY_INCLUDE,
  type IncludeCompiled,
  type IncludeSpec,
} from "./specs";

export type {
  CountIncludeSpec,
  EdgeIncludeSpec,
  EdgeProjection,
  EdgeRecordSpec,
  EdgeRemountSpec,
  EdgeTargetSpec,
  IncludeCompiled,
  IncludeSpec,
  LinkFetchSpec,
  LinkLeafSpec,
  LinkProjectionSpec,
  TargetEntry,
  TargetProjection,
} from "./specs";

/** Compile the `include` arg of a read into projection parts + FETCH + hydration specs. */
export function compileIncludes(args: {
  readonly meta: ModelMeta;
  readonly include: unknown;
  readonly binds: Binds;
  readonly index: SchemaIndex;
  readonly operation: string;
}): IncludeCompiled {
  const { meta, include, binds, index, operation } = args;
  if (include === undefined || include === null) return EMPTY_INCLUDE;
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
    fetch,
    passthrough,
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
      compileLink(key, link, entry, ctx);
      continue;
    }
    const edge = wildcardEdge ? undefined : findEdge(meta, key);
    if (edge || wildcardEdge) {
      compileGraphEdge(meta, key, edge, entry, ctx);
      continue;
    }
    const { links, edges } = availableKeys(meta);
    const known = [...links.filter((field) => field !== "id"), ...edges];
    throw new BetterSchemicError(
      "UnknownField",
      `${operation}: include."${key}" is not a link or edge of "${meta.name}". Known relations: ${known.length ? known.join(", ") : "(none)"} (plus "_count").`,
      { table: meta.name, field: key, operation, details: { known } },
    );
  }

  return { parts, fetch, passthrough, specs, keys };
}
