/**
 * The read-clause compiler — `orderBy`/`limit`/`start`/`range`/`split`/`groupBy`/`groupAll`/`with`/
 * `timeout`/`version` -> one `SELECT` statement, with the projection coming from
 * `./projection` (SQL text + decode spec in one pass).
 *
 * Clause ORDER is not cosmetic: it's live-verified (`docs/orm-syntax-map.md` §3) that `WITH` sits
 * before `WHERE`, `SPLIT` after it, `VERSION` before `TIMEOUT`, and that parenthesized expressions
 * are a parse error in `ORDER BY`. The compiler emits the one accepted order.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident"
import type { ModelMeta, SchemaIndex } from "../meta"

import { compileIncludes } from "./include"
import {
  compileProjection,
  omittedPaths,
  projectedInPlace,
  type ProjectionAlias,
  projectionForm,
  type ProjectionSpec,
} from "./projection"
import {
  type Binds,
  compileError,
  compileWithClause,
  datetimeLiteral,
  describeValue,
  durationLiteral,
  isPlainObject,
  isTableMeta,
  nonNegativeInt,
  pathList,
  pathSegments,
  rangeTarget,
  rejectRemovedArgs,
  renderBareFragment,
  renderPath,
} from "./shared"
import { compileWhere, mergeScope } from "./where"

/** Index placeholder for include-free reads (compileIncludes ignores it when `include` is absent). */
const EMPTY_INDEX: SchemaIndex = {
  byName: new Map(),
  functions: new Map(),
  schemaless: new Map(),
  tables: new Map(),
}

/** The compiled form of one read. */
export type CompiledRead = {
  /** FETCH paths from `include` (emitted as the LAST clause). */
  readonly fetch: readonly string[]
  /** `FROM ` — the result is a single object (or a miss). */
  readonly only: boolean
  readonly projection: ProjectionSpec
  readonly sql: string
}

/** The runtime read args the compiler validates (types live in `../types/select`). */
export type ReadArgs = {
  /** Return the `EXPLAIN` plan instead of executing. */
  explain?: unknown
  groupAll?: unknown
  groupBy?: unknown
  /** Relation hydration (links/edges/`_count`) — M3. */
  include?: unknown
  limit?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  only?: unknown
  orderBy?: unknown
  /** Removed/renamed args — rejected with a teaching error. */
  parallel?: unknown
  range?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the compiled `where`. */
  scope?: unknown
  select?: unknown
  skip?: unknown
  split?: unknown
  start?: unknown
  take?: unknown
  timeout?: unknown
  value?: unknown
  version?: unknown
  where?: unknown
  with?: unknown
}

/** Compiler overrides for the operations that wrap a read (findUnique targets a record). */
export type CompileReadOptions = {
  /** Aliases the read appends to the projection (keyset cursor columns; decoded as leaves). */
  readonly aliases?: readonly ProjectionAlias[]
  /** The schema index — required to resolve `include` relations. */
  readonly index?: SchemaIndex
  /** Replace the `FROM` target (e.g. `user:aeon`). */
  readonly target?: string
}

/** Compile a read into its statement + decode spec (binds accumulate into `binds`). */
export function compileRead(
  meta: ModelMeta,
  args: ReadArgs,
  binds: Binds,
  operation = "findMany",
  options: CompileReadOptions = {},
): CompiledRead {
  rejectRemovedArgs(args, operation)

  const only = args.only === true
  const value = args.value === true
  const splitPath = typeof args.split === "string" ? pathSegments(args.split) : undefined

  if (args.include !== undefined) {
    if (value) {
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "include" and "value" are mutually exclusive — a VALUE projection has no row to hydrate.`,
        { operation },
      )
    }
    if (args.split !== undefined || args.groupBy !== undefined || args.groupAll !== undefined) {
      throw compileError(
        "ClauseNotSupported",
        `${operation}: "include" cannot be combined with split/groupBy/groupAll — hydrate after the grouped query.`,
        { operation },
      )
    }
  }
  if (args.include !== undefined && !options.index) {
    throw compileError(
      "ValidationError",
      `${operation}: include needs the schema index (internal).`,
      { operation },
    )
  }
  const compiled = compileIncludes({
    binds,
    include: args.include,
    index: options.index ?? EMPTY_INDEX,
    meta,
    operation,
  })

  const selection = selectedTopLevelKeys(args.select)
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const key of compiled.keys) {
    if (!selection.keys.has(key)) continue

    const includeSpec = compiled.specs.find((entry) => entry.key === key)
    if (includeSpec?.kind !== "link-fetch") {
      throw compileError(
        "ValidationError",
        `${operation}: "${key}" is both explicitly selected and included — drop one (include."${key}" remounts it).`,
        { field: key, operation },
      )
    }
  }

  const extraParts = [...compiled.parts]
  if (!selection.star) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const link of compiled.passthrough)
      if (!selection.keys.has(link)) extraParts.unshift(renderPath(link))
  }

  // SPLIT is an idiom the SERVER requires in the selection ("Missing split idiom … in statement
  // selection" — live-verified: rejecting `SELECT name FROM t SPLIT products` even though the rows
  // are right). An ALIAS satisfies it (live-verified, including on a nested split path), so a read
  // that splits a field it did not select gets a reserved `_split_<n>` column the decoder drops —
  // `findMany({ select: { name: "products[*].product.name" }, split: "products" })` then works
  // without the caller hand-projecting `products` into every `select`.
  const splitAlias = splitIdiomAlias(meta, args, splitPath, options.aliases, operation)

  const { spec: baseSpec, text: projectionText } = compileProjection(
    meta,
    args.select,
    args.omit,
    value,
    binds,
    operation,
    splitPath,
    {
      aliases: [
        ...(options.aliases ?? []),
        ...(splitAlias ? [{ alias: splitAlias, path: args.split as string }] : []),
      ],
      parts: extraParts,
      passthrough: compiled.passthrough,
    },
  )
  const spec: ProjectionSpec = {
    ...baseSpec,
    ...(splitAlias ? { hidden: [splitAlias] } : {}),
    includes: compiled.specs,
  }

  const groupBy = pathList(args.groupBy, "groupBy")
  const groupAll = args.groupAll === true
  if (args.split !== undefined && (groupBy.length > 0 || groupAll)) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: SPLIT and GROUP BY/ALL are mutually exclusive in SurrealQL — group the unsplit rows, or split in a second query.`,
      { operation },
    )
  }
  if (groupBy.length > 0 && groupAll) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: pass "groupBy" OR "groupAll", not both.`,
      { operation },
    )
  }
  if ((groupBy.length > 0 || groupAll) && args.select === undefined && !value) {
    throw compileError(
      "ValidationError",
      `${operation}: GROUP BY/ALL needs an explicit "select" (or "value") — a grouped row has no full-table shape. Use aggregate() for counts/sums.`,
      { operation },
    )
  }

  const parts: string[] = [
    `SELECT ${value ? "VALUE " : ""}${projectionText}`,
    `FROM ${options.target ?? compileTarget(meta, args.range, only, operation)}`,
  ]

  if (args.with !== undefined) parts.push(compileWithClause(args.with, operation))

  const where = compileWhere(mergeScope(args.where, args.scope), binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    ...(options.index ? { index: options.index } : {}),
    operation,
  })
  if (where) parts.push(`WHERE ${where}`)

  if (args.split !== undefined) parts.push(`SPLIT ${compileSplit(args.split, binds, operation)}`)

  if (groupAll) parts.push("GROUP ALL")
  else if (groupBy.length > 0)
    parts.push(`GROUP BY ${groupBy.map((path) => renderPath(path)).join(", ")}`)

  if (args.orderBy !== undefined) parts.push(compileOrderBy(args.orderBy, binds, operation))

  if (args.limit !== undefined)
    parts.push(`LIMIT ${binds.add(nonNegativeInt(args.limit, "limit", operation))}`)

  if (args.start !== undefined)
    parts.push(`START ${binds.add(nonNegativeInt(args.start, "start", operation))}`)

  if (args.version !== undefined) parts.push(`VERSION ${datetimeLiteral(args.version, operation)}`)

  if (args.timeout !== undefined) parts.push(`TIMEOUT ${durationLiteral(args.timeout, operation)}`)

  if (compiled.fetch.length > 0) parts.push(`FETCH ${compiled.fetch.map(renderPath).join(", ")}`)

  return {
    fetch: compiled.fetch,
    only,
    projection: spec,
    sql: parts.join(" "),
  }
}

/** The top-level output keys an explicit `select` covers (`star` = no projection). */
function selectedTopLevelKeys(select: unknown): {
  readonly keys: ReadonlySet<string>
  readonly star: boolean
} {
  if (select === undefined || select === null) return { keys: new Set(), star: true }

  if (Array.isArray(select)) {
    const keys = new Set<string>()
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const key of select) if (typeof key === "string") keys.add(pathSegments(key)[0])

    return { keys, star: false }
  }
  if (isPlainObject(select)) {
    const keys = new Set<string>()
    let star = false
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const key of Object.keys(select)) {
      if (select[key] === undefined || select[key] === false) continue

      if (key === "*") {
        star = true
        continue
      }
      keys.add(pathSegments(key)[0])
    }
    return { keys, star }
  }
  return { keys: new Set(), star: false }
}

// --- target / clauses ----------------------------------------------------------------------------

/** `FROM <table>` / `FROM <table>` / `FROM <table>:<start>..<end>`. */
function compileTarget(meta: ModelMeta, range: unknown, only: boolean, operation: string): string {
  const table = escapeIdent(meta.name)
  if (range === undefined) return only ? `ONLY ${table}` : table

  if (only) {
    throw compileError(
      "ClauseNotSupported",
      `${operation}: "only" and "range" are mutually exclusive — a range can yield many records.`,
      { operation },
    )
  }
  return rangeTarget(meta, range, operation)
}

/** `SPLIT field` / `SPLIT <fragment>`. */
function compileSplit(split: unknown, binds: Binds, operation: string): string {
  if (typeof split === "string") return renderPath(split)

  const bare = renderBareFragment(split, binds)
  if (bare !== undefined) return bare

  throw compileError(
    "ValidationError",
    `${operation}: split must be a field path or a fragment, got ${describeValue(split)}.`,
    { operation },
  )
}

/** `ORDER BY a ASC, b DESC` (fragments splice bare — parens are a parse error there). */
export function compileOrderBy(orderBy: unknown, binds: Binds, operation: string): string {
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy]
  if (entries.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: orderBy is empty — pass at least one field or expression.`,
      { operation },
    )
  }
  const parts: string[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const entry of entries) {
    if (entry === undefined) continue

    const bare = renderBareFragment(entry, binds)
    if (bare !== undefined) {
      parts.push(bare)
      continue
    }
    if (!isPlainObject(entry)) {
      throw compileError(
        "ValidationError",
        `${operation}: orderBy entries must be { field: "asc" | "desc" } or a fragment, got ${describeValue(entry)}.`,
        { operation },
      )
    }
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const [key, direction] of Object.entries(entry)) {
      if (direction === undefined) continue

      if (typeof direction === "string") {
        const upper = direction.toUpperCase()
        // eslint-disable-next-line max-depth -- parser/compilador com despacho aninhado; achatar mudaria a precedência das cláusulas
        if (upper !== "ASC" && upper !== "DESC") {
          throw compileError(
            "ValidationError",
            `${operation}: orderBy direction must be "asc" or "desc", got "${direction}".`,
            { operation },
          )
        }
        parts.push(`${renderPath(key)} ${upper}`)
        continue
      }
      const expr = renderBareFragment(direction, binds)
      if (expr !== undefined) {
        parts.push(expr)
        continue
      }
      throw compileError(
        "ValidationError",
        `${operation}: orderBy entry "${key}" must be "asc" | "desc" or a fragment (got ${describeValue(direction)}).`,
        { operation },
      )
    }
  }
  if (parts.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: orderBy is empty — pass at least one field or expression.`,
      { operation },
    )
  }
  return `ORDER BY ${parts.join(", ")}`
}

// --- literals & small helpers --------------------------------------------------------------------

// --- split idiom ---------------------------------------------------------------------------------

/** The reserved prefix for the column that satisfies the server's `SPLIT` idiom. */
const SPLIT_ALIAS_PREFIX = "_split_"

/**
 * The reserved alias a read must append so the server accepts its `SPLIT` clause.
 *
 * SurrealDB rejects `SELECT name FROM t SPLIT products` with `Missing split idiom "products" in
 * statement selection` — the split field must appear in the selection, even though the split row is
 * already the element. Live-verified on 3.3.4: projecting it under an ALIAS (`products AS
 * _split_products`) satisfies the idiom  as well, so the compiler appends that column and the
 * decoder drops it — the caller's `select` never has to hand-project the split field.
 *
 * `undefined` when nothing must appends it: no split, a split that IS already returned in place, a
 * fragment split (the server can't require an idiom for an expression) or a name collision (a real
 * field nams it `_split_products` — the caller's own column wins, and the server will say so if it
 * is not enough).
 */
function splitIdiomAlias(
  meta: ModelMeta,
  args: ReadArgs,
  splitPath: readonly string[] | undefined,
  aliases: readonly ProjectionAlias[] | undefined,
  _operation: string,
): string | undefined {
  if (splitPath === undefined) return undefined

  const split = args.split as string
  // A `*` (with nothing omitted over the split path) or an explicit entry already returns it.
  const form = projectionForm(args.select)
  if (form && projectedInPlace(form, omittedPaths(args.omit), split)) return undefined

  const alias = `${SPLIT_ALIAS_PREFIX}${splitPath[0]}`
  // Reserved name already spoken for — by a caller-supplied column (the cursor keyset aliases) or by
  // a REAL field that happens to nams it like the reservation. Injecting a second copy would either
  // duplicate a column or shadow a field the caller owns.
  if ((aliases ?? []).some((entry) => entry.alias === alias)) return undefined

  if (isTableMeta(meta)) {
    const shape = (meta.def.object as { shape?: Record<string, unknown> }).shape
    if (alias in (shape ?? {})) return undefined
  }
  return alias
}
