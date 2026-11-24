/**
 * The include projection compiler — ONE walker for every `select` shape the include surface accepts
 * (link projections, wildcard target projections) plus the correlated-subquery assembler and the
 * in-subquery `ORDER BY` validation.
 *
 * `../projection` owns typed projections (codecs per leaf); this module lowers the include-specific
 * forms: flat `<link>_<path>` aliases for links, `out.<path>` for wildcard targets, and the
 * per-target `ProjectionSpec`s the decoder consumes.
 */
import { escapeIdentSafe as escapeIdent } from "../../../ident"
import type { SchemalessMeta, TableMeta } from "../../meta"
import { compileProjection, type ProjectionSpec } from "../projection"
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
} from "../shared"

import type { CompileCtx, EdgeProjection, LinkLeafSpec, TargetProjection } from "./specs"

/** The projection meta of an undeclared/wildcard target (no codec, passes through). */
const SCHEMALESS_TARGET: SchemalessMeta = {
  key: "",
  name: "",
  schemaless: true,
}

/** One selected leaf: how it nests in the remounted object and where it lives in the raw row. */
export type ProjectionLeaf = {
  readonly out: readonly string[]
  readonly source: readonly string[]
}

/** `*` handling + the leaf callback for {@link walkProjection}. */
type WalkOptions = {
  /** Label for teaching messages (`include."author.select"`). */
  readonly label: string
  readonly onLeaf: (leaf: ProjectionLeaf) => void
  readonly star:
    | { readonly error: string; readonly mode: "no" }
    | { readonly mode: "top"; readonly onStar: () => void }
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
    Object.entries(obj).forEach(([key, entry]) => {
      if (entry === undefined || entry === false) return

      if (key === "*") {
        const star = options.star
        if (star.mode === "no") throw compileError("ClauseNotSupported", star.error)

        if (outBase.length > 0) {
          throw compileError(
            "ValidationError",
            `${options.label} only supports "*" at the top level of the projection.`,
          )
        }
        star.onStar()
        return
      }
      const out = [...outBase, ...pathSegments(key)]
      if (entry === true) {
        options.onLeaf({ out, source: [...sourceBase, key] })
        return
      }
      if (typeof entry === "string") {
        options.onLeaf({ out, source: [...sourceBase, ...entry.split(".")] })
        return
      }
      if (isPlainObject(entry)) {
        visit(entry, out, [...sourceBase, key])
        return
      }
      throw compileError(
        "ValidationError",
        `${options.label} entry "${key}" must be true, a path string or a nested object, got ${describeValue(entry)}.`,
      )
    })
  }

  if (Array.isArray(select)) {
    select.forEach((field) => {
      if (typeof field !== "string") {
        throw compileError(
          "ValidationError",
          `${options.label} array entries must be field names, got ${describeValue(field)}.`,
        )
      }
      options.onLeaf({ out: pathSegments(field), source: field.split(".") })
    })
    return
  }
  if (isPlainObject(select)) {
    visit(select, [], [])
    return
  }
  throw compileError(
    "ValidationError",
    `${options.label} must be an array of fields or a projection object, got ${describeValue(select)}.`,
  )
}

/** Is this leaf path the target's `id`? */
function isIdPath(source: readonly string[]): boolean {
  return source.length === 1 && source[0] === "id"
}

/**
 * Compile a projected link (`select`) into flat SQL parts + leaves. A projected non-list link also
 * projects a presence- leaf (`<key>.id`) when `id` isn't selected: it proves the link EXISTS
 * (the decoder returns `null` for an absent link) and picks a union target's codec.
 */
export function compileLinkSelect(
  key: string,
  select: unknown,
  ctx: CompileCtx,
  presence: boolean,
): { leaves: LinkLeafSpec[]; parts: { flatKey: string; sql: string }[] } {
  const { operation } = ctx
  const label = `${operation}: include."${key}.select"`
  if (select === undefined || select === null) {
    throw compileError(
      "ValidationError",
      `${operation}: include."${key}" needs "select" (or pass true to FETCH the whole link).`,
      { field: key, operation },
    )
  }

  const parts: { flatKey: string; sql: string }[] = []
  const leaves: LinkLeafSpec[] = []
  const seen = new Set<string>()
  const add = (out: readonly string[], source: readonly string[]): void => {
    const flatKey = `${key}_${out.join("_")}`
    if (seen.has(flatKey)) {
      throw compileError(
        "ValidationError",
        `${label} produces "${flatKey}" twice — alias the fields so each leaf is unique.`,
        { field: key, operation },
      )
    }
    seen.add(flatKey)
    parts.push({
      flatKey,
      sql: `${renderPath([key, ...source].join("."))} AS ${escapeIdent(flatKey)}`,
    })
    leaves.push({ out, schemaPath: source, source: flatKey })
  }

  walkProjection(select, {
    label,
    onLeaf: ({ out, source }) => {
      add(out, source)
    },
    star: {
      error: `${label} cannot mix "*" with explicit fields — use true to FETCH the whole link.`,
      mode: "no",
    },
  })

  if (parts.length === 0) {
    throw compileError("ValidationError", `${label} is empty — project at least one field.`, {
      field: key,
      operation,
    })
  }

  const presenceKey = `${key}_id`
  if (presence && !seen.has(presenceKey) && !leaves.some((leaf) => isIdPath(leaf.schemaPath))) {
    seen.add(presenceKey)
    parts.push({
      flatKey: presenceKey,
      sql: `${renderPath(`${key}.id`)} AS ${escapeIdent(presenceKey)}`,
    })
    leaves.push({ out: [], schemaPath: ["id"], source: presenceKey })
  }
  return { leaves, parts }
}

/** The projection text of a wildcard target (`out.*` / `out.<path>` — the target undeclars it). */
export function wildcardTargetText(rawSelect: unknown, alias: string, ctx: CompileCtx): string {
  if (rawSelect === undefined || rawSelect === true) return `${alias}.*`

  if (!Array.isArray(rawSelect) && !isPlainObject(rawSelect)) {
    throw compileError(
      "ValidationError",
      `${ctx.operation}: a wildcard target projection must be true, { select } or a field list (got ${describeValue(rawSelect)}).`,
    )
  }
  const parts: string[] = []
  walkProjection(rawSelect, {
    label: `${ctx.operation}: a wildcard target projection`,
    onLeaf: ({ out, source }) => {
      parts.push(`${alias}.${renderPath(source.join("."))} AS ${escapeIdent(out.join("_"))}`)
    },
    star: { mode: "top", onStar: () => parts.push(`${alias}.*`) },
  })
  if (parts.length === 0) {
    throw compileError(
      "ValidationError",
      `${ctx.operation}: a wildcard target projection is empty — project at least one field.`,
    )
  }
  return parts.join(", ")
}

/** Compile the target projection (`select`/`target`/`true`) + its per-table decode specs. */
export function compileTargetProjection(
  targets: readonly TableMeta[],
  rawSelect: unknown,
  ctx: CompileCtx,
): { projection: TargetProjection; text: string } {
  const { binds, operation } = ctx
  if (
    rawSelect !== undefined &&
    rawSelect !== true &&
    !isPlainObject(rawSelect) &&
    !Array.isArray(rawSelect)
  ) {
    throw compileError(
      "ValidationError",
      `${operation}: a target projection must be true, { select } or a field list (got ${describeValue(rawSelect)}).`,
      { operation },
    )
  }
  const select = rawSelect === true ? undefined : rawSelect
  if (targets.length === 0) {
    // Wildcard/undeclared targets — project and pass through.
    const { spec, text } = compileProjection(
      SCHEMALESS_TARGET,
      select,
      undefined,
      false,
      binds,
      operation,
    )
    return {
      projection: { entries: [{ name: "", spec }], wildcard: true },
      text,
    }
  }
  const compiled = targets.map((meta) => {
    const { spec, text } = compileProjection(meta, select, undefined, false, binds, operation)
    return { meta, name: meta.name, spec, text }
  })
  const first = compiled[0]
  return {
    projection: {
      entries: compiled.map(({ meta, name, spec }) => ({ meta, name, spec })),
      wildcard: false,
    },
    text: first.text,
  }
}

/** Compile the `edge:` projection (`true` = full edge, `{ select }` = projected). */
export function compileEdgeProjection(
  edge: unknown,
  edgeMeta: TableMeta | undefined,
  ctx: CompileCtx,
): { projection: EdgeProjection; spec: ProjectionSpec; text: string } {
  const { binds, operation } = ctx
  const select = isPlainObject(edge) ? edge.select : undefined
  const { spec, text } = compileProjection(
    edgeMeta ?? SCHEMALESS_TARGET,
    select,
    undefined,
    false,
    binds,
    operation,
  )
  return {
    projection: edgeMeta ? { meta: edgeMeta, spec, wildcard: false } : { spec, wildcard: true },
    spec,
    text,
  }
}

/** Assemble a correlated subquery (`SELECT <proj> FROM <from> [WHERE] [ORDER] [LIMIT] [START]`). */
export function subquery(args: {
  readonly binds: CompileCtx["binds"]
  readonly from: string
  readonly limit?: unknown
  readonly operation: string
  readonly orderBy?: string
  readonly projection: string
  readonly start?: unknown
  readonly where?: string
}): string {
  const { binds, from, limit, operation, orderBy, projection, start, where } = args
  const parts = [`SELECT ${projection} FROM ${from}`]
  if (where) parts.push(`WHERE ${where}`)

  if (orderBy) parts.push(orderBy)

  if (limit !== undefined)
    parts.push(`LIMIT ${binds.add(nonNegativeInt(limit, "limit", operation))}`)

  if (start !== undefined)
    parts.push(`START ${binds.add(nonNegativeInt(start, "start", operation))}`)

  return paren(parts.join(" "))
}

/** `ORDER BY …` inside an include subquery — the order idiom must be in the projection. */
export function compileIncludeOrderBy(
  orderBy: unknown,
  spec: ProjectionSpec | undefined,
  ctx: CompileCtx,
  key: string,
  scope: "edge" | "target",
): string | undefined {
  if (orderBy === undefined) return undefined

  const entries = Array.isArray(orderBy) ? orderBy : [orderBy]
  const star = spec?.star === true
  const projected = new Set<string>()

  ;(spec?.fields ?? []).forEach((field) => {
    projected.add(field.out.join("."))
    projected.add(field.source.join("."))
  })
  const parts: string[] = []

  entries.forEach((entry) => {
    if (entry === undefined) return

    if (isLowerableValue(entry)) {
      parts.push(renderValue(entry, ctx.binds, ctx.binds.ctx()))
      return
    }
    if (!isPlainObject(entry)) {
      throw compileError(
        "ValidationError",
        `${ctx.operation}: include."${key}.orderBy" entries must be { field: "asc" | "desc" } or a fragment, got ${describeValue(entry)}.`,
        { field: key, operation: ctx.operation },
      )
    }

    Object.entries(entry).forEach(([field, dir]) => {
      if (dir === undefined) return

      if (
        typeof dir !== "string" ||
        (dir.toUpperCase() !== "ASC" && dir.toUpperCase() !== "DESC")
      ) {
        throw compileError(
          "ValidationError",
          `${ctx.operation}: include."${key}.orderBy.${field}" must be "asc" or "desc" (got ${describeValue(dir)}).`,
          { field: key, operation: ctx.operation },
        )
      }
      if (!star && !projected.has(field)) {
        throw compileError(
          "ValidationError",
          `${ctx.operation}: include."${key}.orderBy" field "${field}" is not in the ${scope} projection — SurrealDB requires the order idiom in the selection (project "*" or add the field to "select").`,
          { field, operation: ctx.operation },
        )
      }
      parts.push(`${renderPath(field)} ${dir.toUpperCase()}`)
    })
  })
  if (parts.length === 0) return undefined

  return `ORDER BY ${parts.join(", ")}`
}
