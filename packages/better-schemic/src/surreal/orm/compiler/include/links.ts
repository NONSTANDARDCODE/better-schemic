/**
 * The LINK branch of the include compiler: `true`/`{ "*": true }` -> FETCH, a projection -> flat
 * columns remounted client-side (`author.id AS author_id`), `{ include }` -> a nested FETCH path.
 */
import { compileError, describeValue, isPlainObject, isTableMeta } from "../shared"

import { compileLinkSelect } from "./projection"
import type { CompileCtx, IncludeSpec } from "./specs"

/** `{ '*': true }` alone — to `true` (FETCH). */
function onlyStar(entry: Record<string, unknown>): boolean {
  const keys = Object.keys(entry).filter((k) => entry[k] !== undefined)
  return keys.length === 1 && keys[0] === "*" && entry["*"] === true
}

/** Compile one link include (`true`, `{ select }`, `{ include }`). */
export function compileLink(
  key: string,
  link: {
    readonly cardinality: "many" | "one"
    readonly targets?: readonly string[]
  },
  entry: unknown,
  ctx: CompileCtx,
): void {
  const { operation } = ctx
  const list = link.cardinality === "many"
  const targets = link.targets ? [...link.targets] : []
  const isFetch =
    entry === true ||
    (isPlainObject(entry) &&
      (onlyStar(entry) || (isPlainObject(entry.select) && onlyStar(entry.select))))
  if (isFetch) {
    ctx.passthrough.push(key)
    ctx.fetch.push(key)
    ctx.specs.push({ key, kind: "link-fetch", list, nested: [], targets })
    return
  }
  if (!isPlainObject(entry)) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" must be true, { select } or { include }, got ${describeValue(entry)}.`,
      { field: key, operation },
    )
  }

  const select = entry.select
  const nested = entry.include
  const unknownKey = Object.keys(entry).find((k) => k !== "select" && k !== "include")
  if (unknownKey) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" has unknown option "${unknownKey}" — a link include accepts "select" and "include".`,
      { field: key, operation },
    )
  }
  if (select !== undefined && nested !== undefined) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: include."${key}" cannot combine "select" and "include" — project the link fields OR fetch the nested link.`,
      { field: key, operation },
    )
  }

  if (nested !== undefined) {
    compileNestedLink(key, { list, targets }, nested, ctx)
    return
  }

  const { leaves, parts } = compileLinkSelect(key, select, ctx, !list)
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const part of parts) {
    ctx.parts.push(part.sql)
    ctx.claimFlat(part.flatKey)
  }
  ctx.specs.push({
    key,
    kind: "link-projection",
    leaves,
    list,
    targets,
  })
}

/** `include: { author: { include: { profile: true } } }` — a nested FETCH path. */
function compileNestedLink(
  key: string,
  link: { readonly list: boolean; readonly targets: readonly string[] },
  nested: unknown,
  ctx: CompileCtx,
): void {
  const { index, operation } = ctx
  if (link.targets.length !== 1) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" needs a single target table (got ${link.targets.length > 0 ? link.targets.length : "any"}) — fetch the union link and query it separately.`,
      { field: key, operation },
    )
  }
  if (!isPlainObject(nested)) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" must be an object, got ${describeValue(nested)}.`,
      { field: key, operation },
    )
  }
  const target = index.byName.get(link.targets[0])
  if (!target || !isTableMeta(target)) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" targets "${link.targets[0]}", which is not a typed table of this schema.`,
      { field: key, operation },
    )
  }
  const linksOnly: IncludeSpec[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [nestedKey, nestedEntry] of Object.entries(nested)) {
    if (nestedEntry === undefined || nestedEntry === false) continue

    const nestedLink = target.links.get(nestedKey)
    if (!nestedLink) {
      throw compileError(
        "ValidationError",
        `${operation}: include."${key}.include"."${nestedKey}" is not a link of "${target.name}" — only link nesting is supported (no edges inside a FETCH).`,
        { field: nestedKey, operation },
      )
    }
    if (nestedEntry !== true && !(isPlainObject(nestedEntry) && onlyStar(nestedEntry))) {
      throw compileError(
        "ClauseNotSupported",
        `${operation}: include."${key}.include"."${nestedKey}" only supports true (a nested projected link would need a second statement — use $raw).`,
        { field: nestedKey, operation },
      )
    }
    ctx.fetch.push(`${key}.${nestedKey}`)
    linksOnly.push({
      key: nestedKey,
      kind: "link-fetch",
      list: nestedLink.cardinality === "many",
      nested: [],
      targets: nestedLink.targets ? [...nestedLink.targets] : [],
    })
  }
  if (linksOnly.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}.include" is empty — pass at least one nested link (or use include."${key}": true).`,
      { field: key, operation },
    )
  }
  ctx.passthrough.push(key)
  ctx.specs.push({
    key,
    kind: "link-fetch",
    list: link.list,
    nested: linksOnly,
    targets: [...link.targets],
  })
}
