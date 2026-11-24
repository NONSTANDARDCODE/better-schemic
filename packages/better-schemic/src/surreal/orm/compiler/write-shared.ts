/**
 * Shared lowering primitives for the write compiler — `WritePlan`/modes, the runtime arg shapes
 * and the helpers every write domain (`./write`, `./mutate`, `./relate`) builds on:
 * codec-validated `data` with expression splice, record targets/ids, RETURN mapping, update
 * modes, patch/unset validation and the small arg guards. One place per rule, like `./shared`.
 */
import { BoundQuery, RecordId, toSurqlString } from "surrealdb"

import { escapeIdentSafe as escapeIdent, unescapeIdPart } from "../../ident"
import { hasRefDeep, type IdStrategy } from "../../pure"
import { adjustmentOf } from "../arithmetic"
import { normalizeError } from "../errors"
import type { ModelMeta, ResolvedIdStrategy, SchemaIndex } from "../meta"

import { extractArithmetic, setBody as buildSetBody } from "./adjustment"
import { compileProjection, type ProjectionSpec } from "./projection"
import {
  type Binds,
  coerceRecordId,
  compileError,
  describeValue,
  durationLiteral,
  escapeRecordIdPart,
  isPlainObject,
  isTableMeta,
  recordIdParts,
  renderPath,
  renderValue,
  splitRecordId,
} from "./shared"
import { uniqueTarget } from "./unique"
import { compileWhere, mergeScope, scopeWhere } from "./where"

/** The modes a write can rewrite a record with (SurrealQL verbs). */
export type WriteMode = "content" | "merge" | "patch" | "replace" | "set"
/** What a write hands back. */
export type WriteRet = "after" | "before" | "diff" | "none"

/** A compiled write: the statements to run and how to read their rows. */
export type WritePlan = {
  /** The row may be absent (`.throw()` attaches `NotFoundInfo`) — singular update/patch/delete. */
  readonly mayMiss?: boolean
  /** A miss is an ERROR, not a null: the decode raises `ResultNotFound` — `upsert` with
   *  `onMissing: "throw"` (the default) or a create-mode `return: "after"` that produced no row. */
  readonly missError?: boolean
  /** `row` = one record; `some` = a row list; `none` = no payload; `diff` = the raw JSON Patch;
   *  `delta` = the `{ before, after }` envelope `upsertDelta` decodes. */
  readonly result: "delta" | "diff" | "many" | "none" | "row"
  /**
   * The statements whose rows carry the answer. Absent = every statement contributes rows
   * (batch ops); singular ops point at the one statement holding the row/state.
   */
  readonly resultIndexes?: readonly number[]
  /** A compiled `select`/`omit` decode spec (writes always return whole records otherwise). */
  readonly select?: ProjectionSpec
  /**
   * How {@link select} applies: `server` (the statement's RETURN clause already carries the
   * projection) or `client` (rows come back whole and project them after decoding — the
   * before-state, `delete`, `upsertDelta` and OMIT paths; `updateEach`'s select used to be the
   *  client projector).
   */
  readonly selectMode?: "client" | "server"
  /** The user statements, in order (control statements are the executor's job). */
  readonly statements: readonly string[]
  /** The miss came from a STRICT update lowering (`UPDATE t:id` / `UPDATE … WHERE uniq`),
   *  never from a create branch filtered by a permission/plugin scope. The decode picks the
   *  teaching message from THIS, not from `args.onMissing` (a target-less create has no explicit
   *  `onMissing: "throw"` even though the arg is absent and the default is `"throw"`). */
  readonly strictMiss?: boolean
  /** Wrap in `BEGIN/COMMIT` (batch atomicity) — the executor skips it inside a transaction. */
  readonly transactional: boolean
}
// --- runtime arg shapes (types live in `../types/write`) -----------------------------------------

export type CreateRuntimeArgs = {
  data?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  only?: unknown
  relate?: unknown
  return?: unknown
  select?: unknown
}

export type CreateManyRuntimeArgs = {
  data?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  return?: unknown
  select?: unknown
  skipDuplicates?: unknown
}

export type InsertRuntimeArgs = {
  data?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  onDuplicate?: unknown
  return?: unknown
  select?: unknown
}

export type UpdateRuntimeArgs = {
  data?: unknown
  meta?: Record<string, unknown>
  mode?: unknown
  omit?: unknown
  only?: unknown
  patches?: unknown
  return?: unknown
  /** Plugin scope (see `Operation.scope`) — AND-combined into the WHERE, never a unique target. */
  scope?: unknown
  select?: unknown
  timeout?: unknown
  unset?: unknown
  where?: unknown
}

export type UpdateManyRuntimeArgs = {
  data?: unknown
  meta?: Record<string, unknown>
  mode?: unknown
  omit?: unknown
  patches?: unknown
  return?: unknown
  scope?: unknown
  select?: unknown
  timeout?: unknown
  unset?: unknown
  where?: unknown
}

export type UpsertRuntimeArgs = {
  create?: unknown
  data?: unknown
  meta?: Record<string, unknown>
  mode?: unknown
  omit?: unknown
  only?: unknown
  onMissing?: unknown
  return?: unknown
  scope?: unknown
  select?: unknown
  timeout?: unknown
  update?: unknown
  where?: unknown
}

export type UpsertDeltaRuntimeArgs = {
  create?: unknown
  data?: unknown
  meta?: Record<string, unknown>
  mode?: unknown
  omit?: unknown
  onMissing?: unknown
  scope?: unknown
  select?: unknown
  timeout?: unknown
  update?: unknown
  where?: unknown
}

export type UpsertManyRuntimeArgs = {
  conflict?: unknown
  data?: unknown
  meta?: Record<string, unknown>
  omit?: unknown
  return?: unknown
  scope?: unknown
  select?: unknown
  update?: unknown
}

export type DeleteRuntimeArgs = {
  meta?: Record<string, unknown>
  omit?: unknown
  return?: unknown
  scope?: unknown
  select?: unknown
  timeout?: unknown
  where?: unknown
}

export type DeleteManyRuntimeArgs = {
  all?: unknown
  meta?: Record<string, unknown>
  return?: unknown
  scope?: unknown
  timeout?: unknown
  where?: unknown
}

export type UpdateEachRuntimeArgs = {
  by?: unknown
  data?: unknown
  meta?: Record<string, unknown>
  mode?: unknown
  omit?: unknown
  onEmpty?: unknown
  patches?: unknown
  return?: unknown
  scope?: unknown
  select?: unknown
  timeout?: unknown
}
// --- shared helpers ------------------------------------------------------------------------------

/** Check + encode a `data` payload; fields with expressions bypass the codec (server-enforced). */
export function encodeData(
  meta: ModelMeta,
  data: unknown,
  kind: "create" | "update",
  operation: string,
): unknown {
  if (data === undefined) {
    throw compileError("ValidationError", `${operation}: data is required.`, {
      operation,
      table: meta.name,
    })
  }
  if (!isPlainObject(data)) {
    throw compileError(
      "ValidationError",
      `${operation}: data must be a plain object (got ${describeValue(data)}). Use a surql fragment inside a field for expressions.`,
      { operation, table: meta.name },
    )
  }
  // BACKSTOP: adjustments extract them (and lowered) BEFORE encoding on every update path; any
  // payload that still carries one here is a create-shaped write (create/insert/relate/ON
  // DUPLICATE map), which has no previous value to adjust.
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [key, value] of Object.entries(data)) {
    const marker = adjustmentOf(value)
    if (marker) {
      throw compileError(
        "ValidationError",
        `${operation}: "${key}" uses { ${marker.kind}: … } — an adjustment needs an EXISTING value, so it can't be written by a create/insert/relate or an ON DUPLICATE map. Use update/updateMany/updateEach (or pass a plain value here).`,
        { field: key, operation, table: meta.name },
      )
    }
  }
  if (!isTableMeta(meta)) return data

  const normalized: Record<string, unknown> = { ...data }
  if (normalized.id !== undefined && !(normalized.id instanceof RecordId))
    normalized.id = toRecordId(meta, normalized.id, operation)

  const literals: Record<string, unknown> = {}
  const expressions: Record<string, unknown> = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue

    if (hasRefDeep(value)) expressions[key] = value
    else literals[key] = value
  }
  let encoded: Record<string, unknown> = {}
  if (Object.keys(literals).length > 0) {
    const result =
      kind === "create" ? meta.def.safeEncode(literals) : meta.def.safeEncodePartial(literals)
    if (!result.success) {
      throw normalizeError(result.error, {
        details: result.error,
        operation,
        table: meta.name,
      })
    }
    encoded = result.data
  }
  return { ...encoded, ...expressions }
}

/** Render an encoded payload as a statement operand (whole-bind when pure, splice when expressions). */
export function payload(value: unknown, binds: Binds): string {
  return renderValue(value, binds, binds.ctx())
}

/** `t:<id>` with the id part escaped and the table validated (`user:aeon` / bare ids accepted). */
export function recordTarget(meta: ModelMeta, id: unknown, operation: string): string {
  const parts = recordIdParts(id, operation, {
    fallbackTable: meta.name,
    table: meta.name,
  })
  return `${escapeIdent(meta.name)}:${escapeRecordIdPart(parts.id)}`
}

/** The RAW bare id text (`users:⟨a b⟩` -> `a b`) for comparing two record ids. */
export function recordIdText(id: unknown): string {
  return unescapeIdPart(splitRecordId(id)?.id ?? String(id))
}

// --- generated ids (per-table `idStrategy`) ------------------------------------------------------

/** The server expression that generates a record id for a strategy. */
const ID_FN: Record<IdStrategy, string> = {
  rand: "rand::id()",
  ulid: "rand::ulid()",
  uuid: "rand::uuid()",
}

/** The ORM create-id strategy of a model: typed tables carry the resolved strategy; schemaless
 *  entries can't declare one and ride the uniform `"ulid"` default. */
export function idStrategyOf(meta: ModelMeta): ResolvedIdStrategy {
  return isTableMeta(meta) ? meta.idStrategy : "ulid"
}

/** How (or whether) the ORM generates a create id for a model. */
type IdGeneration =
  /** No injection needed: the plain target already yields the server default (`rand`), or the id
   *  fixs it (a singleton). */
  | { readonly fn: string; readonly kind: "target" }
  /** `type::record(<table>, <fn>)` for CREATE/UPSERT targets, `<fn>` as the INSERT `id` field. */
  | { readonly kind: "explicit" }
  /** The declared id field's codec can't producs it by any strategy (uuid v4/v6) — creating
   *  without an explicit id is a compile error, never a doomed server write. */
  | { readonly kind: "server" }

/** Resolve the ONE generation decision every create path shares. */
function idGenerationOf(meta: ModelMeta): IdGeneration {
  if (isTableMeta(meta) && meta.singletonId !== undefined) return { kind: "server" }

  const strategy = idStrategyOf(meta)
  if (strategy === "rand") return { kind: "server" }

  if (strategy === "none") return { kind: "explicit" }

  return { fn: ID_FN[strategy], kind: "target" }
}

/** The teaching error for a create that needs a generated id on an explicit-table. */
function explicitIdError(meta: ModelMeta): ReturnType<typeof compileError> {
  return compileError(
    "ValidationError",
    `cannot generate an id for table "${meta.name}": its declared id field uses a format no ORM strategy produces (uuid v4/v6) — pass an explicit "id", or change the id field.`,
    { table: meta.name },
  )
}

/** The explicit `id` of a payload, or a singleton delegate's fixed id. */
export function createId(meta: ModelMeta, data: unknown): unknown {
  if (isPlainObject(data) && data.id !== undefined) return data.id

  const singleton = isTableMeta(meta) ? meta.singletonId : undefined
  if (singleton !== undefined) return `${meta.name}:${singleton}`

  return undefined
}

/**
 * The `type::record(<table>, <fn>())` create target that generates an id server-side — or
 * `undefined` when the plain target already does the job (the server default for `rand`, or a
 * singleton's fixed id). An explicit- table (uuid v4/v6 id field) THROWS: there is no id the
 * ORM can generate.
 *
 * The table name renders it with `toSurqlString` (`s"user"`): an ESCAPED identifier
 * (`escapeIdent` -> `⟨weird-name⟩`) is double-escaped inside `type::record`, live-probed on 3.2.
 */
export function generatedTarget(meta: ModelMeta): string | undefined {
  const generation = idGenerationOf(meta)
  if (generation.kind === "explicit") throw explicitIdError(meta)

  if (generation.kind === "server") return undefined

  return `type::record(${toSurqlString(meta.name)}, ${generation.fn})`
}

/** `t:id` / `t:id` / `type::record(t, fn())` / `t` target for CREATE. An explicit payload
 *  `id` (or a singleton's fixed id) always wins over the table's strategy. */
export function createTarget(
  meta: ModelMeta,
  data: unknown,
  only: boolean,
  operation: string,
): string {
  const id = createId(meta, data)
  const prefix = only ? "ONLY " : ""
  if (id !== undefined) return `${prefix}${recordTarget(meta, id, operation)}`

  const generated = generatedTarget(meta)
  if (generated !== undefined) return `${prefix}${generated}`

  return `${prefix}${escapeIdent(meta.name)}`
}

/**
 * Add the generated `id` expression field to an INSERT payload (`{ …, id: rand::ulid() }`) when the
 * model's strategy isn't the server default and the payload has no explicit id. The object renders
 * as a SurrealQL literal with per-field binds (object spread + expression is a parse error on 3.2).
 */
export function withGeneratedId(meta: ModelMeta, encoded: unknown): unknown {
  if (!isPlainObject(encoded) || encoded.id !== undefined) return encoded

  const generation = idGenerationOf(meta)
  if (generation.kind === "explicit") throw explicitIdError(meta)

  if (generation.kind === "server") return encoded

  return { ...encoded, id: new BoundQuery(generation.fn) }
}

/** Coerce an `id` payload to the SDK `RecordId` the codec expects (bare ids use the delegate's table). */
function toRecordId(meta: ModelMeta, value: unknown, operation: string): RecordId {
  return coerceRecordId(value, operation, {
    fallbackTable: meta.name,
    field: "id",
    table: meta.name,
    what: "id",
  })
}

/** Coerce a record-link value to the SDK `RecordId`; a bare id needs a SINGLE target table. */
export function toRecord(value: unknown, operation: string, targets?: readonly string[]): RecordId {
  const single = targets?.length === 1 ? targets[0] : undefined
  return coerceRecordId(value, operation, {
    ...(single === undefined ? {} : { fallbackTable: single, table: single }),
    what: "record link",
  })
}

/** The singular write target (id or single-field UNIQUE) + its optional WHERE. */
export function singleTarget(
  meta: ModelMeta,
  args: UpdateRuntimeArgs,
  binds: Binds,
  operation: string,
  index?: SchemaIndex,
): { target: string; where: string } {
  const target = uniqueTarget(meta, args.where, operation)
  if (target.kind === "id") {
    return {
      target: `${args.only === true ? "ONLY " : ""}${recordTarget(meta, target.id, operation)}`,
      where: scopeWhere(args.scope, binds, meta, index),
    }
  }
  return {
    target: `${args.only === true ? "ONLY " : ""}${escapeIdent(meta.name)}`,
    where: whereSql(mergeScope(args.where, args.scope), binds, meta, index),
  }
}

/** ` WHERE <predicate>` (empty string when there is no filter). */
export function whereSql(
  where: unknown,
  binds: Binds,
  meta: ModelMeta,
  index?: SchemaIndex,
): string {
  const predicate = compileWhere(where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    ...(index ? { index } : {}),
  })
  return predicate ? ` WHERE ${predicate}` : ""
}

/** Check a `return` arg against the op's allowed modes (defaults when absent). */
export function readReturn(
  value: unknown,
  operation: string,
  allowed: readonly WriteRet[],
  fallback: WriteRet,
): WriteRet {
  if (value === undefined) return fallback

  if (typeof value !== "string" || !allowed.includes(value as WriteRet)) {
    throw compileError(
      "ReturnNotSupported",
      `${operation}: return must be ${allowed.map((entry) => `"${entry}"`).join(" | ")} (got ${describeValue(value)}).`,
      { operation },
    )
  }
  return value as WriteRet
}

/** ` RETURN AFTER|BEFORE|DIFF|NONE` + ` TIMEOUT …` (AFTER is the server default — omitted). When
 *  `projText` gives it (a server-side `select`), the default AFTER form replaces it by the
 *  projection itself: ` RETURN name, balance` / ` RETURN *, author.id AS author_id`. */
export function mutationTail(
  ret: WriteRet,
  timeout: unknown,
  operation: string,
  projText?: string,
): string {
  let returnClause: string
  if (ret === "after") returnClause = projText === undefined ? "" : ` RETURN ${projText}`
  else returnClause = ` RETURN ${ret.toUpperCase()}`
  const timeoutClause =
    timeout === undefined ? "" : ` TIMEOUT ${durationLiteral(timeout, operation)}`
  return `${returnClause}${timeoutClause}`
}

/** The `upsertDelta` envelope: `before`/`after` come from the statement's own state (one snapshot). */
export const DELTA_ENVELOPE = " RETURN VALUE { before: $before, after: $after }"

/** The delta envelope + ` TIMEOUT …` (RETURN must precede TIMEOUT — live-probed 3.2). */
export function deltaTail(timeout: unknown, operation: string): string {
  const timeoutClause =
    timeout === undefined ? "" : ` TIMEOUT ${durationLiteral(timeout, operation)}`
  return `${DELTA_ENVELOPE}${timeoutClause}`
}

// --- write projections (`select`/`omit` on the returned rows) ------------------------------------

/** A compiled write projection: the server text + the decode spec + where it can apply. */
export type CompiledWriteProjection = {
  /** The RETURN clause can carry it (no OMIT — `RETURN … OMIT` is a parse error, live-probed). */
  readonly server: boolean
  readonly spec: ProjectionSpec
  /** The projection list (`name, address.city`, `*`, an expression alias) for `RETURN <text>`. */
  readonly text: string
}

/** Compile `select`/`omit` for a write — `undefined` when neither passs it (zero overhead). */
export function compileWriteProjection(
  meta: ModelMeta,
  args: { omit?: unknown; select?: unknown },
  binds: Binds,
  operation: string,
): CompiledWriteProjection | undefined {
  if (args.select === undefined && args.omit === undefined) return undefined

  const { spec, text } = compileProjection(meta, args.select, args.omit, false, binds, operation)
  // `select: { "*": true }` / `omit: []` project nothing — skip the clause (and the client decode).
  if (spec.star && spec.omit.length === 0 && spec.fields.length === 0) return undefined

  return { server: spec.omit.length === 0, spec, text }
}

/** A resolved write projection: how it applies + the compiled pieces. */
export type ProjectionPlan = {
  readonly mode: "client" | "server"
  readonly proj: CompiledWriteProjection
}

/**
 * Resolve how a projection applies (and check it): `server` when the RETURN clause can carry it
 * (AFTER state, no OMIT), `client` when the rows must come back whole and projects it on the
 * decoded app rows (BEFORE state, `delete`, `upsertDelta`, OMIT and the `create.relate` sugar).
 * A client-side projection can't compute expressions — those reject them with a teaching error.
 * `undefined` = no projection, or a state that returns no rows (`none`/`diff`).
 */
export function selectMode(
  proj: CompiledWriteProjection | undefined,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
  options: { readonly clientOnly?: boolean } = {},
): ProjectionPlan | undefined {
  if (!proj || ret === "none" || ret === "diff") return undefined

  if (options.clientOnly === true || !proj.server || ret === "before") {
    if (proj.spec.fields.some((field) => field.computed === true)) {
      throw compileError(
        "ReturnNotSupported",
        `${operation}: a projection with an expression entry can't shape the ${
          ret === "before" ? "BEFORE state" : "rows this lowering returns"
        } client-side — use return: "after" with plain paths/aliases, or drop the expression.`,
        { operation, table: meta.name },
      )
    }
    return { mode: "client", proj }
  }
  return { mode: "server", proj }
}

/** Reject a `select`/`omit` on a `RETURN DIFF` lowering (a patch list has no fields to project). */
export function assertProjectable(
  proj: CompiledWriteProjection | undefined,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
): void {
  if (!proj || ret !== "diff") return

  throw compileError(
    "ReturnNotSupported",
    `${operation}: RETURN DIFF returns a JSON Patch list, not rows — drop select/omit, or use return: "after"/"before".`,
    { operation, table: meta.name },
  )
}

/** Flatten a nested plain object into `a.b.c = $p` assignments; empty objects contribute none
 *  (a deep `MERGE` of `{ a: {} }` is a no-op). */
export function flattenAssignments(
  value: unknown,
  path: readonly string[],
  out: string[],
  binds: Binds,
): void {
  if (isPlainObject(value)) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const [key, child] of Object.entries(value))
      flattenAssignments(child, [...path, key], out, binds)

    return
  }
  out.push(
    `${path.map((segment) => renderPath(segment)).join(".")} = ${renderValue(value, binds, binds.ctx())}`,
  )
}

/**
 * The `data` clause of an update-shaped write, change-aware:
 * - no adjustments → the plain mode body (`MERGE $p` / `SET …` / `CONTENT $p` / …);
 * - adjustments → a `SET` clause combining the clean fields with `f ±= $p` steps (merge flattens
 *   nested objects to leaves — a `SET f = $p` would replace them, where `MERGE` deep-merges).
 * `content`/`replace` reject adjustments (they rewrite the whole record, so there is no
 * "existing value" contract to add to).
 */
export function updateBody(
  meta: ModelMeta,
  mode: WriteMode,
  data: unknown,
  binds: Binds,
  operation: string,
): string {
  const { clean, steps } = extractArithmetic(meta, data, operation, true)
  if (steps.length === 0) {
    return encodedBody(
      mode,
      encodeData(
        meta,
        clean,
        mode === "content" || mode === "replace" ? "create" : "update",
        operation,
      ),
      binds,
    )
  }
  if (mode !== "merge" && mode !== "set") {
    throw compileError(
      "ValidationError",
      `${operation}: { increment/decrement: … } needs an EXISTING value — mode "${mode}" rewrites the whole record. Use the default merge (or mode: "set").`,
      { operation, table: meta.name },
    )
  }
  return buildSetBody(encodeData(meta, clean, "update", operation), steps, binds, mode === "merge")
}

/** Map a `return` + cardinality to the plan's result interpretation. */
export function resultOf(ret: WriteRet, cardinality: "many" | "row"): WritePlan["result"] {
  if (ret === "none") return "none"

  if (ret === "diff") return "diff"

  return cardinality
}

/** Check an update `mode`. */
export function updateMode(value: unknown, operation: string, fallback: WriteMode): WriteMode {
  if (value === undefined) return fallback

  if (
    typeof value !== "string" ||
    !["content", "merge", "patch", "replace", "set"].includes(value)
  ) {
    throw compileError(
      "ValidationError",
      `${operation}: mode must be "merge" | "set" | "content" | "replace" | "patch" (got ${describeValue(value)}).`,
      { operation },
    )
  }
  return value as WriteMode
}

/** The clause a mutation mode emits, from an ALREADY-ENCODED payload (`./write` encodes once). */
export function encodedBody(mode: WriteMode, encoded: unknown, binds: Binds): string {
  switch (mode) {
    case "merge":
      return `MERGE ${payload(encoded, binds)}`
    case "content":
      return `CONTENT ${payload(encoded, binds)}`
    case "replace":
      return `REPLACE ${payload(encoded, binds)}`
    case "set":
      return `SET ${setAssignments(encoded, binds)}`
    case "patch":
      return `PATCH ${binds.add(encoded)}`
    default:
      throw compileError("ValidationError", `unknown write mode "${String(mode)}".`)
  }
}

/** `SET f = $p, g = <expr>` — literals bind per field (already codec-encoded), expressions splice. */
export function setAssignments(encoded: unknown, binds: Binds): string {
  if (!isPlainObject(encoded) || Object.keys(encoded).length === 0)
    throw compileError("ValidationError", 'mode "set" needs "data" with at least one field.')

  return Object.entries(encoded)
    .map(([field, value]) => `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`)
    .join(", ")
}

/** `f = $p.f, g = <expr>` for `ON DUPLICATE KEY UPDATE` from an encoded update payload. */
export function assignmentList(encoded: unknown, binds: Binds): string {
  if (!isPlainObject(encoded)) return ""

  const literals: Record<string, unknown> = {}
  const expressions: [string, unknown][] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [field, value] of Object.entries(encoded)) {
    if (hasRefDeep(value)) expressions.push([field, value])
    else literals[field] = value
  }
  const parts: string[] = []
  if (Object.keys(literals).length > 0) {
    const bind = binds.add(literals)
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const field of Object.keys(literals))
      parts.push(`${renderPath(field)} = ${bind}.${renderPath(field)}`)
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [field, value] of expressions)
    parts.push(`${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`)

  return parts.join(", ")
}

/** The top-level fields an `ON DUPLICATE` update may touch (never identity). */
export function updatableFields(encoded: unknown): string[] {
  const items = Array.isArray(encoded) ? encoded : [encoded]
  const fields = new Set<string>()
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const item of items) {
    if (isPlainObject(item)) {
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const field of Object.keys(item))
        // eslint-disable-next-line max-depth -- parser/compilador com despacho aninhado; achatar mudaria a precedência das cláusulas
        if (field !== "id" && field !== "in" && field !== "out") fields.add(field)
    }
  }
  return [...fields]
}

/** Check `unset` and return the field list (id is identity, unknown fields are typos). */
export function unsetList(value: unknown, meta: ModelMeta, operation: string): readonly string[] {
  if (value === undefined) return []

  const entries = Array.isArray(value) ? value : [value]
  if (entries.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: "unset" is empty — list the fields to remove.`,
      { operation, table: meta.name },
    )
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const field of entries) {
    if (typeof field !== "string" || !field) {
      throw compileError(
        "ValidationError",
        `${operation}: unset entries must be field names, got ${describeValue(field)}.`,
        { operation, table: meta.name },
      )
    }
    if (field === "id") {
      throw compileError(
        "ValidationError",
        `${operation}: "id" cannot be unset (it is the record identity).`,
        { field, operation, table: meta.name },
      )
    }
    requireColumn(meta, field, operation)
  }
  return entries as readonly string[]
}

/** Check a JSON Patch array (shape + ops) and return it for binding. */
export function patchOps(value: unknown, operation: string): readonly unknown[] {
  const entries = requireArray(value, "patches", operation)
  if (entries.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: "patches" is empty — pass at least one JSON Patch op.`,
      { operation },
    )
  }
  const allowed = ["add", "remove", "replace", "move", "copy", "test"]
  entries.forEach((entry, i) => {
    if (!isPlainObject(entry) || typeof entry.op !== "string" || typeof entry.path !== "string") {
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] must be { op, path, … } (JSON Patch), got ${describeValue(entry)}.`,
        { operation },
      )
    }
    if (!allowed.includes(entry.op)) {
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}].op must be one of ${allowed.join(", ")} (got "${entry.op}").`,
        { operation },
      )
    }
    if ((entry.op === "move" || entry.op === "copy") && typeof entry.from !== "string") {
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] (${entry.op}) needs a "from" path.`,
        { operation },
      )
    }
    if (
      (entry.op === "add" || entry.op === "replace" || entry.op === "test") &&
      entry.value === undefined
    ) {
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] (${entry.op}) needs a "value".`,
        { operation },
      )
    }
  })
  return entries
}

/** A non-empty array arg. */
export function requireArray(value: unknown, name: string, operation: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw compileError(
      "ValidationError",
      `${operation}: "${name}" must be a non-empty array (got ${describeValue(value)}).`,
      { operation },
    )
  }
  return value
}

/** A non-empty string arg. */
export function requireString(value: unknown, name: string, operation: string): string {
  if (typeof value !== "string" || !value) {
    throw compileError(
      "ValidationError",
      `${operation}: "${name}" must be a non-empty string (got ${describeValue(value)}).`,
      { operation },
    )
  }
  return value
}

/** A field of the table (schemaless delegates accept anything). */
export function requireColumn(meta: ModelMeta, field: string, operation: string): void {
  if (!isTableMeta(meta) || meta.columns.has(field)) return

  throw compileError(
    "ValidationError",
    `${operation}: "${field}" is not a field of "${meta.name}". Known fields: ${[...meta.columns.keys()].join(", ")}.`,
    { field, operation, table: meta.name },
  )
}

/** Is `field` the record id or a record-link column (values coerce to `RecordId`)? */
export function isRecordColumn(meta: ModelMeta, field: string): boolean {
  if (field === "id") return true

  return isTableMeta(meta) && meta.columns.get(field)?.record !== undefined
}

// The change layer lives in `./change`; re-exported here so a caller that already
// imports the SET builder does not need a second import for the payload split.
export { type ArithmeticStep, extractArithmetic, setBody, type StepOp } from "./adjustment"
