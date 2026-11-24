// The Struct-IR lowering for the OFFLINE side: turn an in-memory `TableDef`/`RelationDef`
// (and standalone `defineFunction`/`defineAccess`/`defineEvent`) into the `Struct` IR, so it can be
// `normalize`d and structurally diffed against the live DB's `fromInfo` (introspectStructured). This
// is the inverse of `pull` and the keystone of the Struct-IR effort. See docs/STRUCT-IR.md.
//
// It reads the `TableDef`/`SField` directly (no DDL round-trip) and reuses the emitter's
// `inferField()` so the type strings and dotted field paths are identical by construction; clauses
// come straight off `SField.surreal` and `TableConfig`. The output is RAW (unsorted, defaults not
// stripped, `option<>` not folded, `x.*` elements present) — `normalizeTable` closes those gaps.

import { BoundQuery, escapeIdent, toSurqlString } from "surrealdb"

import {
  admitNullAssert,
  assertExpr,
  blockThen,
  braceBody,
  eventClause,
  type FieldInfo,
  fieldType,
  inferField,
  inline,
  inlineAnalyzerFunctions,
  upperFilterClause,
} from "../ddl"
import {
  type AccessDef,
  type AnalyzerDef,
  assertCompleteDef,
  type FieldPermissions,
  type FunctionDef,
  type ParamDef,
  type PermOp,
  requireFunctionBody,
  type SequenceDef,
  type SField,
  type Shape,
  type StandaloneDef,
  type SurrealMeta,
  type TableDef,
  type TableEvent,
  type TablePermissions,
  unknownDefKind,
} from "../pure"

import { normalizeDb } from "./struct"
import type {
  DbStructured,
  StructAccess,
  StructAnalyzer,
  StructEvent,
  StructField,
  StructFunction,
  StructIndex,
  StructParam,
  StructPerm,
  StructPermissions,
  StructSequence,
  StructTable,
  StructTableKind,
} from "./structure"

const FIELD_PERM_OPS = ["select", "create", "update"] as const
const TABLE_PERM_OPS = ["select", "create", "update", "delete"] as const

/** The DEFINE EVENT THEN field name, assembled so the object isn't statically read as thenable. */
const THEN_KEY = ("th" + "en") as "then"

/** Sanitize a field path for use inside a derived index name. */
function sanitizeIndexName(part: string): string {
  return part.replaceAll(/[`]/gu, "").replaceAll(/[^a-zA-Z0-9]+/gu, "_")
}

/**
 * Lower a permissions spec to `StructPermissions` (per-op `true`/`false`/WHERE-expr string). A
 * blanket `true`/`false`/`BoundQuery` materializes every op; an object resolves each present op,
 * following `same as X` references (with cycle detection, mirroring `renderPermissions`) and
 * inlining a `BoundQuery` to its WHERE expression. Omitted ops leave them unset — `normalize` reads
 * them as the kind default, so an unspecified op compares equal to the materialized default.
 */
function lowerPermissions(
  spec: FieldPermissions | TablePermissions,
  ops: readonly PermOp[],
): StructPermissions {
  const out: StructPermissions = {}
  if (spec === true) {
    ops.forEach((op) => {
      out[op] = true
    })
    return out
  }
  if (spec === false) {
    ops.forEach((op) => {
      out[op] = false
    })
    return out
  }
  if (spec instanceof BoundQuery) {
    const where = inline(spec)
    ops.forEach((op) => {
      out[op] = where
    })
    return out
  }

  const rules = spec as Partial<Record<PermOp, boolean | BoundQuery | string>>
  const resolved = new Map<PermOp, StructPerm>()
  const resolve = (op: PermOp, chain: PermOp[]): StructPerm => {
    const cached = resolved.get(op)
    if (cached !== undefined) return cached

    const rule = rules[op]
    if (rule === undefined) {
      throw new Error(
        `PERMISSIONS: "same as ${op}" references op "${op}", which is not in the spec`,
      )
    }
    if (chain.includes(op))
      throw new Error(`PERMISSIONS: "same as" reference cycle: ${[...chain, op].join(" -> ")}`)

    let value: StructPerm
    if (typeof rule === "string")
      value = resolve(rule.slice("same as ".length).trim() as PermOp, [...chain, op])
    else if (rule instanceof BoundQuery) value = inline(rule)
    else value = rule

    resolved.set(op, value)
    return value
  }

  ops.forEach((op) => {
    if (rules[op] === undefined) return

    out[op] = resolve(op, [])
  })
  return out
}

/** Lower a field `REFERENCE` to the IR's structured form: `{}` (bare) or `{ on_delete: <action> }`. */
function lowerReference(ref: NonNullable<SurrealMeta["reference"]>): {
  on_delete?: string
} {
  if (ref === true || ref.onDelete === undefined) return {}

  const onDelete = ref.onDelete
  return {
    on_delete: onDelete instanceof BoundQuery ? inline(onDelete) : onDelete.toUpperCase(),
  }
}

/**
 * Walk an `inferField` node into flattened dotted `StructField`s — the paths the emitter
 * produces (`address`, `address.city`, `tags.*`). Unlike the emitter this keeps `option<>` (it does
 * NOT strip it for defaulted/valued/computed fields), and it EMITS the `x.*` element node (rather
 * than folding it) — `normalizeTable` does both folds. Single-field indexes (`.$index()`/`.$unique()`)
 * collect them into `indexes`.
 */
function lowerField(
  path: string,
  table: string,
  info: FieldInfo,
  surreal: SurrealMeta | undefined,
  fields: StructField[],
  indexes: StructIndex[],
): void {
  const sf: StructField = { kind: info.type, name: path, table }
  if (info.flexible) sf.flexible = true

  if (surreal) {
    if (surreal.reference) sf.reference = lowerReference(surreal.reference)

    if (surreal.default) {
      sf.default = inline(surreal.default)
      if (surreal.defaultAlways) sf.default_always = true
    }
    if (surreal.value) sf.value = inline(surreal.value)

    if (surreal.computed) sf.computed = inline(surreal.computed)

    const assert = assertExpr(surreal.asserts)
    if (assert) sf.assert = admitNullAssert(info.type, assert)

    if (surreal.readonly) sf.readonly = true

    if (surreal.comment !== undefined) sf.comment = surreal.comment

    // An internal field grants no record-user access (PERMISSIONS NONE) — it wins over `$permissions`.
    if (surreal.internal) sf.permissions = { create: false, select: false, update: false }
    else if (surreal.permissions !== undefined)
      sf.permissions = lowerPermissions(surreal.permissions, FIELD_PERM_OPS)

    if (surreal.index) {
      const base = `${table}_${sanitizeIndexName(path)}`

      if (surreal.index.spec && surreal.index.unique) {
        // Two indexes on the same field — each independently nameable (mirrors `emit`): spec index
        // takes `name`, UNIQUE index takes `uniqueName`.
        indexes.push(
          {
            cols: [path],
            index: surreal.index.spec,
            name: surreal.index.name ?? `${base}_idx`,
          },
          {
            cols: [path],
            index: "UNIQUE",
            name: surreal.index.uniqueName ?? `${base}_uq`,
          },
        )
      } else {
        const idxName =
          (surreal.index.unique
            ? (surreal.index.uniqueName ?? surreal.index.name)
            : surreal.index.name) ?? `${base}_idx`
        indexes.push({
          cols: [path],
          // FULLTEXT/HNSW/DISKANN spec (`.$fulltext()`/`.$hnsw()`/`.$diskann()`) or UNIQUE/plain.
          index: surreal.index.spec ?? (surreal.index.unique ? "UNIQUE" : ""),
          name: idxName,
        })
      }
    }
  }
  fields.push(sf)

  info.children.forEach((child) => {
    lowerField(`${path}${child.suffix}`, table, child.info, child.surreal, fields, indexes)
  })
}

/** Lower a table/relation event to a `StructEvent` (one or `THEN` exprs, bare; a
 * multi-statement entry auto-blocks `{ …; }` — matching `emitEvent` + INFO's canonical form). */
function lowerEvent(table: string, ev: TableEvent): StructEvent {
  const thens = (Array.isArray(ev.then) ? ev.then : [ev.then]).map((then) => blockThen(then))
  const out: StructEvent = { name: ev.name, [THEN_KEY]: thens, what: table }
  if (ev.when !== undefined) out.when = eventClause(ev.when)

  // `ASYNC [RETRY n] [MAXDEPTH n]` — carried so the event round-trips and diffs (canonical strips
  // SurrealDB's materialized defaults, so an omitted retry/maxDepth converges with the introspected 1/3).
  if (ev.async) {
    out.async = true
    const a = ev.async === true ? {} : ev.async
    if (a.retry !== undefined) out.retry = a.retry

    if (a.maxDepth !== undefined) out.maxdepth = a.maxDepth
  }
  if (ev.comment !== undefined) out.comment = ev.comment

  return out
}

/**
 * Lower an in-memory `TableDef`/`RelationDef` to the `Struct` IR. The result is raw — feed it
 * through `normalizeTable` before comparing. Skips the implicit `id` field (and `in`/`out` on a
 * relation); they manag them by SurrealDB and never emitted.
 */
export function fromTableDef(t: TableDef<string, Shape>): StructTable {
  const cfg = t.config
  const rel = cfg.relation
  const implicit = rel ? new Set(["id", "in", "out"]) : new Set(["id"])

  const fields: StructField[] = []
  const indexes: StructIndex[] = []
  // SINGLETON: the id field is REAL (a literal type the DB enforces), not implicit.
  if (cfg.singleton !== undefined)
    fields.push({ kind: `'${cfg.singleton}'`, name: "id", table: t.name })

  Object.entries(t.fields).forEach(([name, field]) => {
    if (implicit.has(name)) return

    const f = field as SField
    lowerField(escapeIdent(name), t.name, inferField(f.schema), f.surreal, fields, indexes)
  })
  // Composite (multi-field) indexes — and the row-count index (no FIELDS).
  ;(cfg.indexes ?? []).forEach((idx) => {
    indexes.push({
      cols: idx.count ? [] : idx.fields.map(escapeIdent),
      index: idx.count ? "COUNT" : (idx.spec ?? (idx.unique ? "UNIQUE" : "")), // HNSW/DISKANN/FULLTEXT or UNIQUE/plain
      name: idx.name,
      ...(idx.comment === undefined ? {} : { comment: idx.comment }),
    })
  })

  let kind: StructTableKind
  if (rel) {
    kind = { kind: "RELATION" }
    if (rel.from.length > 0) kind.in = [...rel.from]

    if (rel.to.length > 0) kind.out = [...rel.to]

    if (rel.enforced) kind.enforced = true
  } else if (cfg.type === "any") kind = { kind: "ANY" }
  else kind = { kind: "NORMAL" }

  const out: StructTable = {
    events: (cfg.events ?? []).map((ev) => lowerEvent(t.name, ev)),
    fields,
    indexes,
    kind,
    name: t.name,
    schemafull: cfg.schemafull,
  }
  if (cfg.drop) out.drop = true

  if (cfg.comment !== undefined) out.comment = cfg.comment

  if (cfg.permissions !== undefined)
    out.permissions = lowerPermissions(cfg.permissions, TABLE_PERM_OPS)

  // A pre-computed VIEW — the inlined `SELECT …` (without the `AS ` keyword; canonical adds it).
  if (cfg.view !== undefined) out.view = eventClause(cfg.view)

  return out
}

/** Lower a `defineFunction` to a `StructFunction` (block wrapped as `{ … }` to match INFO). */
function lowerFunction(fn: FunctionDef): StructFunction {
  const args: [string, string][] = Object.entries(fn.args).map(([n, f]) => [n, fieldType(f)])
  // A bodyless function is an ERROR, not an empty `{}` block — lowering it would land an
  // empty function in the snapshot while `emit` throws on the same def.
  const out: StructFunction = {
    args,
    block: braceBody(requireFunctionBody(fn)),
    name: fn.name,
  }
  if (fn.config.returns) out.returns = fieldType(fn.config.returns)

  const p = fn.config.permissions
  if (p !== undefined) out.permissions = typeof p === "boolean" ? p : eventClause(p)

  if (fn.config.comment !== undefined) out.comment = fn.config.comment

  return out
}

/** Lower a `defineAccess` to a `StructAccess`. Signing keys are NOT carried (SurrealDB redacts them, so
 * they can't round-trip / diffs it). Used by the migration lowering and by `sc access diff`. */
export function lowerAccess(a: AccessDef): StructAccess {
  const cfg = a.config
  const k = cfg.kind
  let kind: StructAccess["kind"]
  if (k.type === "bearer") {
    kind = {
      kind: "BEARER",
      subject: k.subject === "user" ? "USER" : "RECORD",
    }
  } else if (k.type === "jwt") {
    kind = {
      jwt: { verify: k.url ? { url: k.url } : { alg: k.alg ?? "HS512" } },
      kind: "JWT",
    }
  } else {
    kind = { kind: "RECORD" }
    if (cfg.signup) kind.signup = braceBody(cfg.signup)

    if (cfg.signin) kind.signin = braceBody(cfg.signin)

    // RECORD `WITH JWT` — carry the verify method (url/alg) for diffing; keys stay redacted.
    if (cfg.withJwt) {
      kind.jwt = {
        verify:
          "url" in cfg.withJwt ? { url: cfg.withJwt.url } : { alg: cfg.withJwt.alg ?? "HS512" },
      }
    }
    if (cfg.refresh) kind.refresh = true

    if (cfg.authenticate) kind.authenticate = braceBody(cfg.authenticate)
  }

  const out: StructAccess = { kind, name: a.name }
  const d = cfg.duration
  if (d && (d.grant || d.token || d.session)) {
    out.duration = {}
    if (d.grant) out.duration.grant = d.grant

    if (d.token) out.duration.token = d.token

    if (d.session) out.duration.session = d.session
  }
  if (cfg.comment) out.comment = cfg.comment

  return out
}

/** Lower a `defineAnalyzer` to a `StructAnalyzer` (tokenizers/filters uppercased to match INFO). */
function lowerAnalyzer(a: AnalyzerDef): StructAnalyzer {
  const out: StructAnalyzer = { name: a.name }
  // Store `function` bare (strip an optional `fn::`) to match INFO … STRUCTURE, so it round-trips.
  if (a.config.function) out.function = a.config.function.replace(/^fn::/u, "")

  if (a.config.tokenizers?.length) out.tokenizers = a.config.tokenizers.map((t) => t.toUpperCase())

  if (a.config.filters?.length) out.filters = a.config.filters.map(upperFilterClause)

  if (a.config.comment) out.comment = a.config.comment

  return out
}

/** Lower a MANAGED `defineParam` (inline literal value) to its `StructParam` — the value is the
 * canonical SurrealQL literal TEXT (what INFO stores), so it round-trips. */
export function lowerParam(p: ParamDef): StructParam {
  const out: StructParam = {
    name: p.name,
    value: toSurqlString(p.config.value),
  }
  if (p.config.permissions === false) out.permissions = false

  if (p.config.comment) out.comment = p.config.comment

  return out
}

/** Lower a `defineSequence` to its `StructSequence` (normalize strips the materialized defaults). */
export function lowerSequence(seq: SequenceDef): StructSequence {
  const out: StructSequence = { name: seq.name }
  if (seq.config.batch !== undefined) out.batch = seq.config.batch

  if (seq.config.start !== undefined) out.start = seq.config.start

  if (seq.config.timeout !== undefined) out.timeout = seq.config.timeout

  return out
}

/** Lower a standalone def (`defineFunction`/`defineAccess`/`defineEvent`/`defineAnalyzer`/`defineParam`/`defineSequence`) to its `Struct` IR. */
export function fromStandalone(
  def: StandaloneDef,
): StructAccess | StructAnalyzer | StructEvent | StructFunction | StructParam | StructSequence {
  // An unfinished builder chain (`defineAccess("x")` with no scope/TYPE) throws its teaching error
  // here rather than mis-dispatching below.
  assertCompleteDef(def)
  // An `EventDef` already carries `name`/`when`/`then` — the `TableEvent` shape `lowerEvent` reads.
  if (def.kind === "event") return lowerEvent(def.table, def)

  if (def.kind === "function") return lowerFunction(def)

  if (def.kind === "analyzer") return lowerAnalyzer(def)

  if (def.kind === "param") return lowerParam(def)

  if (def.kind === "sequence") return lowerSequence(def)

  // EXHAUSTIVE: an unknown kind must name itself, not fall into a sibling's lowerer.
  const kind = (def as { kind: string }).kind
  if (kind !== "access") throw unknownDefKind(def as never)

  return lowerAccess(def)
}

/**
 * The NORMALIZED Struct-IR for a whole loaded schema — the offline counterpart of `fromInfo`
 * (introspectStructured). Standalone events attach them to their owning table. Used to render the
 * schema as TypeScript (`diff --ts`) and stored in the snapshot.
 */
export function schemaStruct(
  tables: TableDef<string, Shape>[],
  defs: StandaloneDef[],
): DbStructured {
  const structTables = tables.map((t) => fromTableDef(t))
  const byName = new Map(structTables.map((t) => [t.name, t]))
  const functions: StructFunction[] = []
  const accesses: StructAccess[] = []
  const analyzers: StructAnalyzer[] = []
  const params: StructParam[] = []
  const sequences: StructSequence[] = []
  defs.forEach((d) => {
    switch (d.kind) {
      case "access":
        accesses.push(fromStandalone(d) as StructAccess)
        break
      case "analyzer":
        analyzers.push(fromStandalone(d))
        break
      case "event":
        byName.get(d.table)?.events.push(fromStandalone(d) as StructEvent)
        break
      case "function":
        functions.push(fromStandalone(d) as StructFunction)
        break
      // MANAGED params enter the migration flow; secret/declared params are out-of-band.
      case "param":
        if (d.managed) params.push(fromStandalone(d) as StructParam)
        break
      case "sequence":
        sequences.push(fromStandalone(d))
        break
    }
  })
  // An inline `.function(input => surql`…`)` carries an auto-created function — expand it into the
  // functions list (deduped, collision-checked) so it emits/diffs/pulls as a normal `defineFunction`
  // the analyzer references. Same helper the emit path uses, so both agree on collisions.
  inlineAnalyzerFunctions(defs).forEach((fn) => {
    functions.push(fromStandalone(fn) as StructFunction)
  })

  return normalizeDb({
    accesses,
    analyzers,
    functions,
    params,
    sequences,
    tables: structTables,
  })
}
