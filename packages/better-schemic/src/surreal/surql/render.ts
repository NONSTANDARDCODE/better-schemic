/**
 * INTERNAL lowering primitives shared by the query builder (`./index`), the stdlib catalog
 * (`../fn`), and `block()` (`./block`) — deferred field-ref rendering (row-token-aware
 * `$parent`), operand/argument lowering, and fragment bind merging. Side-effect-free and
 * dependency-light on purpose: the authoring index may import through here (via `../fn`)
 * without dragging the builder in. Nothing here is package-public.
 */

import { BoundQuery } from "surrealdb"

import {
  type Ctx,
  FRAGMENT,
  hasRefDeep,
  isParamRef,
  mergeRaw,
  paramDefName,
  refState,
  rejectDefValue,
  renderData,
  renderRef,
  rewriteBind,
} from "../pure"

// The lowering PRIMITIVES live in ../pure (the authoring base needs them — e.g.
// `RecordIdField.for([e.after.id])` renders a fragment); re-exported here so the query layer
// keeps one import site.
export {
  type Ctx,
  FRAGMENT,
  fragOf,
  hasRefDeep,
  mergeRaw,
  operandText,
  REF_STATE,
  type RefKind,
  type RefState,
  refState,
  renderData,
  renderRef,
} from "../pure"

// --- fragments -----------------------------------------------------------------------------------

let subCounter = 0
/** Lower a builder to an interpolatable fragment: parenthesize the sql and NAMESPACE its binds
 *  (`$b0` -> `$sub__<n>_b0`, boundary-aware) so builder fragments compose in one template
 * without colliding (the SDK throws on duplicate bind names rather than renaming). */
export function toFragment(
  lowered: { sql: string; vars: Record<string, unknown> },
  wrap = (sql: string): string => `(${sql})`,
): BoundQuery {
  const prefix = `sub__${++subCounter}_`
  let text = lowered.sql
  const binds: Record<string, unknown> = {}
  Object.entries(lowered.vars).forEach(([name, value]) => {
    text = rewriteBind(text, name, `${prefix}${name}`)
    binds[`${prefix}${name}`] = value
  })
  return new BoundQuery(wrap(text), binds)
}

// --- operand / argument lowering -----------------------------------------------------------------

/** Value-position statements that must KEEP their parens (a bare subquery in `LET`/`RETURN`
 * requires them; SurrealDB's printer keeps them too). */
const KEEP_PARENS = /^(SELECT|CREATE|UPDATE|DELETE|INSERT|RELATE|UPSERT|DEFINE|IF|FOR|RETURN)\b/iu

/**
 * Strip a redundant WHOLE-EXPRESSION paren wrap (quote-aware) — for VALUE positions
 * (`LET $x = …` / `RETURN …` / `IF <cond>`), where SurrealDB's canonical printer strips them
 * and keeping ours would phantom-diff DDL round-trips. Subquery parens stay (required syntax).
 */
/** Number of characters consumed by a backslash escape. */
const ESCAPE_STEP = 2

/** Scan state for {@link stripOuterParens}'s quote-aware paren walk. */
type ParenScan = {
  readonly depth: number
  readonly index: number
  readonly quote: "'" | '"' | null
  readonly whole: boolean
}

/** Advance the paren scan by one character, stopping when a closing paren isn't the outer one. */
function stepParenScan(state: ParenScan, text: string): ParenScan {
  if (!state.whole || state.index >= text.length) return state

  const i = state.index
  const ch = text[i]
  if (state.quote !== null) {
    if (ch === "\\") return { ...state, index: i + ESCAPE_STEP }
    if (ch === state.quote) return { ...state, index: i + 1, quote: null }
    return { ...state, index: i + 1 }
  }
  if (ch === '"' || ch === "'") return { ...state, index: i + 1, quote: ch }
  if (ch === "(") return { ...state, depth: state.depth + 1, index: i + 1 }
  if (ch === ")") {
    const depth = state.depth - 1
    if (depth === 0 && i < text.length - 1) return { ...state, depth, whole: false }
    return { ...state, depth, index: i + 1 }
  }
  return { ...state, index: i + 1 }
}

/** Whether the first `(` wraps the whole expression (quote-aware). */
function outerParensWrapWhole(text: string): boolean {
  return text.split("").reduce<ParenScan>((state) => stepParenScan(state, text), {
    depth: 0,
    index: 0,
    quote: null,
    whole: true,
  }).whole
}

export function stripOuterParens(text: string): string {
  const t = text.trim()
  if (!t.startsWith("(") || !t.endsWith(")")) return t
  if (!outerParensWrapWhole(t)) return t

  const inner = t.slice(1, -1).trim()
  if (KEEP_PARENS.test(inner)) return t
  return stripOuterParens(inner)
}

let argCounter = 0
/**
 * Capture a derived-method / catalog-call ARGUMENT for deferred rendering. Refs and `$param`
 * refs stay deferred (so an outer-row ref inside `.replace(other, …)` still `$parent`-detects at
 * lowering); a literal binds under a globally-unique `$r<n>` name captured NOW (stable across
 * passes render the ref).
 */
export function argRenderer(v: unknown): (ctx: Ctx) => string {
  if (isParamRef(v)) return () => v.toText()

  const rs = refState(v)
  if (rs) return (ctx) => renderRef(rs, ctx)

  if (v instanceof BoundQuery) return (ctx) => `(${mergeRaw(v as BoundQuery, ctx.vars)})`

  const frag = (v as null | Record<symbol, unknown>)?.[FRAGMENT]
  if (typeof frag === "function") return (ctx) => mergeRaw(frag.call(v) as BoundQuery, ctx.vars)

  if (hasRefDeep(v)) return (ctx) => renderData(v, ctx)

  const param = paramDefName(v)
  if (param !== undefined) return () => `$${param}`

  rejectDefValue(v)
  const name = `r${++argCounter}`
  return (ctx) => {
    ctx.vars[name] = v
    return `$${name}`
  }
}
