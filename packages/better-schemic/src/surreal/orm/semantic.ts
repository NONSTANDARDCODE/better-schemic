/**
 * A small semantic layer over the typed schema: business metric definitions, a glossary and declared
 * lineage. It compiles to the ORM's EXISTING, live-verified `combine` surface — no new DDL, no new
 * query engine, and no guessing lineage from freeform SQL.
 *
 * Honesty rule: a metric declares its source table, measure and dimensions. `lineage()` validates
 * those declarations against the schema and reports  what declars it. It never parses a
 * `surql` fragment to infer where a column came from.
 */
import type { App } from "../pure"

import type { SchemaIndex } from "./meta"
import { buildSchemaIndex } from "./schema"
import type { AnyTableDef, SchemaDef, SchemaInput } from "./types/schema"

/** The aggregations the ORM's `combine` compiler already supports. */
export type MetricOp = "avg" | "count" | "max" | "median" | "min" | "sum"

/** A business metric: named, typed against its source table, and reusable by agents. */
export type MetricDef<F extends string = string> = {
  /**
   * The deterministic `combine` args for this metric (`select`/`groupBy`). The ORM's own result
   * typing derives from the literal, so spreading this into `delegate.combine()` stays typed.
   */
  readonly args: {
    readonly groupBy?: readonly string[]
    readonly select: Record<string, unknown>
  }
  readonly description?: string
  readonly dimensions: readonly F[]
  /** Stable business key (SchemaInvalid if duplicated in a lineage set). */
  readonly key: string
  readonly kind: "metric"
  readonly measure: { readonly field: F; readonly op: MetricOp } | { readonly op: "count" }
  readonly name: string
  /** Physical source table name. */
  readonly table: string
}

const OPS: ReadonlySet<MetricOp> = new Set(["count", "sum", "avg", "min", "max", "median"])

/** Declare a metric against a table — the measure field and dimensions check them at authoring. */
export function defineMetric<
  const TD extends AnyTableDef,
  const F extends Extract<keyof App<TD>, string>,
>(spec: {
  description?: string
  dimensions?: readonly F[]
  from: TD
  key: string
  measure: { readonly field: F; readonly op: MetricOp } | { readonly op: "count" }
  name?: string
}): MetricDef<F> {
  if (!OPS.has(spec.measure.op))
    throw new Error(`metric "${spec.key}": unsupported op "${spec.measure.op}".`)

  if (!spec.key) throw new Error("metric: a stable `key` is required.")

  const dimensions = spec.dimensions ?? []
  const select: Record<string, unknown> = { _count: true }
  if (spec.measure.op !== "count") select.value = { [spec.measure.op]: spec.measure.field }

  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const dimension of dimensions) select[dimension] = dimension

  return {
    key: spec.key,
    kind: "metric",
    name: spec.name ?? spec.key,
    ...(spec.description ? { description: spec.description } : {}),
    args: dimensions.length > 0 ? { groupBy: dimensions, select } : { select },
    dimensions,
    measure: spec.measure,
    table: spec.from.name,
  }
}

/** A glossary entry — authoring-metadata; the database never sees it and cannot round-trip it. */
export type GlossaryTerm = {
  readonly definition: string
  /** The business metric key this term describes, when any. */
  readonly metric?: string
  readonly owner?: string
  readonly synonyms?: readonly string[]
}

/** Declare a glossary — a plain, JSON-safe registry keyed by term. */
export function defineGlossary<const T extends Readonly<Record<string, GlossaryTerm>>>(
  terms: T,
): T {
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [term, entry] of Object.entries(terms))
    if (!entry.definition) throw new Error(`glossary: term "${term}" needs a definition.`)

  return terms
}

/** One declared lineage edge (metric → source fields). */
export type LineageEntry = {
  readonly dimensions: readonly string[]
  /** The fields the metric reads (measure + dimensions). */
  readonly fields: readonly string[]
  readonly key: string
  readonly measure: MetricDef["measure"]
  readonly table: string
}

/**
 * check declared metrics against an authored schema and return their lineage. An unknown table,
 * measure field or dimension throws a teaching error instead of producing a plausible-looking but
 * wrong report.
 */
export function lineage(
  metrics: readonly MetricDef[],
  schema: SchemaDef | SchemaInput,
  index: SchemaIndex = buildSchemaIndex(schema),
): readonly LineageEntry[] {
  const seen = new Set<string>()
  return metrics.map((metric) => {
    if (seen.has(metric.key))
      throw new Error(`lineage: duplicate metric key "${metric.key}" — metric keys must be unique.`)

    seen.add(metric.key)
    const model = index.byName.get(metric.table)
    if (!model || !("columns" in model))
      throw new Error(`lineage: metric "${metric.key}" names unknown table "${metric.table}".`)

    const fields = [
      ...(metric.measure.op === "count" ? [] : [metric.measure.field]),
      ...metric.dimensions,
    ]
    // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
    for (const field of fields) {
      if (!model.columns.has(field)) {
        throw new Error(
          `lineage: metric "${metric.key}" reads "${field}", which is not a column of "${metric.table}".`,
        )
      }
    }
    return {
      dimensions: metric.dimensions,
      fields,
      key: metric.key,
      measure: metric.measure,
      table: metric.table,
    }
  })
}
