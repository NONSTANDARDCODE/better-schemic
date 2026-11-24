import { existsSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import type { Surreal } from "surrealdb"

import type { ResolvedConfig } from "../../core"
import {
  type Filter,
  loadDefs,
  type LocalOnly,
  mergeUnits,
  parseFilter,
  type PullFilePlan,
  type PullPlan,
  type RenderedUnit,
} from "../../core"
import { stripNullGuard } from "../ddl"
import { formatForAssert, readsClientValue } from "../pure"
import { splitTopUnion, topLevelSplitOnce } from "../surql-type-expr"

import { formatSurql } from "./format"
import {
  type DbStructured,
  introspectStructured,
  type StructAccess,
  type StructAnalyzer,
  type StructField,
  type StructFunction,
  type StructParam,
  type StructPerm,
  type StructPermissions,
  type StructSequence,
  type StructTable,
} from "./structure"
import { filterStructured } from "./surreal-filter"

/** The field clauses pull reverses into `s.*` chains (sourced from `INFO … STRUCTURE`). */
type ParsedField = {
  assert?: string
  comment?: string
  computed?: string
  default?: string
  defaultAlways?: boolean
  flexible?: boolean
  permissions?: StructPermissions
  readonly?: boolean
  /** `REFERENCE [ON DELETE …]` on a record-link field (mirrors `StructField.reference`). */
  reference?: { on_delete?: string }
  type: string
  value?: string
}

/** A single permission op as a `.permissions()` argument value (`true`/`false`/a `surql` WHERE). */
function permValue(v: StructPerm | undefined): string {
  if (v === true) return "true"

  if (v === false || v === undefined) return "false"

  return `surql\`${v}\``
}

/**
 * The `.permissions(...)` / `.$permissions(...)` argument for a structured permission set, or null
 * to omit it (when it matches the default: FULL for fields, NONE for tables). Collapses all-FULL →
 * `true`, all-NONE → `false`, and one shared `WHERE` across every op → a single `surql` expr.
 */
function renderPerms(
  perms: StructPermissions | undefined,
  ops: (keyof StructPermissions)[],
  defaultFull: boolean,
): null | string {
  if (!perms) return null

  const vals = ops.map((op) => perms[op])
  const allTrue = vals.every((v) => v === true)
  const allFalse = vals.every((v) => v === false || v === undefined)
  if (defaultFull ? allTrue : allFalse) return null
  // matches the default
  if (allTrue) return "true"

  if (allFalse) return "false"

  if (vals.every((v) => typeof v === "string") && new Set(vals).size === 1)
    return `surql\`${vals[0]}\`` // one WHERE shared by every op

  return `{ ${ops.map((op) => `${op}: ${permValue(perms[op])}`).join(", ")} }`
}

/**
 * The bare field path — STRUCTURE backtick-escapes reserved-word segments (`` `value` ``), so we
 * strip them; `ident()` re-quotes what TS needs, and emit re-escapes for SurrealQL (avoids
 * double-escaping the name).
 */
function unescapeName(name: string): string {
  return name
    .split(".")
    .map((seg) => seg.replace(/^`([\s\S]*)`$/u, "$1"))
    .join(".")
}

/** Map a structured field (from STRUCTURE) to the clause bag `renderField` consumes. */
function toParsed(f: StructField): ParsedField {
  return {
    assert: f.assert,
    comment: f.comment,
    computed: f.computed,
    default: f.default,
    defaultAlways: f.default_always,
    flexible: f.flexible,
    permissions: f.permissions,
    readonly: f.readonly,
    reference: f.reference,
    type: f.kind,
    value: f.value,
  }
}

// --- Cross-table reference resolution (imports / self-refs / relation endpoints) -------------

const pascal = (name: string) =>
  name
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- retorno any vem de parser/SDK dinâmico; contrato externo não tipado / método any vem de internals do Zod/SDK (fronteira sem tipos) / acesso dinâmico na fronteira Zod/SDK; o valor vem de any externo
    .replaceAll(/(^|[_-])([a-z])/gu, (_, __, c) => c.toUpperCase())
    .replaceAll(/[^A-Za-z0-9]/gu, "")

/**
 * SECURITY: DB-controlled names untrust them (a hostile/compromised database can contain any
 * character inside `⟨…⟩`). These helpers keep generated code + file paths inert:
 *
 * - `safeFileName` — a filesystem-safe stem: no separators, no `..`, no leading dot, no control
 * chars. `pull` file planning uses it so a table named `../../evil` can't escape the schema dir.
 * - `safeConst` — an identifier stem that always starts with a letter/`_`/`$`, so a const name can
 * never inject statements into the generated module.
 * - `surqlBody` — escapes text embedded inside a generated `surql\`…\`` template literal, so a
 * backtick/`${` in a DB expression can't end the template and execute as TS.
 * - `commentText` — collapses newlines in `//` comments (a newline would turn the rest into code).
 */
function safeFileName(name: string): string {
  let out = ""
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers, unicorn/number-literal-case -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset) / Prettier e unicorn discordam sobre a caixa dos dígitos hexadecimais
    out += ch === "/" || ch === "\\" || code < 0x20 || code === 0x7f ? "_" : ch
  }
  const cleaned = out.replace(/^\.+/u, "_")
  return cleaned || "_"
}

function safeConst(name: string): string {
  const id = pascal(name) || name.replaceAll(/[^A-Za-z0-9_$]/gu, "_")
  return /^[A-Za-z_$]/u.test(id) ? id : `T_${id || "unnamed"}`
}

function surqlBody(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

function commentText(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
  return text.replaceAll(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 500)
}

/** All `record<…>` target table names in a type expression (handles option/array/union nesting). */
function recordTargets(kind: string): string[] {
  const out: string[] = []
  const re = /record<([^>]+)>/gu
  let m: null | RegExpExecArray = re.exec(kind)
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (m) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const t of m[1].split("|")) out.push(t.trim())

    m = re.exec(kind)
  }
  return out
}

/** The pulled tables a table points at: `record<…>` field targets + relation endpoints. */
function tableRefs(t: StructTable, pulled: Set<string>): Set<string> {
  const out = new Set<string>()
  const add = (n: string) => {
    if (pulled.has(n)) out.add(n)
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const f of t.fields) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const tgt of recordTargets(f.kind)) add(tgt)
  }
  if (t.kind.kind === "RELATION") {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const n of t.kind.in ?? []) add(n)

    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const n of t.kind.out ?? []) add(n)
  }
  return out
}

/** Everything reachable from `start` in the reference graph (excluding `start` itself). */
function reachable(graph: Map<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [...(graph.get(start) ?? [])]
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  while (stack.length > 0) {
    const n = stack.pop()
    if (n === undefined || seen.has(n)) continue

    seen.add(n)
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const m of graph.get(n) ?? []) stack.push(m)
  }
  return seen
}

/** How a `record<target>` / endpoint reference should expresss it in the generated code. */
type RefKind = "direct" | "self" | "string"

/** Per-table render context: resolves references and accumulates the imports they need. */
type RenderCtx = {
  /** Whether the `self` callback is available (`table`, not `relation`). */
  allowSelf: boolean
  /** PascalCase const name for a table. */
  constOf: (name: string) => string
  /** Imported table names (→ value imports of their `const`). */
  imports: Set<string>
  /** Resolve a reference from this table to `target`. */
  resolve: (target: string) => RefKind
  table: string
  /** Set when a `record<self>` field used the callback `self` parameter. */
  usesSelf: boolean
}

function makeResolver(graph: Map<string, Set<string>>, pulled: Set<string>) {
  const cache = new Map<string, Set<string>>()
  const reach = (n: string) => {
    let r = cache.get(n)
    if (!r) {
      r = reachable(graph, n)
      cache.set(n, r)
    }
    return r
  }
  return (from: string, target: string): RefKind => {
    if (target === from) return "self"

    if (!pulled.has(target)) return "string"
    // not pulled — can't import it
    return reach(target).has(from) ? "string" : "direct" // cycle → string, else import
  }
}

/** Parse a SurrealQL literal token (`'a'`, `"a"`, `42`, `true`) to its JS value, else null. */
function parseLiteral(s: string): null | { value: boolean | number | string } {
  const t = s.trim()
  const q = /^'((?:\\.|[^'])*)'$/u.exec(t) ?? /^"((?:\\.|[^"])*)"$/u.exec(t)
  if (q) return { value: q[1] }

  if (/^-?\d+$/u.test(t)) return { value: Number.parseInt(t, 10) }

  if (/^-?\d+\.\d+$/u.test(t)) return { value: Number.parseFloat(t) }

  if (t === "true" || t === "false") return { value: t === "true" }

  return null
}

/** Render a `record<…>` reference, using imports / `self` / a string fallback per `ctx`. */
function renderRecord(targetsRaw: string, ctx?: RenderCtx): string {
  const targets = targetsRaw.split("|").map((s) => s.trim())
  if (ctx && targets.length === 1) {
    const kind = ctx.resolve(targets[0])
    if (kind === "self" && ctx.allowSelf) {
      ctx.usesSelf = true
      return "self"
    }
    if (kind === "direct") {
      ctx.imports.add(targets[0])
      return `${ctx.constOf(targets[0])}.record()`
    }
  }
  const arg =
    targets.length === 1
      ? JSON.stringify(targets[0])
      : `[${targets.map((t) => JSON.stringify(t)).join(", ")}]`
  return `s.recordId(${arg})`
}

/**
 * The EXACT size of a container base type (`array<T, N>` / `set<T, N>`), or null when the type is
 * bare/variably sized. Drives `.length(N)`/`.size(N)` when the `.*` element branch renders the
 * container (`szType` handles the no-element case).
 */
function exactContainerSize(base: string): null | { kw: "array" | "set"; n: string } {
  const m = /^(array|set)<([\s\S]+)>$/u.exec(base.trim())
  if (!m) return null

  const comma = topLevelSplitOnce(m[2], ",")
  if (!comma || !/^\d+$/u.test(comma[1].trim())) return null

  return { kw: m[1] as "array" | "set", n: comma[1].trim() }
}

/**
 * Map a SurrealQL type to an `s.*` expression (`ctx` resolves `record<…>` references).
 */
function szType(type: string, ctx?: RenderCtx): string {
  const t = type.trim()
  // option<X> and the `none | X` form the DB reports.
  const opt = /^option<(.+)>$/u.exec(t)
  if (opt) return `${szType(opt[1], ctx)}.optional()`

  if (/(^|\|)\s*none\s*(\||$)/u.test(t)) {
    const inner = t.replaceAll(/\s*\|?\s*none\s*\|?\s*/gu, "").trim()
    return `${szType(inner || "any", ctx)}.optional()`
  }
  const nullable = /^(.+?)\s*\|\s*null$/u.exec(t)
  if (nullable) return `${szType(nullable[1], ctx)}.nullable()`

  // array<T, N> is EXACT N: re-author it with Zod's `.length(N)` (which inferField reads back as
  // `length_equals` → `array<T, N>`); a bare `array<T>` keeps `.array()`.
  const arr = /^array<(.+)>$/u.exec(t)
  if (arr) {
    const sized = topLevelSplitOnce(arr[1], ",")
    return sized
      ? `${szType(sized[0], ctx)}.array().length(${sized[1].trim()})`
      : `${szType(arr[1], ctx)}.array()`
  }
  // set<T, N> is EXACT N too: re-author with Zod's `.size(N)` (`size_equals` → `set<T, N>`).
  const set = /^set<(.+)>$/u.exec(t)
  if (set) {
    const sized = topLevelSplitOnce(set[1], ",")
    const inner = szType(sized ? sized[0] : set[1], ctx)
    return sized ? `s.set(${inner}).size(${sized[1].trim()})` : `s.set(${inner})`
  }
  const rec = /^record<(.+?)>$/u.exec(t)
  if (rec) return renderRecord(rec[1], ctx)

  // Literal unions: `'a' | 'b'` -> s.enum (all strings) or a union of literals; lone -> s.literal.
  const lits = splitTopUnion(t).map(parseLiteral)
  if (lits.length > 0 && lits.every((l) => l !== null)) {
    const vals = lits.map((l) => l.value)
    if (vals.length === 1) return `s.literal(${JSON.stringify(vals[0])})`

    if (vals.every((v) => typeof v === "string"))
      return `s.enum([${vals.map((v) => JSON.stringify(v)).join(", ")}])`

    return `s.union([${vals.map((v) => `s.literal(${JSON.stringify(v)})`).join(", ")}])`
  }

  // Native types carrying a `<kind>` parameter (e.g. `geometry<point>`).
  const geo = /^geometry(?:<(\w+)>)?$/u.exec(t)
  if (geo) return geo[1] ? `s.geometry(${JSON.stringify(geo[1])})` : "s.geometry()"

  switch (t) {
    case "string":
      return "s.string()"
    case "file":
      return "s.file()"
    case "int":
      return "s.int()"
    case "float":
      return "s.float()"
    case "number":
      return "s.number()"
    case "bool":
      return "s.boolean()"
    case "datetime":
      return "s.datetime()"
    case "uuid":
      return "s.uuid()"
    case "decimal":
      return "s.decimal()"
    case "duration":
      return "s.duration()"
    case "bytes":
      return "s.bytes()"
    case "range":
      return "s.range()"
    case "object":
      return "s.object({})"
    case "any":
      return "s.any()"
    default:
      return `s.any() /* ${t} */`
  }
}

type FieldNode = {
  children: Map<string, FieldNode>
  parsed?: ParsedField
}

/** Build a nested tree from dotted field paths (`settings.theme`, `tags.*`). */
function fieldTree(fields: { name: string; parsed: ParsedField }[]): FieldNode {
  const root: FieldNode = { children: new Map() }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const f of fields) {
    let node = root
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const seg of f.name.split(".")) {
      let child = node.children.get(seg)
      if (!child) {
        child = { children: new Map() }
        node.children.set(seg, child)
      }
      node = child
    }
    node.parsed = f.parsed
  }
  return root
}

/**
 * Strip optionality/nullability wrappers, reporting which were present. Handles both
 * `option<X>` and the `X | none` form SurrealDB's `INFO` reports, plus `X | null`.
 */
function unwrapType(type: string): {
  base: string
  nullable: boolean
  optional: boolean
} {
  let t = type.trim()
  let optional = false
  let nullable = false
  const opt = /^option<(.+)>$/u.exec(t)
  if (opt) {
    optional = true
    t = opt[1].trim()
  }
  // `X | none` / `none | X` — SurrealDB's normalized form of `option<X>`.
  if (/(^|\|)\s*none\s*(\||$)/u.test(t)) {
    optional = true
    t = t.replaceAll(/\s*\|?\s*none\s*\|?\s*/gu, "").trim()
  }
  const nul = /^(.+?)\s*\|\s*null$/u.exec(t)
  if (nul) {
    nullable = true
    t = nul[1].trim()
  }
  return { base: t, nullable, optional }
}

/** Render an `s.*` expression for a field node, recursing into nested objects/array elements. */
function renderField(node: FieldNode, indent: string, ctx?: RenderCtx): string {
  const p = node.parsed
  const objChildren = [...node.children].filter(([k]) => k !== "*")
  const star = node.children.get("*")
  const wrap = p ? unwrapType(p.type) : null
  // A NULL-guarded assert (`$value = NULL OR …`) is machine-generated for a nullable field: the
  // declared `| null` type already carries the nullability and the emitter re-adds the guard, so
  // reverse it here. Leaving it would stack a SECOND guard on the next emit (phantom diff).
  const assertText =
    p?.assert !== undefined && wrap?.nullable ? stripNullGuard(p.assert) : p?.assert
  // A `string` field whose ASSERT is a baked `string::is_<fmt>($value)` round-trips back to
  // the format builder (`s.email()`, …) — the assert is the signal, and it's dropped below
  // since the builder re-bakes it. Combined/extra asserts don't match, so they stay `string` + assert.
  const fmt = assertText === undefined ? undefined : formatForAssert(assertText)
  let expr: string
  if (p && wrap?.base === "object") {
    // Rebuild s.object from dotted children (empty if none) — even when wrapped in
    // option<…>/| null, so optional/nullable/flexible nested objects keep their shape.
    const inner =
      objChildren.length > 0
        ? `{\n${objChildren
            .map(([k, c]) => `${indent}  ${ident(k)}: ${renderField(c, `${indent}  `, ctx)},`)
            .join("\n")}\n${indent}}`
        : "{}"
    expr = `s.object(${inner})`
    if (p.flexible) expr += ".loose()"
    // FLEXIBLE — accepts arbitrary keys
    if (wrap.nullable) expr += ".nullable()"

    if (wrap.optional) expr += ".optional()"
  } else if (p && star && /^(array|set)\b/u.test(wrap?.base ?? "")) {
    // Any array/set: the element's full structure (incl. nested sub-fields) lives in the `*`
    // child — fold it into `<elem>.array()` / `s.set(<elem>)`. This beats parsing the element
    // type from the parent kind, which would lose the element's sub-fields. The parent's EXACT
    // size (`array<T, N>`/`set<T, N>`, always present in INFO) rides along as `.length(N)`/`.size(N)`.
    const elem = renderField(star, indent, ctx)
    const size = exactContainerSize(wrap?.base ?? "")
    expr = /^set\b/u.test(wrap?.base ?? "")
      ? `s.set(${elem})${size?.kw === "set" ? `.size(${size.n})` : ""}`
      : `${elem}.array()${size?.kw === "array" ? `.length(${size.n})` : ""}`

    // FLEXIBLE on an `array<object>` rides the array FIELD (the `.*` element stays plain object), so
    // `.loose()` here descends to loosen the element again on the next emit — re-emitting FLEXIBLE.
    if (p.flexible) expr += ".loose()"

    if (wrap?.nullable) expr += ".nullable()"

    if (wrap?.optional) expr += ".optional()"
  } else if (p && wrap?.base === "string" && fmt) {
    expr = `s.${fmt}()`
    if (wrap.nullable) expr += ".nullable()"

    if (wrap.optional) expr += ".optional()"
  } else if (p) expr = szType(p.type, ctx)
  else expr = "s.any()"

  if (p) {
    // `REFERENCE [ON DELETE …]` on a record-link field. A bare reference (or the materialized default
    // `IGNORE`) round-trips as `.$reference()`; an action keyword as `{ onDelete: '<kw>' }`; anything
    // else (a `surql` expression) as `{ onDelete: surql\`…\` }`. Mirrors `canonicalField` in structure.ts.
    if (p.reference !== undefined) {
      const od = p.reference.on_delete
      if (!od || od.toUpperCase() === "IGNORE") expr += ".$reference()"
      else if (/^(REJECT|CASCADE|UNSET)$/iu.test(od))
        expr += `.$reference({ onDelete: ${JSON.stringify(od.toLowerCase())} })`
      else expr += `.$reference({ onDelete: surql\`${surqlBody(od)}\` })`
    }
    if (p.default !== undefined) {
      // A bare literal (false/42/"x") round-trips as a plain JS value the `s` API accepts directly;
      // non-literal expressions (time::now(), …) need the `surql` tag. Wrapping literals in
      // `surql` would churn hand-authored `.$default(false)` into `.$default(surql\`false\`)`.
      const method = p.defaultAlways ? "$defaultAlways" : "$default"
      const lit = parseLiteral(p.default)
      expr += `.${method}(${lit ? JSON.stringify(lit.value) : `surql\`${surqlBody(p.default)}\``})`
    }
    if (p.value !== undefined) {
      // A VALUE that reads `$value` consumes client input; DDL cannot say whether the field is
      // required on create, so pull declares the permissive side EXPLICITLY — the `$value`
      // authoring guard demands a choice, and create-optional is the honest DDL- reading.
      const opt = readsClientValue(p.value) ? ", { optional: true }" : ""
      expr += `.$value(surql\`${surqlBody(p.value)}\`${opt})`
    }
    if (p.computed !== undefined) expr += `.$computed(surql\`${surqlBody(p.computed)}\`)`

    // The format builder re-bakes its `string::is_<fmt>` assert, so drop it when we reversed one.
    if (assertText !== undefined && assertText !== "" && !fmt)
      expr += `.$assert(surql\`${surqlBody(assertText)}\`)`

    if (p.readonly) expr += ".$readonly()"

    if (p.comment) expr += `.$comment(${JSON.stringify(p.comment)})`

    const perm = renderPerms(p.permissions, ["select", "create", "update"], true)
    if (perm) expr += `.$permissions(${perm})`
  }
  return expr
}

/** A safe object-key: a bare identifier, or a quoted string. */
function ident(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key)
}

/** Resolve a relation endpoint set to `.from`/`.to` args (imported consts) — or null if any can't be. */
function wireEndpoints(names: string[], ctx: RenderCtx): null | string {
  if (names.length === 0) return null

  const resolved = names.map((n) => {
    const kind = ctx.resolve(n)
    if (kind === "direct") {
      ctx.imports.add(n)
      return ctx.constOf(n)
    }
    if (kind === "self") return ctx.constOf(ctx.table)

    return null // not pulled / cyclic → can't pass a string to .from/.to
  })
  if (resolved.some((r) => r === null)) return null

  return resolved.length === 1 ? resolved[0] : `[${resolved.join(", ")}]`
}

/**
 * A vector/full-text index spec (canonical/minimal form) -> the `.index()` opts fragment, e.g.
 * `HNSW DIMENSION 4 DIST COSINE` -> `hnsw: { dimension: 4, dist: "cosine" }`. Returns null for a
 * plain/UNIQUE/COUNT spec (those handl them separately).
 */
function indexSpecOpts(spec: string): null | string {
  if (spec.startsWith("HNSW ") || spec.startsWith("DISKANN ")) {
    const algo = spec.startsWith("HNSW") ? "hnsw" : "diskann"
    const toks = spec.split(/\s+/u).slice(1)
    const kv: Record<string, string> = {}
    // eslint-disable-next-line functional/no-loop-statements, @typescript-eslint/no-magic-numbers -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (let i = 0; i < toks.length; i += 2) kv[toks[i]] = toks[i + 1] ?? ""

    const f: string[] = [`dimension: ${kv.DIMENSION}`]
    if (kv.DIST) f.push(`dist: ${JSON.stringify(kv.DIST.toLowerCase())}`)

    if (kv.TYPE) f.push(`type: ${JSON.stringify(kv.TYPE.toLowerCase())}`)

    if (kv.EFC) f.push(`efc: ${kv.EFC}`)

    if (kv.M) f.push(`m: ${kv.M}`)

    if (kv.DEGREE) f.push(`degree: ${kv.DEGREE}`)

    if (kv.L_BUILD) f.push(`l_build: ${kv.L_BUILD}`)

    if (kv.ALPHA) f.push(`alpha: ${kv.ALPHA}`)

    return `${algo}: { ${f.join(", ")} }`
  }
  const ft = /^FULLTEXT(?:\s+ANALYZER\s+(\S+))?(.*)$/u.exec(spec)
  if (ft) {
    const f: string[] = []
    if (ft[1]) f.push(`analyzer: ${JSON.stringify(ft[1])}`)
    // omitted -> SurrealDB's `like` default
    // a tuned BM25 survives canonicalization (the default stripps it) -> render the tuple.
    const bm = /BM25\(([^)]*)\)/u.exec(ft[2])
    if (bm) {
      const [k, b] = bm[1].split(",").map((x) => x.trim())
      f.push(`bm25: [${k}, ${b}]`)
    }
    if (/\bHIGHLIGHTS\b/u.test(ft[2])) f.push("highlights: true")

    return f.length > 0 ? `fulltext: { ${f.join(", ")} }` : "fulltext: {}"
  }
  return null
}

/** Render the `export const … = define…(…);` for one table (no import lines). */
function renderTableConst(t: StructTable, ctx: RenderCtx): { code: string; factory: string } {
  // A pre-computed VIEW: `defineView(name).as(surql\`SELECT …\`)` — shapeless (the projection types
  // aren't in INFO), then the common table config (comment / permissions); TYPE ANY + SCHEMALESS
  // impli them by defineView.
  if (t.view !== undefined) {
    let code = `export const ${ctx.constOf(t.name)} = defineView(${JSON.stringify(t.name)}).as(surql\`${surqlBody(t.view)}\`)`
    if (t.comment) code += `\n  .comment(${JSON.stringify(t.comment)})`

    const vperm = renderPerms(t.permissions, ["select", "create", "update", "delete"], false)
    if (vperm) code += `\n  .permissions(${vperm})`

    return { code: `${code};`, factory: "defineView" }
  }

  const isRelation = t.kind.kind === "RELATION"
  const fields = t.fields.map((f) => ({
    name: unescapeName(f.name),
    parsed: toParsed(f),
  }))
  const tree = fieldTree(fields)
  const fieldLines = [...tree.children]
    // `id` is always implicit (re-added below for tables). `in`/`out` are the implicit endpoints of a
    // RELATION (rendered via `.from()`/`.to()`) — but on a NORMAL table they're ordinary fields a user
    // may have named `in`/`out` (e.g. `DEFINE FIELD in ON order TYPE record<person>`), so keep them.
    .filter(([k]) => k !== "id" && (!isRelation || (k !== "in" && k !== "out")))
    .map(([k, node]) => `  ${ident(k)}: ${renderField(node, "  ", ctx)},`)
    .join("\n")

  // A LITERAL-typed id (`'default'`) marks a SINGLETON table — regenerate defineSingleton.
  const idField = t.fields.find((f) => f.name === "id")
  const singletonId = idField ? /^'(.*)'$/u.exec(idField.kind)?.[1] : undefined

  const name = ctx.constOf(t.name)
  // eslint-disable-next-line unicorn/no-nested-ternary -- Prettier remove os parênteses exigidos pela regra; a expressão encadeada é mais legível que if/else aqui
  const factory = isRelation ? "relation" : singletonId === undefined ? "table" : "defineSingleton"
  // A `record<self>` field needs the callback shape so `self` is in scope.
  const head = ctx.usesSelf
    ? `export const ${name} = ${factory}(${JSON.stringify(t.name)}, (self) => ({`
    : `export const ${name} = ${factory}(${JSON.stringify(t.name)}, {`
  const shapeClose = ctx.usesSelf ? "})" : "}"
  // A non-default singleton key rides the opts argument.
  const open =
    singletonId !== undefined && singletonId !== "default"
      ? `${shapeClose}, { id: ${JSON.stringify(singletonId)} })`
      : `${shapeClose})`

  const body: string[] = [head]
  if (!isRelation && singletonId === undefined) body.push(`  id: s.string(),`)

  body.push(fieldLines)

  let close = open
  if (isRelation) {
    const from = wireEndpoints(t.kind.in ?? [], ctx)
    const to = wireEndpoints(t.kind.out ?? [], ctx)
    if (from) close += `\n  .from(${from})`

    if (to) close += `\n  .to(${to})`

    if (t.kind.enforced) close += `\n  .enforced()`
  } else if (t.kind.kind === "ANY") close += `\n  .typeAny()`

  // Common table config (applies to tables and relations alike).
  if (!t.schemafull) close += `\n  .schemaless()`

  if (t.drop) close += `\n  .drop()`

  if (t.comment) close += `\n  .comment(${JSON.stringify(t.comment)})`

  const tperm = renderPerms(t.permissions, ["select", "create", "update", "delete"], false)
  if (tperm) close += `\n  .permissions(${tperm})`

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const idx of t.indexes) {
    const cols = idx.cols.map((c) => JSON.stringify(c)).join(", ")
    const parts: string[] = []
    if (idx.index === "UNIQUE") parts.push("unique: true")
    else if (idx.index === "COUNT") parts.push("count: true")
    else {
      const so = indexSpecOpts(idx.index) // HNSW/DISKANN/FULLTEXT -> hnsw/diskann/fulltext opts
      if (so) parts.push(so)
    }
    if (idx.comment !== undefined) parts.push(`comment: ${JSON.stringify(idx.comment)}`)

    const opts = parts.length > 0 ? `, { ${parts.join(", ")} }` : ""
    close += `\n  .index(${JSON.stringify(idx.name)}, [${cols}]${opts})`
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const ev of t.events) {
    // Drop a `WHEN true` (SurrealDB's stored form of an omitted WHEN). Author bodies as `surql\`…\``.
    const when =
      ev.when !== undefined && ev.when !== "true" ? `when: ${tpl(ev.when, "    ")}, ` : ""
    const then =
      ev.then.length === 1
        ? tpl(ev.then[0], "    ")
        : `[${ev.then.map((e) => tpl(e, "    ")).join(", ")}]`
    // `async`: drop the materialized retry=1/maxdepth=3 defaults — a bare ASYNC regenerates as `true`,
    // otherwise the non-default knobs keep them.
    let asyncOpt = ""
    if (ev.async) {
      const knobs = [
        ev.retry !== undefined && ev.retry !== 1 ? `retry: ${ev.retry}` : "",
        // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
        ev.maxdepth !== undefined && ev.maxdepth !== 3 ? `maxDepth: ${ev.maxdepth}` : "",
      ].filter(Boolean)
      asyncOpt = `async: ${knobs.length > 0 ? `{ ${knobs.join(", ")} }` : "true"}, `
    }
    const comment = ev.comment === undefined ? "" : `, comment: ${JSON.stringify(ev.comment)}`
    // A formatted (multi-line) body gets the expanded object layout; short events stay inline.
    if (then.includes("\n") || when.includes("\n")) {
      const entries = [
        asyncOpt.replace(/, $/u, ""),
        when.replace(/, $/u, ""),
        `then: ${then}`,
        comment.replace(/^, /u, ""),
      ].filter(Boolean)
      close += `\n  .event(${JSON.stringify(ev.name)}, {\n    ${entries.join(",\n    ")},\n  })`
    } else
      close += `\n  .event(${JSON.stringify(ev.name)}, { ${asyncOpt}${when}then: ${then}${comment} })`
  }
  body.push(`${close};`)

  return { code: body.join("\n"), factory }
}

/** Assemble a single-object module (imports + the const) for the directory layout. */
function unitModule(u: RenderedUnit): string {
  return `${u.imports.join("\n")}\n\n${u.code}\n`
}

/** The rendered unit (const statement + the imports it needs) for one table/relation. */
function tableUnit(t: StructTable, ctx: RenderCtx): RenderedUnit {
  const { code, factory } = renderTableConst(t, ctx)
  // A view's code uses no `s.*` builder — import the factory then (avoids an unused `s` import).
  const needsS = t.view === undefined && code.includes("s.")
  const imports = [`import { ${needsS ? "s, " : ""}${factory} } from "better-schemic";`]
  // Cross-table value imports (one per referenced table, sorted, self excluded).
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const dep of [...ctx.imports].filter((d) => d !== t.name).sort())
    imports.push(`import { ${ctx.constOf(dep)} } from "./${safeFileName(dep)}";`)

  // `surql` lives in surrealdb (where hand-authored files import it from) — a separate line, never
  // folded into the better-schemic import (which would reprint/reorder that import on every pull).
  if (code.includes("surql`")) imports.push(`import { surql } from "surrealdb";`)

  return {
    code,
    exportName: ctx.constOf(t.name),
    imports,
    kind: "table",
    name: t.name,
  }
}

/** A `surql\`…\`` template with FORMATTED content (statement-per-line, indented blocks — see
 *  {@link formatSurql}); continuation lines re-indent to `base` so the template sits naturally in
 * the generated chain. Single-line results stay. */
function tpl(text: string, base: string): string {
  const fmt = formatSurql(text)
  if (!fmt.includes("\n")) return `surql\`${surqlBody(fmt)}\``

  const body = fmt
    .split("\n")
    .map((l, i) => (i === 0 ? l : base + l))
    .join("\n")
  return `surql\`${surqlBody(body)}\``
}

/** A const name for a function — `fn.name` sanitized to an identifier (`math::add` → `math_add`). */
function fnConst(name: string): string {
  const id = name.replaceAll(/[^A-Za-z0-9]+/gu, "_").replaceAll(/^_+|_+$/gu, "")
  return /^[A-Za-z]/u.test(id) ? id : `fn_${id}`
}

/** Reverse a `StructFunction` into a `defineFunction(name, args).returns(…).body(…)…` const. */
function renderFunctionConst(fn: StructFunction): string {
  const args = fn.args.map(([n, t]) => `${ident(n)}: ${szType(t)}`).join(", ")
  let code = `export const ${fnConst(fn.name)} = defineFunction(${JSON.stringify(fn.name)}, { ${args} })`
  if (fn.returns !== undefined) code += `\n  .returns(${szType(fn.returns)})`

  code += `\n  .body(${tpl(fn.block, "  ")})`
  if (fn.permissions === false) code += `\n  .permissions(false)`
  else if (typeof fn.permissions === "string")
    code += `\n  .permissions(${tpl(fn.permissions, "  ")})`

  if (fn.comment !== undefined) code += `\n  .comment(${JSON.stringify(fn.comment)})`

  return `${code};`
}

/** Reverse a `StructAccess` into a `defineAccess(name).<type>(…)…` const. Signing keys are NOT recovered. */
function renderAccessConst(a: StructAccess): string {
  const k = a.kind
  const v = k.jwt?.verify
  // A signing key is present (and redacted) for everything except JWT-via-JWKS-URL.
  const hasRedactedKey = !(k.kind === "JWT" && v?.url)
  const lines: string[] = []
  if (hasRedactedKey)
    lines.push("// NOTE: signing key not pulled (SurrealDB redacts it) — re-applying rotates it.")

  // Introspected accesses are database-scoped (canonical is ON DATABASE), so regenerate `.onDatabase()`.
  let head = `export const ${fnConst(a.name)} = defineAccess(${JSON.stringify(a.name)}).onDatabase()`
  if (k.kind === "BEARER")
    head += `\n  .bearer({ for: ${JSON.stringify((k.subject ?? "record").toLowerCase())} })`
  else if (k.kind === "JWT") {
    head += v?.url
      ? `\n  .jwt({ url: ${JSON.stringify(v.url)} })`
      : `\n  .jwt({ alg: ${JSON.stringify(v?.alg ?? "HS512")} /* key not pulled */ })`
  } else head += `\n  .record()`

  lines.push(head)
  if (k.kind === "RECORD") {
    if (k.signup) lines.push(`  .signup(${tpl(k.signup, "  ")})`)

    if (k.signin) lines.push(`  .signin(${tpl(k.signin, "  ")})`)

    if (k.refresh) lines.push("  .withRefresh()")

    if (k.authenticate) lines.push(`  .authenticate(${tpl(k.authenticate, "  ")})`)
  }
  const d = a.duration
  if (d?.grant || d?.token || d?.session) {
    const obj = [
      d.grant && `grant: ${JSON.stringify(d.grant)}`,
      d.token && `token: ${JSON.stringify(d.token)}`,
      d.session && `session: ${JSON.stringify(d.session)}`,
    ]
      .filter(Boolean)
      .join(", ")
    lines.push(`  .duration({ ${obj} })`)
  }
  if (a.comment) lines.push(`  .comment(${JSON.stringify(a.comment)})`)

  return `${lines.join("\n")};`
}

/** Topologically sort so a table comes after every same-file table it references (deps first). */
function topoSort<T extends { deps: string[]; name: string }>(items: T[]): T[] {
  const byName = new Map(items.map((it) => [it.name, it]))
  const out: T[] = []
  const done = new Set<string>()
  const onStack = new Set<string>()
  const visit = (it: T) => {
    if (done.has(it.name) || onStack.has(it.name)) return

    onStack.add(it.name)
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const dep of it.deps) {
      const d = byName.get(dep)
      if (d) visit(d)
    }
    onStack.delete(it.name)
    done.add(it.name)
    out.push(it)
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const it of items) visit(it)

  return out
}

const EMPTY_LOCAL: LocalOnly = { fields: [], objects: [] }

/**
 * Build the per-file pull plan: introspect the live DB (via `INFO … STRUCTURE`) and compute what
 * each schema file would become. Nothing writes it — {@link applyPull} does that. Existing files
 * are *merged* (the DB wins per object/field, but unrelated code, comments, and local- content
 * survive); new files creat them. `keepLocal` keeps local- fields/objects instead of mirroring.
 */
export async function planPull(
  db: Surreal,
  config: ResolvedConfig,
  opts: { filter?: Filter; keepLocal?: boolean } = {},
): Promise<PullPlan> {
  const introspected = await introspectStructured(
    db,
    new Set([config.migrationsTable, `${config.migrationsTable}_lock`]),
  )
  const filtered = filterStructured(introspected, opts.filter ?? parseFilter({}))
  const { accesses, analyzers, functions, sequences = [], tables } = filtered
  // ONE schema load feeds the SECRET GUARD, the table→file map AND the per-file entity scan
  // (three full import passes). SurrealDB returns param values READABLY — rendering a
  // live param that the schema authors as secret/declared (out-of-band) would write its VALUE into
  // source. Drop those from the pull; their defs stay as authored. FAIL CLOSED: when the schema
  // can't loads it we can't tell which params are secret-bearing, so NO param pulls it (never
  // leak a live value).
  let oob: Set<string> | undefined
  const tableLoc = new Map<string, string>()
  let loaded: Awaited<ReturnType<typeof loadDefs>> | undefined
  let loadError: unknown
  try {
    loaded = await loadDefs(config.schemaPath)
    oob = new Set(
      loaded.defs
        .filter(
          (d) =>
            (d as { kind?: string }).kind === "param" &&
            (d as { config?: { mode?: string } }).config?.mode !== "value",
        )
        .map((d) => (d as { name: string }).name),
    )
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const t of loaded.tables) {
      const file = loaded.fileOf.get(t)
      if (file) tableLoc.set(t.name, file)
    }
  } catch (error) {
    oob = undefined
    loadError = error
  }
  const params = oob === undefined ? [] : filtered.params.filter((p) => !oob.has(p.name))

  const makeCtx = ctxFactory(tables)
  const keepLocal = opts.keepLocal ?? false

  // Single-file layout: one combined module.
  if (config.schemaIsFile) {
    const units = [
      ...tables.map((t) => tableUnit(t, makeCtx(t))),
      ...functions.map(functionUnit),
      ...accesses.map(accessUnit),
      ...analyzers.map(analyzerUnit),
      ...params.map(paramUnit),
      ...sequences.map(sequenceUnit),
    ]
    return {
      files: [
        planFile(config.schemaPath, units, keepLocal, config, () =>
          assembleCombined({ accesses, analyzers, functions, params, sequences, tables }, makeCtx),
        ),
      ],
      root: config.root,
    }
  }

  // Directory layout: one file per object, merged into wherever the object already lives (falling
  // back to its kind folder). A table the user keeps in some other file updates it there, in place.
  // The directory layout always required a loadable schema (its entity scan imports every module):
  // surface the captured load error instead of re-importing to throw.
  if (!loaded) throw loadError

  const dir = config.schemaPath
  const groups = new Map<string, RenderedUnit[]>()
  const add = (abs: string, u: RenderedUnit) => {
    const arr = groups.get(abs)
    if (arr) arr.push(u)
    else groups.set(abs, [u])
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const t of tables) {
    add(
      tableLoc.get(t.name) ?? join(dir, "tables", `${safeFileName(t.name)}.ts`),
      tableUnit(t, makeCtx(t)),
    )
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const fn of functions)
    add(join(dir, "functions", `${safeFileName(fn.name)}.ts`), functionUnit(fn))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const a of accesses) add(join(dir, "access", `${safeFileName(a.name)}.ts`), accessUnit(a))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const an of analyzers)
    add(join(dir, "analyzers", `${safeFileName(an.name)}.ts`), analyzerUnit(an))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const pm of params) add(join(dir, "params", `${safeFileName(pm.name)}.ts`), paramUnit(pm))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const sq of sequences)
    add(join(dir, "sequences", `${safeFileName(sq.name)}.ts`), sequenceUnit(sq))

  const files = [...groups].map(([abs, units]) =>
    planFile(abs, units, keepLocal, config, () =>
      units.length === 1
        ? unitModule(units[0])
        : mergeUnits("", units, {
            keepLocalFields: true,
            keepLocalObjects: true,
          }).content,
    ),
  )

  // Whole-entity local-: locally-defined tables/functions/accesses the live DB doesn't have. A
  // file that ALSO holds a DB object is already reconciled above (mergeUnits keeps/drops the
  // local-entity per `keepLocal`); files whose entities are ALL local-are invisible
  // to the DB-driven plan, so surface them here. A file that is PURELY those entities is deletable
  // when mirroring (not --merge); one that mixes them with other code surfacs it but left in place.
  const dbNames = new Set<string>([
    ...tables.map((t) => t.name),
    ...functions.map((f) => f.name),
    ...accesses.map((a) => a.name),
    ...analyzers.map((a) => a.name),
    ...params.map((p) => p.name),
    ...sequences.map((s) => s.name),
  ])
  const planned = new Set(files.map((f) => f.abs))
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [file, info] of loaded.localEntities) {
    if (planned.has(file)) continue

    const localOnly = info.entities.filter((e) => !dbNames.has(e.name))
    if (localOnly.length === 0) continue

    const before = readFileSync(file, "utf8")
    const deletable = !keepLocal && info.pureSchema && localOnly.length === info.entities.length
    files.push({
      abs: file,
      action: deletable ? "delete" : "unchanged",
      after: deletable ? "" : before,
      before,
      localOnly: { fields: [], objects: localOnly.map((e) => e.exportName) },
      rel: relative(config.root, file),
    })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return { files, root: config.root }
}

/** Plan one file: create it from `fresh()` if absent, else merge the units into it. */
function planFile(
  abs: string,
  units: RenderedUnit[],
  keepLocal: boolean,
  config: ResolvedConfig,
  fresh: () => string,
): PullFilePlan {
  const rel = relative(config.root, abs)
  if (!existsSync(abs)) {
    const after = fresh()
    return {
      abs,
      action: "create",
      after: after.endsWith("\n") ? after : `${after}\n`,
      before: "",
      localOnly: EMPTY_LOCAL,
      rel,
    }
  }
  const before = readFileSync(abs, "utf8")
  const { content, localOnly } = mergeUnits(before, units, {
    keepLocalFields: keepLocal,
    keepLocalObjects: keepLocal,
  })
  return {
    abs,
    action: content === before ? "unchanged" : "update",
    after: content,
    before,
    localOnly,
    rel,
  }
}

/** The rendered unit for one db-level function. */
function functionUnit(fn: StructFunction): RenderedUnit {
  const code = renderFunctionConst(fn)
  const names = ["defineFunction", ...(code.includes("s.") ? ["s"] : [])]
  const imports = [`import { ${names.join(", ")} } from "better-schemic";`]
  // `surql` from surrealdb on its own line (see tableUnit) — a function body is always a surql expr.
  if (code.includes("surql`")) imports.push(`import { surql } from "surrealdb";`)

  return {
    code,
    exportName: fnConst(fn.name),
    imports,
    kind: "function",
    name: fn.name,
  }
}

/** The rendered unit for one db-level access def. */
function accessUnit(a: StructAccess): RenderedUnit {
  const code = renderAccessConst(a)
  const imports = [`import { defineAccess } from "better-schemic";`]
  if (code.includes("surql`")) imports.push(`import { surql } from "surrealdb";`)

  return {
    code,
    exportName: fnConst(a.name),
    imports,
    kind: "access",
    name: a.name,
  }
}

/** Render one introspected filter (uppercased, e.g. `SNOWBALL(ENGLISH)`) as a `.filters(f => …)`
 * builder expression: bare ones as `f.lowercase`/`f.ascii`/`f.uppercase`, parameterized ones as
 * `f.snowball("english")` / `f.ngram(1, 3)` / `f.edgengram(2, 5)` / `f.mapper("path")`. Anything
 * unrecognized falls back to a lowercased string literal (the callback also accepts raw strings). */
function filterBuilderExpr(filter: string): string {
  const m = /^([A-Za-z_]+)(?:\((.*)\))?$/u.exec(filter)
  if (!m) return JSON.stringify(filter.toLowerCase())

  const name = m[1].toLowerCase()
  const inner = m[2]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- verificação defensiva: chamadores JS/SDK podem violar o tipo estático
  if (inner === undefined) {
    return name === "ascii" || name === "lowercase" || name === "uppercase"
      ? `f.${name}`
      : JSON.stringify(name)
  }
  if (name === "snowball") return `f.snowball(${JSON.stringify(inner.toLowerCase())})`

  if (name === "ngram" || name === "edgengram") {
    const nums = inner.split(",").map((s) => s.trim())
    // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
    if (nums.length === 2 && nums.every((n) => /^\d+$/u.test(n)))
      return `f.${name}(${nums[0]}, ${nums[1]})`
  }
  // `mapper("…")` — `inner` is already a quoted string literal (case preserved); pass it through.
  if (name === "mapper" && /^".*"$/u.test(inner)) return `f.mapper(${inner})`

  return JSON.stringify(filter.toLowerCase()) // unknown parameterized -> string literal
}

/** Reverse a `StructAnalyzer` into a fluent `defineAnalyzer(name).tokenizers(…).filters(f => […])`
 * const (tokenizer names lowercased back to the authored form; filters rendered via the typed builder
 * callback; `lowerAnalyzer` re-uppercases for the canonical/diff comparison). A bare analyzer renders
 * `defineAnalyzer(name)`. */
// eslint-disable-next-line unicorn/consistent-function-scoping -- helper local mantido junto do uso para coesão e legibilidade
function renderAnalyzerConst(a: StructAnalyzer): string {
  const tokList = (xs: string[]) => xs.map((x) => JSON.stringify(x.toLowerCase())).join(", ")
  let expr = `defineAnalyzer(${JSON.stringify(a.name)})`
  if (a.function) expr += `.function(${JSON.stringify(a.function)})`

  if (a.tokenizers?.length) expr += `.tokenizers(${tokList(a.tokenizers)})`

  if (a.filters?.length) expr += `.filters((f) => [${a.filters.map(filterBuilderExpr).join(", ")}])`

  if (a.comment) expr += `.comment(${JSON.stringify(a.comment)})`

  return `export const ${fnConst(a.name)} = ${expr};`
}

function analyzerUnit(a: StructAnalyzer): RenderedUnit {
  return {
    code: renderAnalyzerConst(a),
    exportName: fnConst(a.name),
    imports: [`import { defineAnalyzer } from "better-schemic";`],
    // core `RenderedUnit.kind` lacks "analyzer" yet — group with the other db-level objects for now.
    kind: "access",
    name: a.name,
  }
}

/** A canonical param VALUE text as a TS literal, when representable: `'x'` -> "x", `25` -> 25,
 * true/false. Unrepresentable values regenerate as a DECLARED param with the text in a comment. */
function paramValueTS(text: string): string | undefined {
  const m = /^'(.*)'$/u.exec(text)
  if (m) return JSON.stringify(m[1].replaceAll("\\'", "'").replaceAll("\\\\", "\\"))

  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return text

  if (text === "true" || text === "false") return text

  return undefined
}

function renderParamConst(p: StructParam): string {
  const value = paramValueTS(p.value)
  let expr =
    value === undefined
      ? `defineParam(${JSON.stringify(p.name)})`
      : `defineParam(${JSON.stringify(p.name)}, ${value})`
  if (p.permissions === false) expr += `.permissions(false)`

  if (p.comment) expr += `.comment(${JSON.stringify(p.comment)})`

  const note =
    value === undefined
      ? `// live value \`${commentText(p.value)}\` isn't a plain literal — declared-only; manage via \`sc param push\`\n`
      : ""
  return `${note}export const ${fnConst(p.name)} = ${expr};`
}

function paramUnit(p: StructParam): RenderedUnit {
  return {
    code: renderParamConst(p),
    exportName: fnConst(p.name),
    imports: [`import { defineParam } from "better-schemic";`],
    // core `RenderedUnit.kind` lacks "param" yet — group with the other db-level objects for now.
    kind: "access",
    name: p.name,
  }
}

/** Reverse a `StructSequence` into a fluent `defineSequence(name).batch(…).start(…).timeout(…)` const
 *  (defaults are already stripped by normalizing, so a bare sequence renders `defineSequence(name)`). */
function renderSequenceConst(s: StructSequence): string {
  let expr = `defineSequence(${JSON.stringify(s.name)})`
  if (s.batch !== undefined) expr += `.batch(${s.batch})`

  if (s.start !== undefined) expr += `.start(${s.start})`

  if (s.timeout !== undefined) expr += `.timeout(${JSON.stringify(s.timeout)})`

  return `export const ${fnConst(s.name)} = ${expr};`
}

function sequenceUnit(s: StructSequence): RenderedUnit {
  return {
    code: renderSequenceConst(s),
    exportName: fnConst(s.name),
    imports: [`import { defineSequence } from "better-schemic";`],
    // core `RenderedUnit.kind` lacks "sequence" yet — group with the other db-level objects for now.
    kind: "access",
    name: s.name,
  }
}

/** Build the per-table {@link RenderCtx} factory: cycle-aware ref resolution + import accumulation. */
// eslint-disable-next-line unicorn/consistent-function-scoping -- helper local mantido junto do uso para coesão e legibilidade
function ctxFactory(tables: StructTable[]): (t: StructTable) => RenderCtx {
  // Reference graph (record<…> targets + relation endpoints) → cycle-aware imports / ordering.
  const pulled = new Set(tables.map((t) => t.name))
  const graph = new Map(tables.map((t) => [t.name, tableRefs(t, pulled)]))
  const resolve = makeResolver(graph, pulled)
  const constOf = (n: string) => safeConst(n)
  return (t) => ({
    allowSelf: t.kind.kind !== "RELATION", // table takes the `self` callback
    constOf,
    imports: new Set(),
    resolve: (target) => resolve(t.name, target),
    table: t.name,
    usesSelf: false,
  })
}

/** Render a whole structured schema to one canonical TypeScript module (the source of `diff --ts`). */
export function renderSchemaToTS(db: DbStructured): string {
  return assembleCombined(db, ctxFactory(db.tables))
}

/** Merge units' import lines into a deduped block (union of specifiers per source). */
function mergeImports(units: RenderedUnit[]): string[] {
  const bySource = new Map<string, Set<string>>()
  const order: string[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const u of units) {
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const line of u.imports) {
      const m = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/u.exec(line)
      if (!m) continue

      let set = bySource.get(m[2])
      if (!set) {
        set = new Set()
        bySource.set(m[2], set)
        order.push(m[2])
      }
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const s of m[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean))
        set.add(s)
    }
  }
  // better-schemic first, then the relative cross-file imports (sorted).
  // eslint-disable-next-line unicorn/no-nested-ternary -- Prettier remove os parênteses exigidos pela regra; a expressão encadeada é mais legível que if/else aqui
  order.sort((a, b) => (a === "../index" ? -1 : b === "../index" ? 1 : a.localeCompare(b)))
  return order.map(
    (src) => `import { ${[...(bySource.get(src) ?? [])].join(", ")} } from "${src}";`,
  )
}

/**
 * Render a structured schema to per-file TypeScript modules keyed by file path — the
 * layout `pull` writes (one file per object, with cross-file imports). `fileFor` maps an object to
 * its file. Used by `diff --ts` so its output matches the user's actual files.
 */
export function renderPerFile(
  db: DbStructured,
  fileFor: (kind: RenderedUnit["kind"], name: string) => string,
): Map<string, string> {
  const makeCtx = ctxFactory(db.tables)
  const byFile = new Map<string, RenderedUnit[]>()
  const add = (file: string, u: RenderedUnit) => {
    const arr = byFile.get(file)
    if (arr) arr.push(u)
    else byFile.set(file, [u])
  }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const t of db.tables) add(fileFor("table", t.name), tableUnit(t, makeCtx(t)))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const fn of db.functions) add(fileFor("function", fn.name), functionUnit(fn))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const a of db.accesses) add(fileFor("access", a.name), accessUnit(a))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const an of db.analyzers) add(fileFor("access", an.name), analyzerUnit(an))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const pm of db.params) add(fileFor("access", pm.name), paramUnit(pm))

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const sq of db.sequences ?? []) add(fileFor("access", sq.name), sequenceUnit(sq))

  const out = new Map<string, string>()
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [file, units] of byFile) {
    out.set(
      file,
      units.length === 1
        ? unitModule(units[0])
        : `${mergeImports(units).join("\n")}\n\n${units.map((u) => u.code).join("\n\n")}\n`,
    )
  }
  return out
}

/** Assemble the single-file combined module (tables ordered so same-file refs resolve). */
function assembleCombined(
  { accesses, analyzers, functions, params, sequences = [], tables }: DbStructured,
  makeCtx: (t: StructTable) => RenderCtx,
): string {
  // Render each const (collecting its same-file direct deps via ctx.imports), then order so deps
  // come first — same-file `Target.record()` refs need `Target` defined above them.
  const rendered = tables.map((t) => {
    const ctx = makeCtx(t)
    const { code, factory } = renderTableConst(t, ctx)
    return {
      code,
      deps: [...ctx.imports].filter((d) => d !== t.name),
      factory,
      name: t.name,
      usesSurql: code.includes("surql`"),
    }
  })
  const ordered = topoSort(rendered)
  const fnCode = functions.map(renderFunctionConst)
  const accessCode = accesses.map(renderAccessConst)
  const analyzerCode = analyzers.map(renderAnalyzerConst)
  const paramCode = params.map(renderParamConst)
  const sequenceCode = sequences.map(renderSequenceConst)
  const factories = [...new Set(ordered.map((r) => r.factory))]
  if (functions.length > 0) factories.push("defineFunction")

  if (accesses.length > 0) factories.push("defineAccess")

  if (analyzers.length > 0) factories.push("defineAnalyzer")

  if (params.length > 0) factories.push("defineParam")

  if (sequences.length > 0) factories.push("defineSequence")

  factories.sort()
  const usesSurql = functions.length > 0 || accesses.length > 0 || ordered.some((r) => r.usesSurql)
  const names = ["s", ...factories]
  const imports = [`import { ${names.join(", ")} } from "better-schemic";`]
  // `surql` from surrealdb on its own line (see tableUnit), kept out of the better-schemic import.
  if (usesSurql) imports.push(`import { surql } from "surrealdb";`)

  // Params + analyzers first — functions/events may reference $params; a FULLTEXT index its analyzer.
  const body = [
    ...paramCode,
    ...analyzerCode,
    ...sequenceCode,
    ...ordered.map((r) => r.code),
    ...fnCode,
    ...accessCode,
  ].join("\n\n")
  return `${imports.join("\n")}\n\n${body}\n`
}
