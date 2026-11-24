// Lexical helpers for SurrealQL TYPE EXPRESSIONS — the one home for "split at top level, ignoring
// `<…>`". Shared by the emitter's union inference (`inferField`), the Struct-IR normalizer
// (`normalizeType`), `pull`'s type→`s.*` renderer, and the portable-type bridge (`parseSurqlType`),
// all four agree on where a union/comma boundary is. Pure strings — no dialect model.

type SplitState = {
  readonly depth: number
  readonly last: number
  readonly parts: readonly string[]
}

/** Adjust the `<…>` nesting depth for one marker. */
function stepDepth(depth: number, c: string): number {
  if (c === "<") return depth + 1
  if (c === ">") return depth - 1
  return depth
}

/** Split a type expression on its top-level `|` (ignoring `|` inside `<…>`). */
export function splitTopUnion(expr: string): string[] {
  const marks = [...expr.matchAll(/[<>|]/gu)]
  const state = marks.reduce<SplitState>(
    (acc, mark) => {
      const at = mark.index
      if (mark[0] === "|" && acc.depth === 0) {
        return {
          depth: acc.depth,
          last: at + 1,
          parts: [...acc.parts, expr.slice(acc.last, at).trim()],
        }
      }
      return { depth: stepDepth(acc.depth, mark[0]), last: acc.last, parts: acc.parts }
    },
    { depth: 0, last: 0, parts: [] },
  )
  return [...state.parts, expr.slice(state.last).trim()]
}

/** Split `s` once on the first top-level `sep` (outside `<…>`), or null if absent. */
export function topLevelSplitOnce(s: string, sep: string): [string, string] | null {
  let depth = 0
  const index = s.split("").findIndex((c) => {
    if (c === "<" || c === ">") {
      depth = stepDepth(depth, c)
      return false
    }
    return c === sep && depth === 0
  })
  return index === -1 ? null : [s.slice(0, index), s.slice(index + 1)]
}
