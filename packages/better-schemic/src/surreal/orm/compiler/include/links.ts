/**
 * The LINK branch of the include compiler: `true`/`{ "*": true }` -> FETCH, a projection -> flat
 * columns remounted client-side (`author.id AS author_id`), `{ include }` -> a nested FETCH path.
 */
import {
  compileError,
  describeValue,
  isPlainObject,
  isTableMeta,
} from "../shared";
import { compileLinkSelect } from "./projection";
import type { CompileCtx, IncludeSpec } from "./specs";

/** `{ '*': true }` alone — equivalent to `true` (FETCH). */
function onlyStar(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry).filter((k) => entry[k] !== undefined);
  return keys.length === 1 && keys[0] === "*" && entry["*"] === true;
}

/** Compile one link include (`true`, `{ select }`, `{ include }`). */
export function compileLink(
  key: string,
  link: {
    readonly targets?: readonly string[];
    readonly cardinality: "one" | "many";
  },
  entry: unknown,
  ctx: CompileCtx,
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
    ctx.passthrough.push(key);
    ctx.fetch.push(key);
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
    compileNestedLink(key, { list, targets }, nested, ctx);
    return;
  }

  const { parts, leaves } = compileLinkSelect(key, select, ctx, !list);
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

/** `include: { author: { include: { profile: true } } }` — a nested FETCH path. */
function compileNestedLink(
  key: string,
  link: { readonly list: boolean; readonly targets: readonly string[] },
  nested: unknown,
  ctx: CompileCtx,
): void {
  const { operation, index } = ctx;
  if (link.targets.length !== 1)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" needs a single target table (got ${link.targets.length || "any"}) — fetch the union link and query it separately.`,
      { operation, field: key },
    );
  if (!isPlainObject(nested))
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" must be an object, got ${describeValue(nested)}.`,
      { operation, field: key },
    );
  const target = index.byName.get(link.targets[0] as string);
  if (!target || !isTableMeta(target))
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" targets "${link.targets[0]}", which is not a typed table of this schema.`,
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
    ctx.fetch.push(`${key}.${nestedKey}`);
    linksOnly.push({
      kind: "link-fetch",
      key: nestedKey,
      list: nestedLink.cardinality === "many",
      targets: nestedLink.targets ? [...nestedLink.targets] : [],
      nested: [],
    });
  }
  if (linksOnly.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" is empty — pass at least one nested link (or use include."${key}": true).`,
      { operation, field: key },
    );
  ctx.passthrough.push(key);
  ctx.specs.push({
    kind: "link-fetch",
    key,
    list: link.list,
    targets: [...link.targets],
    nested: linksOnly,
  });
}
