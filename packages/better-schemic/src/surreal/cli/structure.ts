import { escapeIdent, type Surreal } from "surrealdb"

import { type DefineStatement, renderAsync, SEQ_DEFAULT_BATCH, SEQ_DEFAULT_START } from "../ddl"
import { splitTopUnion } from "../surql-type-expr"

/** A snapshot statement: the emitted DDL plus the source file it came from (for `diff` annotations). */
export type SnapshotStatement = DefineStatement & {
  /** Project-root-relative source file (absent for objects introspected from a live DB). */
  file?: string
}

/**
 * The legacy STATEMENT snapshot — canonical SurrealQL DDL keyed by `kind:table:name`, + the
 * optional normalized Struct (for `diff --ts`). This is the Surreal driver's INTERNAL diff data
 * model (`buildSnapshot`/`diffSnapshots`/`structuredSnapshot`), derived on demand from the portable
 * IR. The NEUTRAL stored snapshot is `StoredSnapshot` in cli/meta.ts.
 */
export type Snapshot = {
  statements: Record<string, SnapshotStatement>
  struct?: DbStructured
  version: 1
}

/** The empty STATEMENT snapshot — the Surreal engine's "nothing yet" sentinel (e.g. baseline diff). */
export const EMPTY_SNAPSHOT: Snapshot = { statements: {}, version: 1 }

/**
 * Typed views of `INFO FOR … STRUCTURE` (SurrealDB 3.x). Unlike plain `INFO FOR …` (which
 * returns DDL strings that have to be regex-parsed), STRUCTURE returns the schema as data — so
 * names, clauses, flags, and permissions arrive pre-separated. `kind` stays a type
 * expression (`object | none`, `array<record<user>>`, `'a' | 'b'`), parsed by `szType`.
 */

/** A permission op's rule: `true` (FULL) / `false` (NONE) / a WHERE expression string. */
export type StructPerm = boolean | string

export type StructPermissions = {
  create?: StructPerm
  delete?: StructPerm
  select?: StructPerm
  update?: StructPerm
}

export type StructField = {
  assert?: string
  comment?: string
  /** `COMPUTED <expr>` — a derived, read-column. */
  computed?: string
  default?: string
  default_always?: boolean
  flexible?: boolean
  /** The SurrealQL type expression (kind), e.g. `string`, `option<int>`, `array<string>`. */
  kind: string
  /** Field path, e.g. `email`, `address.city`, `tags.*` — bare (no backtick escaping). */
  name: string
  permissions?: StructPermissions
  readonly?: boolean
  /** `REFERENCE [ON DELETE …]` on a record-link field. `on_delete` mirrors `INFO … STRUCTURE`
   *  (snake_case) and the offline lowering (`lowerReference`): an action keyword (`CASCADE`/…) or a
   * `surql` expression. Absent = no reference; present-without-`on_delete` = a bare `REFERENCE`. */
  reference?: { on_delete?: string }
  table: string
  value?: string
}

export type StructIndex = {
  /** Indexed columns/fields. */
  cols: string[]
  /** `COMMENT <string>` on the index. */
  comment?: string
  /** `"UNIQUE"`, `""` (plain), `"COUNT"`, or a `FULLTEXT …`/`HNSW …`/`DISKANN …` spec (canonicalized). */
  index: string
  name: string
}

export type StructEvent = {
  /** `ASYNC` — true for async events; `retry`/`maxdepth` materializ them (default 1 / 3). */
  async?: boolean
  /** `COMMENT @string`. */
  comment?: string
  maxdepth?: number
  name: string
  retry?: number
  /** One or more `THEN` expressions (parens/`;` already stripped). */
  then: string[]
  /** Owning table (STRUCTURE calls it `what`). */
  what: string
  /** The `WHEN` condition. SurrealDB stores an omitted `WHEN` as the literal `"true"`. */
  when?: string
}

export type StructFunction = {
  /** Ordered `[argName, surqlType]` pairs. */
  args: [string, string][]
  /** The body block, e.g. `{ RETURN $a + $b }`. */
  block: string
  comment?: string
  name: string
  /** Execute permission: `true` (FULL, the default) / `false` (NONE) / a WHERE expression. */
  permissions?: boolean | string
  /** Declared return type, if any. */
  returns?: string
}

export type StructAccess = {
  /** `COMMENT @string`. */
  comment?: string
  duration?: { grant?: string; session?: string; token?: string }
  kind: {
    authenticate?: string
    /** JWT/BEARER token config. The `key` redacts it by SurrealDB; `alg`/`url` are not. */
    jwt?: {
      issuer?: { alg?: string; key?: string }
      verify?: { alg?: string; key?: string; url?: string }
    }
    kind: string // "RECORD" | "JWT" | "BEARER"
    /** RECORD: `WITH REFRESH` — issues refresh tokens. */
    refresh?: boolean
    signin?: string
    /** RECORD bodies. */
    signup?: string
    /** BEARER: `"RECORD"` | `"USER"`. */
    subject?: string
  }
  name: string
}

/** A text-search `DEFINE ANALYZER` — `INFO … STRUCTURE` returns uppercase tokenizer/filter lists. */
export type StructAnalyzer = {
  comment?: string
  filters?: string[]
  /** Custom tokenizing function, the BARE name (no `fn::` prefix — as INFO … STRUCTURE returns it). */
  function?: string
  name: string
  tokenizers?: string[]
}

/** A `DEFINE PARAM` — INFO … STRUCTURE returns the value as canonical SurrealQL literal TEXT
 *  (`'https://x.dev'`, `25`) and `permissions` as a boolean. MANAGED (inline-literal) params
 * enter this flow; secret/declared params are out-of-band (`sc param push/check`). */
export type StructParam = {
  comment?: string
  name: string
  /** `false` = PERMISSIONS NONE; omitted/true = FULL (the default, dropped by normalize). */
  permissions?: boolean
  /** The canonical literal text of the stored value. */
  value: string
}

/** A `DEFINE SEQUENCE` — `INFO … STRUCTURE` returns `batch`/`start` as strings (e.g. `"1000"`) and
 * `timeout` as a duration string. SurrealDB materializes the defaults (BATCH 1000, START 0), which
 * the canonical form strips so an authored minimal sequence compares equal to the read-back one. */
export type StructSequence = {
  /** `BATCH <n>` — how some values a fetch reserves (SurrealDB default 1000). */
  batch?: number
  name: string
  /** `START <n>` — the first value (SurrealDB default 0). */
  start?: number
  /** `TIMEOUT <duration>` — how long a reserved batch helds it before it can reclaims it. */
  timeout?: string
}

export type StructTableKind = {
  enforced?: boolean
  in?: string[]
  kind: "ANY" | "NORMAL" | "RELATION"
  out?: string[]
}

export type StructTable = {
  comment?: string
  drop?: boolean
  events: StructEvent[]
  fields: StructField[]
  indexes: StructIndex[]
  kind: StructTableKind
  name: string
  permissions?: StructPermissions
  schemafull: boolean
  /** A pre-computed VIEW's `SELECT …` (the `AS ` keyword stripped; canonical re-adds it). */
  view?: string
}

type DbStructure = {
  accesses?: StructAccess[]
  analyzers?: StructAnalyzer[]
  functions?: StructFunction[]
  params?: StructParam[]
  sequences?: {
    batch?: number | string
    name: string
    start?: number | string
    timeout?: string
  }[]
  tables?: (Omit<StructTable, "fields" | "indexes" | "kind"> & {
    id?: number
    kind: {
      enforced?: boolean
      in?: unknown[]
      kind: StructTableKind["kind"]
      out?: unknown[]
    }
  })[]
}

/** The structured database: tables (with their fields/indexes/events) and db-level objects. */
export type DbStructured = {
  accesses: StructAccess[]
  analyzers: StructAnalyzer[]
  functions: StructFunction[]
  params: StructParam[]
  /** Optional so hand-built/legacy `DbStructured` fixtures stay valid; readers default to `[]`. */
  sequences?: StructSequence[]
  tables: StructTable[]
}
type TableStructure = {
  events?: StructEvent[]
  fields?: StructField[]
  indexes?: StructIndex[]
}

/** The unescaped name of a relation endpoint — the SDK deserializes `in`/`out` as `Table` objects. */
function endpointName(v: unknown): string {
  if (typeof v === "string") return v

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- verificação defensiva: chamadores JS/SDK podem violar o tipo estático
  const name = (v as { name?: unknown })?.name
  return typeof name === "string" ? name : String(v)
}

// --- Canonical DDL ----------------------------------------------------------------------------
// Build a deterministic DDL string per object from the structured data, so two semantically-equal
// schemas compare equal regardless of how SurrealDB happened to format/order them. Both sides of
// `diff --live` (the live DB and the shadow-applied schema) go through this same builder.

/**
 * Canonical form of a type `kind`: fold a top-level `none` member into `option<…>` and sort the
 * remaining union members, so `object | none` / `none | object` / `option<object>` all collapse
 * to the same string (the union-ordering false-diff fix, done structurally).
 */
function canonicalKind(kind: string): string {
  const parts = splitTopUnion(kind).map((p) => p.trim())
  if (parts.length <= 1) return kind.trim()

  const hasNone = parts.includes("none")
  const rest = parts.filter((p) => p !== "none")
  if (hasNone) {
    if (rest.length === 0) return "none"

    const inner = rest.length === 1 ? rest[0] : [...rest].sort().join(" | ")
    return `option<${inner}>`
  }
  return [...parts].sort().join(" | ")
}

/**
 * Canonical `PERMISSIONS …` clause from structured perms (`""` when it matches the kind default).
 * `defaultFull` is the kind's default: FULL for fields/functions, NONE for tables. INFO materializes
 * the default explicitly; the generator omits it — so we drop the clause when all ops are the
 * default, making an unspecified `PERMISSIONS` compare equal across the two emitters.
 */
function canonicalPerms(
  perms: StructPermissions | undefined,
  ops: (keyof StructPermissions)[],
  defaultFull: boolean,
): string {
  if (!perms) return ""

  const vals = ops.map((op) => perms[op])
  const allFull = vals.every((v) => v === true)
  const allNone = vals.every((v) => v === false || v === undefined)
  if (defaultFull ? allFull : allNone) return ""

  if (allFull) return "PERMISSIONS FULL"

  if (allNone) return "PERMISSIONS NONE"

  // Mixed: emit the ops that differ from the kind default (the generator omits default ops),
  // GROUPED by clause body so same-permission ops collapse into one clause — `FOR select, update
  // WHERE …` — matching SurrealDB's INFO form and the authoring emitter (`permissionsClause` in ddl.ts).
  const isDefault = (v: StructPermissions[keyof StructPermissions]) =>
    defaultFull ? v === true : v === false || v === undefined
  const groups = new Map<string, string[]>()
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const op of ops) {
    const v = perms[op]
    if (isDefault(v)) continue

    // eslint-disable-next-line unicorn/no-nested-ternary -- Prettier remove os parênteses exigidos pela regra; a expressão encadeada é mais legível que if/else aqui
    const body = v === true ? "FULL" : v === false || v === undefined ? "NONE" : `WHERE ${v}`
    const group = groups.get(body)
    if (group) group.push(op)
    else groups.set(body, [op])
  }
  const clauses = [...groups].map(([body, group]) => `FOR ${group.join(", ")} ${body}`)
  return clauses.length > 0 ? `PERMISSIONS ${clauses.join(" ")}` : ""
}

/**
 * Field CLAUSES keyed by clause name (insertion order == DDL order), each value already in the
 * `ALTER FIELD … <set>` form — so the migration engine can diff clauses structurally without
 * re-parsing the DDL (matches the authoring `emit` in ddl.ts). Keys drawn them from
 * `FIELD_CLAUSE_ORDER` — including REFERENCE (emitted below + reversed by `pull`'s `renderField`).
 */
function fieldClauses(f: StructField): Record<string, string> {
  const clauses: Record<string, string> = {
    TYPE: `TYPE ${canonicalKind(f.kind)}`,
  }
  if (f.flexible) clauses.FLEXIBLE = "FLEXIBLE"

  // REFERENCE. SurrealDB defaults a bare `REFERENCE` to `ON DELETE IGNORE` and MATERIALIZES that in
  // `INFO … STRUCTURE` (reference: { on_delete: 'IGNORE' }), whereas the offline lowering leaves a
  // bare reference's on_delete absent — so IGNORE (and absent) both canonicalize to a bare `REFERENCE`
  // (else every bare reference phantom-diffs against a live DB). A non-default action keyword renders
  // `ON DELETE <ACTION>`; anything else (a surql expression) renders `ON DELETE THEN <expr>`. Inserted
  // after FLEXIBLE to match FIELD_CLAUSE_ORDER, so a reference change diffs as ALTER FIELD, not OVERWRITE.
  if (f.reference) {
    const od = f.reference.on_delete
    clauses.REFERENCE =
      !od || od.toUpperCase() === "IGNORE"
        ? "REFERENCE"
        : `REFERENCE ON DELETE ${/^(REJECT|CASCADE|UNSET)$/iu.test(od) ? od : `THEN ${od}`}`
  }
  if (f.default !== undefined)
    clauses.DEFAULT = `DEFAULT ${f.default_always ? "ALWAYS " : ""}${f.default}`

  if (f.value !== undefined) clauses.VALUE = `VALUE ${f.value}`

  if (f.computed !== undefined) clauses.COMPUTED = `COMPUTED ${f.computed}`

  if (f.assert !== undefined) clauses.ASSERT = `ASSERT ${f.assert}`

  if (f.readonly) clauses.READONLY = "READONLY"

  if (f.comment !== undefined) clauses.COMMENT = `COMMENT ${JSON.stringify(f.comment)}`

  const perms = canonicalPerms(f.permissions, ["select", "create", "update"], true)
  if (perms) clauses.PERMISSIONS = perms

  return clauses
}

/** Canonical `DEFINE FIELD …`. The name takes it as-is (STRUCTURE already escapes reserved words). */
function canonicalField(f: StructField): string {
  const { TYPE, ...rest } = fieldClauses(f)
  const head = `DEFINE FIELD ${f.name} ON TABLE ${f.table} ${TYPE}`
  const tail = Object.values(rest).join(" ")
  return tail ? `${head} ${tail};` : `${head};`
}

/**
 * Table-head CLAUSES keyed by clause name (insertion order == DDL order), in the `ALTER TABLE …
 * <set>` form so the migration engine can diff them structurally. Keys drawn them from
 * `TABLE_CLAUSE_ORDER` (the head's own clauses; fields/indexes/events are their own statements).
 */
function tableHeadClauses(t: StructTable): Record<string, string> {
  const k = t.kind
  let type: string
  if (k.kind === "RELATION") {
    // Endpoints optional — omit FROM/TO when unrestricted (matches `emit`). INFO stores them as
    // IN/OUT; the generator (and our canonical form) use the FROM/TO alias.
    type = "RELATION"
    if (k.in?.length) type += ` FROM ${k.in.join(" | ")}`

    if (k.out?.length) type += ` TO ${k.out.join(" | ")}`

    if (k.enforced) type += " ENFORCED"
  } else type = k.kind

  const clauses: Record<string, string> = { TYPE: `TYPE ${type}` }
  clauses.SCHEMA = t.schemafull ? "SCHEMAFULL" : "SCHEMALESS"
  if (t.view !== undefined) clauses.AS = `AS ${t.view}`

  if (t.drop) clauses.DROP = "DROP"

  if (t.comment !== undefined) clauses.COMMENT = `COMMENT ${JSON.stringify(t.comment)}`

  const perms = canonicalPerms(t.permissions, ["select", "create", "update", "delete"], false)
  if (perms) clauses.PERMISSIONS = perms

  return clauses
}

/** Canonical `DEFINE TABLE …` head. */
function canonicalTableHead(t: StructTable): string {
  const { TYPE, ...rest } = tableHeadClauses(t)
  const head = `DEFINE TABLE ${t.name} ${TYPE}`
  const tail = Object.values(rest).join(" ")
  return tail ? `${head} ${tail};` : `${head};`
}

// SurrealDB MATERIALIZES default vector/fulltext index clauses on apply — e.g. `HNSW DIMENSION 4` is
// stored as `HNSW DIMENSION 4 DIST EUCLIDEAN TYPE F32 EFC 150 M 12 M0 24 LM <1/ln(M)>f`, and `FULLTEXT
// ANALYZER a` always carries `BM25(1.2,0.75)`. So the CANONICAL form strips default-valued + derived
// clauses and normalizes numbers (drops the SurrealQL `f` float suffix), making an authored MINIMAL
// spec compare equal to the introspected FULL one. Non-default values keep them.

/** Normalize a SurrealQL number token: drop a trailing `f`, collapse float noise (`1.20` -> `1.2`). */
function normNum(v: string): string {
  const n = Number(v.replace(/f$/iu, ""))
  return Number.isFinite(n) ? String(n) : v
}

/** Default-valued clauses SurrealDB fills in (stripped from canonical when they match). */
const VECTOR_DEFAULTS: Record<string, Record<string, string>> = {
  DISKANN: {
    ALPHA: "1.2",
    DEGREE: "64",
    DIST: "EUCLIDEAN",
    L_BUILD: "100",
    TYPE: "F32",
  },
  HNSW: { DIST: "EUCLIDEAN", EFC: "150", M: "12", TYPE: "F32" },
}
/** Clauses fully DERIVED from others (never authored, always stripped): HNSW `M0`=2·M, `LM`=1/ln(M). */
const VECTOR_DERIVED: Record<string, Set<string>> = {
  DISKANN: new Set(),
  HNSW: new Set(["M0", "LM"]),
}
/** Canonical clause order (matches the authoring emit). */
const VECTOR_ORDER: Record<string, string[]> = {
  DISKANN: ["DIMENSION", "DIST", "TYPE", "DEGREE", "L_BUILD", "ALPHA"],
  HNSW: ["DIMENSION", "DIST", "TYPE", "EFC", "M"],
}

/** Canonicalize an `HNSW …`/`DISKANN …` spec: drop derived + default clauses, normalize numbers. */
function normVector(algo: "DISKANN" | "HNSW", spec: string): string {
  const toks = spec.slice(algo.length).trim().split(/\s+/u).filter(Boolean)
  const kept = new Map<string, string>()
  // eslint-disable-next-line functional/no-loop-statements, @typescript-eslint/no-magic-numbers -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (let i = 0; i < toks.length; i += 2) {
    const key = toks[i]
    let val = toks[i + 1] ?? ""
    if (VECTOR_DERIVED[algo].has(key)) continue

    if (/^[\d.]/u.test(val) || /f$/iu.test(val)) val = normNum(val)

    if (VECTOR_DEFAULTS[algo][key] === val) continue

    kept.set(key, val)
  }
  const parts: string[] = [algo]
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const k of VECTOR_ORDER[algo]) {
    const v = kept.get(k)
    if (v !== undefined) parts.push(k, v)
  }
  return parts.join(" ")
}

/** Canonicalize a `FULLTEXT [ANALYZER …] [BM25[(k,b)]] [HIGHLIGHTS]` spec: drop SurrealDB's
 * materialized defaults — the built-in `like` analyzer (injected when none gives it) and BM25(1.2,0.75). */
function normFulltext(spec: string): string {
  const m = /^FULLTEXT(?:\s+ANALYZER\s+(\S+))?(.*)$/u.exec(spec)
  if (!m) return spec

  let out = "FULLTEXT"
  if (m[1] && m[1] !== "like") out += ` ANALYZER ${m[1]}`
  // a non-default analyzer remains
  const rest = m[2]
  const bm = /BM25(?:\(([^)]*)\))?/u.exec(rest)
  if (bm?.[1]) {
    const args = bm[1].split(",").map((a) => normNum(a.trim()))
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
    if (!(args.length === 2 && args[0] === "1.2" && args[1] === "0.75"))
      out += ` BM25(${args.join(",")})`
    // a non-default BM25 remains
  }
  if (/\bHIGHLIGHTS\b/u.test(rest)) out += " HIGHLIGHTS"

  return out
}

/** Strip SurrealDB's materialized defaults from a vector/fulltext index spec (passthrough otherwise). */
function normalizeIndexSpec(spec: string): string {
  if (spec.startsWith("HNSW")) return normVector("HNSW", spec)

  if (spec.startsWith("DISKANN")) return normVector("DISKANN", spec)

  if (spec.startsWith("FULLTEXT")) return normFulltext(spec)

  return spec // "", UNIQUE, COUNT (or a legacy SEARCH/MTREE spec) — left as-is
}

/** Canonical `DEFINE INDEX …`. `index` is `"UNIQUE"`/`""`/`"COUNT"`, or a FULLTEXT/HNSW/DISKANN spec —
 * the latter normalized (materialized defaults stripped) so authored and introspected sides match. */
function canonicalIndex(t: StructTable, idx: StructIndex): string {
  // A COUNT index has no columns → no `FIELDS` clause (`idx.index` carries `COUNT`).
  const fields = idx.cols.length > 0 ? ` FIELDS ${idx.cols.join(", ")}` : ""
  const norm = normalizeIndexSpec(idx.index)
  const spec = norm ? ` ${norm}` : ""
  const comment = idx.comment === undefined ? "" : ` COMMENT ${JSON.stringify(idx.comment)}`
  return `DEFINE INDEX ${idx.name} ON TABLE ${t.name}${fields}${spec}${comment};`
}

/**
 * Canonical `DEFINE EVENT …`. An omitted `WHEN` (stored by SurrealDB as `"true"`) dropps it, and
 * the `then` expressions are comma-joined — so an event authored with/without a `WHEN true` and any
 * `THEN` formatting compares equal across the live DB and the shadow-applied schema.
 */
function canonicalEvent(t: StructTable, ev: StructEvent): string {
  const parts = [`DEFINE EVENT ${ev.name} ON TABLE ${t.name}`]
  // Clause order matches `emitEvent`: ASYNC, WHEN, THEN, COMMENT (so both sides compare equal).
  if (ev.async) parts.push(renderAsync(ev.retry, ev.maxdepth))

  if (ev.when !== undefined && ev.when !== "true") parts.push(`WHEN ${ev.when}`)

  parts.push(`THEN ${ev.then.join(", ")}`)
  if (ev.comment) parts.push(`COMMENT ${JSON.stringify(ev.comment)}`)

  return `${parts.join(" ")};`
}

/**
 * Canonical `DEFINE FUNCTION …`. The `block` takes it verbatim (already `{ … }`); a `true`
 * (FULL — SurrealDB's default) permission dropps it so an unspecified `PERMISSIONS` compares equal
 * across the live DB and the shadow-applied schema.
 */
function canonicalFunction(fn: StructFunction): string {
  const args = fn.args.map(([n, t]) => `$${n}: ${t}`).join(", ")
  const parts = [`DEFINE FUNCTION fn::${fn.name}(${args})`]
  if (fn.returns !== undefined) parts.push(`-> ${fn.returns}`)

  parts.push(fn.block)
  if (fn.permissions === false) parts.push("PERMISSIONS NONE")
  else if (typeof fn.permissions === "string") parts.push(`PERMISSIONS ${fn.permissions}`)

  if (fn.comment !== undefined) parts.push(`COMMENT ${JSON.stringify(fn.comment)}`)

  return `${parts.join(" ")};`
}

/**
 * Canonical `DEFINE ACCESS …`. The signing KEY is INTENTIONALLY ignored — SurrealDB redacts it
 * identically on both diff sides, so comparing it's meaningless (key changes go undetected by
 * `diff --live`; documented). The JWT `alg`/`url` keep them (not redacted). Always `ON DATABASE`.
 */
// eslint-disable-next-line unicorn/consistent-function-scoping -- helper local mantido junto do uso para coesão e legibilidade
function canonicalAccess(a: StructAccess): string {
  const k = a.kind
  let typeClause: string
  if (k.kind === "BEARER") typeClause = `TYPE BEARER FOR ${k.subject}`
  else if (k.kind === "JWT") {
    const v = k.jwt?.verify
    typeClause = v?.url
      ? `TYPE JWT URL ${JSON.stringify(v.url)}`
      : `TYPE JWT ALGORITHM ${v?.alg ?? ""}` // KEY omitted (redacted)
  } else typeClause = "TYPE RECORD"

  const parts = [`DEFINE ACCESS ${a.name} ON DATABASE ${typeClause}`]
  if (k.kind === "RECORD") {
    if (k.signup) parts.push(`SIGNUP ${k.signup}`)

    if (k.signin) parts.push(`SIGNIN ${k.signin}`)

    if (k.refresh) parts.push("WITH REFRESH")

    if (k.authenticate) parts.push(`AUTHENTICATE ${k.authenticate}`)
  }
  const d = a.duration
  // INFO returns durations as SDK `Duration` objects (the type says `string` but lies at runtime), so
  // coerce before comparing/emitting. SurrealDB materializes `DURATION FOR TOKEN 1h` as the default on
  // every access, so strip it — an authored access that omits the token would otherwise phantom-diff
  // against the introspected `FOR TOKEN 1h` forever (SESSION NONE is already dropped on introspect). A
  // non-default token survives; an explicit `1h` collapses to the same canonical as omitting it.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- stringificação de valor dinâmico é intencional (mensagem de erro)
  const str = (v: unknown): string | undefined => (v == null ? undefined : String(v))
  // SurrealDB's materialized duration defaults: TOKEN 1h (all access), GRANT 4w2d (=30d, BEARER),
  // SESSION NONE (already dropped on introspect). Stripping them keeps an omitted duration matching
  // the introspected default. NOTE: compares SurrealDB's canonical spelling — an explicit non-default
  // authored in a different unit (e.g. "30d" vs "4w2d", "60m" vs "1h") is not yet unit-normalized.
  const grant = str(d?.grant)
  const grantOut = grant === "4w2d" ? undefined : grant
  const tok = str(d?.token)
  const token = tok === "1h" ? undefined : tok
  const session = str(d?.session)
  if (grantOut || token || session) {
    const fors: string[] = []
    if (grantOut) fors.push(`FOR GRANT ${grantOut}`)

    if (token) fors.push(`FOR TOKEN ${token}`)

    if (session) fors.push(`FOR SESSION ${session}`)

    parts.push(`DURATION ${fors.join(", ")}`)
  }
  if (a.comment) parts.push(`COMMENT ${JSON.stringify(a.comment)}`)

  return `${parts.join(" ")};`
}

/** Canonical `DEFINE ANALYZER …` — tokenizer/filter lists joined `, ` (uppercase, as INFO returns them).
 * Both clauses are optional: a bare `DEFINE ANALYZER <name>` is valid (INFO returns the name). */
/** Canonical `DEFINE PARAM $<name> VALUE <literal> [PERMISSIONS NONE] [COMMENT …]`. */
function canonicalParam(p: StructParam): string {
  let s = `DEFINE PARAM $${p.name} VALUE ${p.value}`
  if (p.permissions === false) s += " PERMISSIONS NONE"

  if (p.comment) s += ` COMMENT ${JSON.stringify(p.comment)}`

  return `${s};`
}

/** Canonical `DEFINE SEQUENCE <name> [BATCH <n>] [START <n>] [TIMEOUT <dur>]` (defaults omitted;
 * the default constants live in `../ddl` so the emitter and this builder can't drift). */
function canonicalSequence(s: StructSequence): string {
  let out = `DEFINE SEQUENCE ${s.name}`
  if (s.batch !== undefined && s.batch !== SEQ_DEFAULT_BATCH) out += ` BATCH ${s.batch}`

  if (s.start !== undefined && s.start !== SEQ_DEFAULT_START) out += ` START ${s.start}`

  if (s.timeout !== undefined) out += ` TIMEOUT ${s.timeout}`

  return `${out};`
}

function canonicalAnalyzer(a: StructAnalyzer): string {
  let s = `DEFINE ANALYZER ${a.name}`
  // Grammar order: FUNCTION, TOKENIZERS, FILTERS, COMMENT. `function` stores it bare; re-prefix `fn::`.
  if (a.function) s += ` FUNCTION fn::${a.function}`

  if (a.tokenizers?.length) s += ` TOKENIZERS ${a.tokenizers.join(", ")}`

  if (a.filters?.length) s += ` FILTERS ${a.filters.join(", ")}`

  if (a.comment) s += ` COMMENT ${JSON.stringify(a.comment)}`

  return `${s};`
}

/**
 * Fold an array element type into a BARE `array`/`set` kind, so a field stored as `array` with an
 * `array.* TYPE object` element compares equal to `array<object>` (the typed form the engine
 * emits). Typed kinds (`array<X>`) and the `.*` itself leave them alone — the element is in the type.
 */
function foldArrayElement(kind: string, elementKind: string): string {
  const elem = canonicalKind(elementKind)
  // Replace a bare `array`/`set` (not already followed by `<…>`) — handles `option<array>` too.
  return kind.replace(/\b(array|set)\b(?!<)/u, (kw) => `${kw}<${elem}>`)
}

/** True if every listed permission op is FULL (`true`) or unset — i.e. the default. */
function isFullPerms(
  perms: StructPermissions | undefined,
  ops: (keyof StructPermissions)[],
): boolean {
  if (!perms) return true

  return ops.every((op) => perms[op] === undefined || perms[op] === true)
}

/**
 * An array element (`x.*`) is "trivial" when it's the form SurrealDB auto-creates from
 * `array<…>` — a plain element with default permissions and no other clause. Trivial elements are
 * folded into the parent type and not emitted; a CUSTOMIZED element (FLEXIBLE / permissions /
 * readonly / default / value / assert / comment) keeps it so its config isn't lost.
 */
function isTrivialElement(f: StructField): boolean {
  return (
    !f.flexible &&
    !f.readonly &&
    f.default === undefined &&
    f.value === undefined &&
    f.assert === undefined &&
    f.comment === undefined &&
    isFullPerms(f.permissions, ["select", "create", "update"])
  )
}

const keyOf = (s: Pick<DefineStatement, "kind" | "name" | "table">) =>
  `${s.kind}:${s.table ?? ""}:${s.name}`

/**
 * Build a canonical-DDL {@link Snapshot} from the structured database (tables + db-level functions).
 * Skips implicit `id` (and `in`/`out` on relations) and childless `*` array-element fields —
 * the engine's emit doesn't produce them, so the snapshot must not either (else diff would
 * try to drop/add them).
 */
export function structuredSnapshot({
  accesses,
  analyzers,
  functions,
  params,
  sequences = [],
  tables,
}: DbStructured): Snapshot {
  const statements: Record<string, DefineStatement> = {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const t of tables) {
    const tableStmt: DefineStatement = {
      clauses: tableHeadClauses(t),
      ddl: canonicalTableHead(t),
      kind: "table",
      name: t.name,
    }
    statements[keyOf(tableStmt)] = tableStmt

    const implicit = t.kind.kind === "RELATION" ? new Set(["id", "in", "out"]) : new Set(["id"])
    // A trivial array element (`x.*`) folds it into the parent's `array<…>` type and not emitted
    // (so bare `array` + `x.* object` == typed `array<object>`). A CUSTOMIZED element (FLEXIBLE /
    // permissions / …) keeps it so its config isn't lost. Map/record `.*` values keep them too.
    const byName = new Map(t.fields.map((f) => [f.name, f]))
    const elementOf = new Map<string, StructField>()
    // eslint-disable-next-line functional/no-loop-statements, @typescript-eslint/no-magic-numbers -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const f of t.fields) if (f.name.endsWith(".*")) elementOf.set(f.name.slice(0, -2), f)

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const f of t.fields) {
      if (implicit.has(f.name)) continue

      if (f.name.endsWith(".*")) {
        // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
        const parent = byName.get(f.name.slice(0, -2))
        const parentIsArray = parent ? /\b(?:array|set)\b/u.test(parent.kind) : false
        // eslint-disable-next-line max-depth -- parser com estado mutável; extrair helpers mudaria a semântica
        if (parentIsArray && isTrivialElement(f)) continue
        // auto-created form → folded
      }
      const elem = elementOf.get(f.name)
      const field = elem ? { ...f, kind: foldArrayElement(f.kind, elem.kind) } : f
      const s: DefineStatement = {
        clauses: fieldClauses(field),
        ddl: canonicalField(field),
        kind: "field",
        name: f.name,
        table: t.name,
      }
      statements[keyOf(s)] = s
    }
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const idx of t.indexes) {
      const s: DefineStatement = {
        ddl: canonicalIndex(t, idx),
        kind: "index",
        name: idx.name,
        table: t.name,
      }
      statements[keyOf(s)] = s
    }
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const ev of t.events) {
      const s: DefineStatement = {
        ddl: canonicalEvent(t, ev),
        kind: "event",
        name: ev.name,
        table: t.name,
      }
      statements[keyOf(s)] = s
    }
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const fn of functions) {
    const s: DefineStatement = {
      ddl: canonicalFunction(fn),
      kind: "function",
      name: fn.name,
    }
    statements[keyOf(s)] = s
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const a of accesses) {
    const s: DefineStatement = {
      ddl: canonicalAccess(a),
      kind: "access",
      name: a.name,
    }
    statements[keyOf(s)] = s
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const an of analyzers) {
    const s: DefineStatement = {
      ddl: canonicalAnalyzer(an),
      kind: "analyzer",
      name: an.name,
    }
    statements[keyOf(s)] = s
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const pm of params) {
    const s: DefineStatement = {
      ddl: canonicalParam(pm),
      kind: "param",
      name: pm.name,
    }
    statements[keyOf(s)] = s
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const sq of sequences) {
    const s: DefineStatement = {
      ddl: canonicalSequence(sq),
      kind: "sequence",
      name: sq.name,
    }
    statements[keyOf(s)] = s
  }
  return { statements, version: 1 }
}

/**
 * Read the live database structure via `INFO FOR DB STRUCTURE` (table heads + db-level functions)
 * plus one `INFO FOR TABLE … STRUCTURE` per table (its fields/indexes/events), skipping `exclude`d
 * tables. Functions are db-level and not excludable.
 */
// eslint-disable-next-line unicorn/consistent-function-scoping -- helper local mantido junto do uso para coesão e legibilidade
export async function introspectStructured(
  db: Surreal,
  exclude = new Set<string>(),
): Promise<DbStructured> {
  const [dbInfo] = await db.query<[DbStructure]>("INFO FOR DB STRUCTURE")
  const heads = (dbInfo.tables ?? []).filter((t) => !exclude.has(t.name))
  // ONE round-trip for every per-table `INFO … STRUCTURE` (N+1 removed): the statements are
  // independent and the server answers them in order, so the response array zips with `heads`.
  const tableInfos =
    heads.length === 0
      ? []
      : await db.query<TableStructure[]>(
          heads.map((t) => `INFO FOR TABLE ${escapeIdent(t.name)} STRUCTURE;`).join("\n"),
        )
  const tables: StructTable[] = []
  // eslint-disable-next-line functional/no-loop-statements, unicorn-plugin/no-for-loop -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica / índice do loop é usado para alinhar duas listas paralelas
  for (let i = 0; i < heads.length; i++) {
    const t = heads[i]
    const tinfo = tableInfos[i]
    tables.push({
      comment: t.comment,
      drop: t.drop,
      // The SDK deserializes an event's `what` as a `Table` object — normalize to its name so the
      // live struct deep-compares equal to the authored one (`what` is a plain string there).
      events: (tinfo.events ?? []).map((event) => ({
        ...event,
        what: endpointName(event.what),
      })),
      fields: tinfo.fields ?? [],
      // Strip SurrealDB's materialized vector/fulltext defaults so the spec matches the authored form.
      indexes: (tinfo.indexes ?? []).map((i) => ({
        ...i,
        index: normalizeIndexSpec(i.index),
      })),
      kind: {
        enforced: t.kind.enforced,
        in: t.kind.in?.map(endpointName),
        kind: t.kind.kind,
        out: t.kind.out?.map(endpointName),
      },
      name: t.name,
      permissions: t.permissions,
      schemafull: t.schemafull,
      // INFO STRUCTURE stores a view as `AS SELECT …`; strip the keyword to match the lowered form.
      view: t.view?.replace(/^AS\s+/iu, ""),
    })
  }
  const num = (v: number | string | undefined): number | undefined =>
    v === undefined ? undefined : Number(v)
  return {
    accesses: dbInfo.accesses ?? [],
    analyzers: dbInfo.analyzers ?? [],
    functions: dbInfo.functions ?? [],
    params: dbInfo.params ?? [],
    sequences: (dbInfo.sequences ?? []).map((s) => ({
      name: s.name,
      ...(s.batch === undefined ? {} : { batch: num(s.batch) }),
      ...(s.start === undefined ? {} : { start: num(s.start) }),
      ...(s.timeout === undefined ? {} : { timeout: s.timeout }),
    })),
    tables,
  }
}
