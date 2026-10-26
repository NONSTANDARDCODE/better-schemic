// The SurrealQL type-expression <-> PortableType bridge (Milestone 2). This is the Surreal driver's
// `parseType`/`emitType`: it lifts the Struct-IR's `kind` STRING (e.g. `option<int>`,
// `array<record<user>, 3>`, `'a' | 'b'`) into the dialect-independent PortableType, and renders it
// Back to the canonical SurrealQL spelling (the form `normalizeType` produces). Round-tripping
// Proves the portable model is LOSSLESS for the Surreal dialect — the precondition for flipping diff
// Equality to a structured deep-compare (see docs/MULTI-DB-SPIKE.md, Part 6).

import { array, literal, nullable, option, record, scalar, union } from "../../core"
import { splitTopUnion, topLevelSplitOnce } from "../surql-type-expr"

import type { PortableType, ScalarName } from "../../core"

const SCALARS = new Set<string>([
    "any",
    "bool",
    "string",
    "int",
    "float",
    "decimal",
    "number",
    "datetime",
    "duration",
    "uuid",
    "bytes",
    "null",
  ]),
  GEOMETRY_KINDS = new Set([
    "feature",
    "point",
    "line",
    "polygon",
    "multipoint",
    "multiline",
    "multipolygon",
    "collection",
  ])

/** Parse a (single/double) quoted string literal token, or null if it isn't one. */
function parseStringLiteral(t: string): string | null {
  if (t.length >= 2 && (t.startsWith("'") || t.startsWith('"')) && t.at(-1) === t[0]) {
    const body = t.slice(1, -1)
    return body.replaceAll(/\\(['"\\])/g, "$1")
  }
  return null
}

/**
 * Parse a SurrealQL type expression into a {@link PortableType}. Mirrors the grammar `normalizeType`
 * canonicalizes: `option<…>`, top-level unions (a `none` member ⇒ `option`, a `null` member ⇒
 * `nullable`), `array`/`set`/`record`/`references` constructors, literals, and scalars.
 */
export function parseSurqlType(kind: string): PortableType {
  const t = kind.trim(),
    // Top-level union FIRST: `option<A> | B` starts with `option<` and can end with `>`, so testing the
    // Option wrapper before splitting would swallow the whole union (the regex is greedy). `splitTopUnion`
    // Ignores `|` inside `<…>`, so `option<A | B>` still resolves to a single option below.
    // Peel `none` (absence) and `null` (null) markers, recurse on the rest.
    parts = splitTopUnion(t)
  if (parts.length > 1) {
    const hasNone = parts.includes("none"),
      hasNull = parts.includes("null"),
      rest = parts.filter((p) => p !== "none" && p !== "null")
    let inner: PortableType = rest.length === 0 ? { t: "never" } : union(rest.map(parseSurqlType))
    if (hasNull) inner = nullable(inner)
    if (hasNone) inner = option(inner)
    return inner
  }

  // Option<X>
  const opt = /^option<([\s\S]+)>$/.exec(t)
  if (opt) return option(parseSurqlType(opt[1]))

  // Constructor term `ctor<inner>`. `references<…>` (rare) is kept as a Surreal-native escape hatch
  // So it round-trips losslessly rather than collapsing into `record<…>`.
  const ctor = /^(array|set|record)<([\s\S]+)>$/.exec(t)
  if (ctor) {
    const [, name, innerRaw] = ctor
    if (name === "array" || name === "set") {
      const comma = topLevelSplitOnce(innerRaw, ","),
        elem = parseSurqlType(comma ? comma[0] : innerRaw),
        size = comma ? Number(comma[1].trim()) : undefined
      return name === "array"
        ? array(elem, Number.isFinite(size) ? size : undefined)
        : { t: "set", elem, ...(Number.isFinite(size) ? { size } : {}) }
    }
    // Record<…>: a `|`-list of target tables.
    const tables = innerRaw
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
    return record(tables)
  }

  // Geometry<point> etc.
  const geo = /^geometry<([a-z]+)>$/.exec(t)
  if (geo && GEOMETRY_KINDS.has(geo[1])) return { t: "geometry", kind: geo[1] as never }

  // Literals: quoted string, number, boolean.
  const str = parseStringLiteral(t)
  if (str !== null) return literal(str)
  if (/^-?\d+(\.\d+)?$/.test(t)) return literal(Number(t))
  if (t === "true" || t === "false") return literal(t === "true")

  // Scalars (incl. `null` as a unit type). `none` standalone ⇒ option<never>. `object` ⇒ empty object.
  if (t === "none") return option({ t: "never" })
  if (t === "object") return { t: "object", fields: {} }
  if (SCALARS.has(t)) return scalar(t as ScalarName)

  // Unknown: keep it as a Surreal-native escape hatch rather than losing information.
  return { t: "native", db: "surreal", name: t }
}

/** Render a {@link PortableType} back to its canonical SurrealQL spelling (matches `normalizeType`). */
export function emitSurqlType(p: PortableType): string {
  switch (p.t) {
    case "scalar": {
      return p.name
    }
    case "literal": {
      return typeof p.value === "string"
        ? `'${p.value.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`
        : String(p.value)
    }
    case "option": {
      // `none` is the canonical spelling of `option<never>` (matches normalizeType): emit it as
      // `none` so `emit∘parse` is a true inverse. Emitting `option<none>` would re-parse to
      // `option<option<never>>` and break the lossless round-trip.
      return p.inner.t === "never" ? "none" : `option<${emitSurqlType(p.inner)}>`
    }
    case "nullable": {
      // Canonical: a flat, sorted top-level union with `null` (matches normalizeType, which sorts
      // Every member and does not special-case null). Flatten a union inner so `A | B | null` sorts
      // As three members, not `(A | B) | null` — the latter would put `null` last.
      const members =
        p.inner.t === "union" ? p.inner.members.map(emitSurqlType) : [emitSurqlType(p.inner)]
      return [...members, "null"].sort().join(" | ")
    }
    case "array": {
      return p.size === undefined
        ? `array<${emitSurqlType(p.elem)}>`
        : `array<${emitSurqlType(p.elem)}, ${p.size}>`
    }
    case "set": {
      return p.size === undefined
        ? `set<${emitSurqlType(p.elem)}>`
        : `set<${emitSurqlType(p.elem)}, ${p.size}>`
    }
    case "union": {
      return p.members.map(emitSurqlType).sort().join(" | ")
    }
    case "object": {
      return "object"
    }
    case "record": {
      return `record<${[...p.tables].sort().join(" | ")}>`
    }
    case "geometry": {
      return `geometry<${p.kind}>`
    }
    case "never": {
      return "none"
    }
    case "native": {
      return p.name
    }
  }
  // Unreachable: the switch is exhaustive over PortableType["t"].
  throw new Error(`unhandled portable type: ${(p as { t: string }).t}`)
}
