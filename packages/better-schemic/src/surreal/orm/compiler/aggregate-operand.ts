/**
 * The AGGREGATE OPERAND guard — what `math::*` can and cannot be pointed at.
 *
 * `math::sum/avg/min/max/median/stddev/variance` are number-only, and SurrealDB NEVER fails on the
 * wrong operand (live-probed on 3.3.4): `0` for an unknown field, a string, or a link/array; `{}`
 * for `median(string)`; `null` for `min`/`max` of a string, datetime or bool. A report showing
 * R$ 0,00 with no signal is worse than a compile error, so the operand is checked against the schema
 * and the message names the form that works.
 *
 * Kept apart from the lowering (`aggregate-entries.ts`) because it is a POLICY about the operand,
 * not a question of how the SQL is spelled — both lowerings share it.
 */

import { MATH_OPS } from "./aggregate-entries"
import { compileError, describeValue, isTableMeta, pathSegments, renderPath } from "./shared"

import type { ColumnMeta, FieldFamily, ModelMeta, TableMeta } from "../meta"

/**
 * The aggregators whose operand MUST be a numeric leaf.
 *
 * `math::*` is number-only on SurrealDB — and NOT uniformly wrong when fed something else: `sum`
 * over a string or an unknown path answers `0`, `median` answers `{}`, and `min`/`max` over a
 * string/datetime/bool answer `null` (all live-probed on 3.3.4). Since every one of those looks
 * like a real result, the operand is validated here and the message points at the form that does
 * work (`array::min(array::group(…))` for non-numbers — also live-verified).
 */
const NUMBER_ONLY_OPS: ReadonlySet<string> = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "stddev",
  "variance",
])

/**
 * Reject an aggregate operand the server would silently answer with a lie.
 *
 * `math::*` over a grouped set NEVER fails on a wrong operand — it answers `0` for an unknown path,
 * for a `string` column and for a link path, `null` for `math::min(string)`, and `{}` for
 * `math::median(string)` (all live-probed on 3.3.4). A report showing `R$ 0,00` with no signal is
 * worse than a compile error, so the operand is checked against the authored schema here.
 *
 * Only what the schema KNOWS is enforced: a schemaless entry, a non-SCHEMAFULL table (a view), or
 * a path that walks into a flexible object has no column to check and stays permissive.
 */
export function assertAggregateOperand(
  meta: ModelMeta,
  key: string,
  op: string,
  path: string,
  operation: string,
  options: { readonly throughSplit?: boolean } = {},
): void {
  if (!isTableMeta(meta)) return
  if (!meta.def.config.schemafull) return
  const table = meta.name,
    { columns } = meta,
    fail = (reason: string): never => {
      throw compileError(
        "ValidationError",
        `${operation}: select."${key}".${op} can't run over "${path}" — ${reason}`,
        { operation, table },
      )
    },
    segments = pathSegments(path),
    first = segments[0]
  // A split aggregate's operand names a column of the split ELEMENT — a different table, which this
  // Meta cannot describe. Only a path that stays on the parent is checkable; the rest is left to the
  // Server (which is exactly where the 0/null came from — but here it is a deliberate, documented
  // Escape, not a silent wrong answer on a field the schema DOES know).
  if (options.throughSplit === true) {
    const base = columns.get(first)
    if (!base) return
    // A bare field name, or a base that is neither a record link nor an array: still the parent's.
    const descends =
      segments.length > 1 &&
      base.record !== undefined &&
      (base.family === "array" || base.family === "set")
    if (descends) return
  }
  // A SCHEMAFULL table rejects unknown fields server-side; catch the typo with the field list.
  const found = columns.get(first)
  if (!found) {
    fail(
      `"${first}" is not a field of "${table}". Known fields: ${[...columns.keys()].join(", ")} — or pass a surql fragment.`,
    )
  }
  const base: ColumnMeta = found!,
    // Walk every segment but the last: a path may only descend through a plain object. A record link
    // Or an array/set holds many values per grouped row — that is what SPLIT exists for.
    column = base
  for (let i = 0; i < segments.length - 1; i++) {
    if (column.family === "object") return // Flexible object: the leaf's family is unknown here
    const segment = segments[i]
    if (column.record !== undefined) {
      fail(
        `"${column.name}" is a ${column.record.list ? "list of " : ""}record link — math::* aggregates ONE field per grouped row, so it can't reach through it. Use \`aggregate({ split: "${column.name}", select: { ${key}: { ${op}: "…${segment}" } } })\` for the per-element total, or a surql fragment with array::flatten.`,
      )
    }
    if (column.family === "array" || column.family === "set") {
      fail(
        `"${column.name}" is ${articleFor(column.family)} — math::* aggregates ONE field per grouped row. Use \`aggregate({ split: "${column.name}", … })\` to aggregate per element, or a surql fragment with array::flatten.`,
      )
    }
    // A scalar intermediate (the schema has no column for it) cannot be walked either.
    return
  }

  const last = column
  if (last.family === "object" || last.family === "any") return
  if (NUMBER_ONLY_OPS.has(op) && last.family !== "number") {
    fail(
      `math::${MATH_OPS[op]} only aggregates NUMBERS and "${last.name}" is ${articleFor(last.family)} — the server would answer ${
        op === "min" || op === "max" ? "null" : op === "median" ? "an empty object" : "0"
      } for it, with no error. For a ${last.family} ${op === "min" || op === "max" ? "extremum" : "total"} use a surql fragment (\`array::${op === "min" || op === "max" ? op : "sort"}…\` over \`array::group(${renderPath(path)})\`), or { collect: "${path}" } and reduce in JS.`,
    )
  }
}

/** A field family as an English noun phrase (`a string field`, `an array field`). */
export function articleFor(family: FieldFamily): string {
  const noun = family === "bool" ? "boolean" : family
  return `${"aeiou".includes(noun[0]) ? "an" : "a"} ${noun} field`
}
