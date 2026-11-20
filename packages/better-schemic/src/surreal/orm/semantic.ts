/**
 * A small semantic layer over the typed schema: business metric definitions, a glossary and declared
 * lineage. It compiles to the ORM's EXISTING, live-verified `aggregate` surface — no new DDL, no new
 * query engine, and no guessing lineage from freeform SQL.
 *
 * Honesty rule: a metric declares its source table, measure and dimensions. `lineage()` validates
 * those declarations against the schema and reports exactly what was declared. It never parses a
 * `surql` fragment to infer where a column came from.
 */
import type { App } from "../pure";
import type { SchemaIndex } from "./meta";
import { buildSchemaIndex } from "./schema";
import type { AnyTableDef, SchemaDef, SchemaInput } from "./types/schema";

/** The aggregations the ORM's `aggregate` compiler already supports. */
export type MetricOp = "count" | "sum" | "avg" | "min" | "max" | "median";

/** A business metric: named, typed against its source table, and reusable by agents. */
export interface MetricDef<F extends string = string> {
  readonly kind: "metric";
  /** Stable business key (SchemaInvalid if duplicated in a lineage set). */
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  /** Physical source table name. */
  readonly table: string;
  readonly measure:
    | { readonly op: "count" }
    | { readonly op: MetricOp; readonly field: F };
  readonly dimensions: readonly F[];
  /**
   * The deterministic `aggregate` args for this metric (`select`/`groupBy`). The ORM's own result
   * typing derives from the literal, so spreading this into `delegate.aggregate()` stays typed.
   */
  readonly args: {
    readonly select: Record<string, unknown>;
    readonly groupBy?: readonly string[];
  };
}

const OPS: readonly MetricOp[] = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "median",
];

/** Declare a metric against a table — the measure field and dimensions are checked at authoring. */
export function defineMetric<
  const TD extends AnyTableDef,
  const F extends Extract<keyof App<TD>, string>,
>(spec: {
  key: string;
  name?: string;
  description?: string;
  from: TD;
  measure:
    | { readonly op: "count" }
    | { readonly op: MetricOp; readonly field: F };
  dimensions?: readonly F[];
}): MetricDef<F> {
  if (!OPS.includes(spec.measure.op))
    throw new Error(
      `metric "${spec.key}": unsupported op "${spec.measure.op}".`,
    );
  if (!spec.key) throw new Error("metric: a stable `key` is required.");
  const dimensions = spec.dimensions ?? [];
  const select: Record<string, unknown> = { _count: true };
  if (spec.measure.op !== "count")
    select.value = { [spec.measure.op]: spec.measure.field };
  for (const dimension of dimensions) select[dimension] = dimension;
  return {
    kind: "metric",
    key: spec.key,
    name: spec.name ?? spec.key,
    ...(spec.description ? { description: spec.description } : {}),
    table: spec.from.name,
    measure: spec.measure,
    dimensions,
    args: dimensions.length > 0 ? { select, groupBy: dimensions } : { select },
  };
}

/** A glossary entry — authoring-only metadata; the database never sees it and cannot round-trip it. */
export interface GlossaryTerm {
  readonly definition: string;
  readonly synonyms?: readonly string[];
  readonly owner?: string;
  /** The business metric key this term describes, when any. */
  readonly metric?: string;
}

/** Declare a glossary — a plain, JSON-safe registry keyed by term. */
export function defineGlossary<
  const T extends Readonly<Record<string, GlossaryTerm>>,
>(terms: T): T {
  for (const [term, entry] of Object.entries(terms))
    if (!entry?.definition)
      throw new Error(`glossary: term "${term}" needs a definition.`);
  return terms;
}

/** One declared lineage edge (metric → source fields). */
export interface LineageEntry {
  readonly key: string;
  readonly table: string;
  /** The fields the metric reads (measure + dimensions). */
  readonly fields: readonly string[];
  readonly dimensions: readonly string[];
  readonly measure: MetricDef["measure"];
}

/**
 * Validate declared metrics against an authored schema and return their lineage. An unknown table,
 * measure field or dimension throws a teaching error instead of producing a plausible-looking but
 * wrong report.
 */
export function lineage(
  metrics: readonly MetricDef[],
  schema: SchemaDef | SchemaInput,
  index: SchemaIndex = buildSchemaIndex(schema),
): readonly LineageEntry[] {
  const seen = new Set<string>();
  return metrics.map((metric) => {
    if (seen.has(metric.key))
      throw new Error(
        `lineage: duplicate metric key "${metric.key}" — metric keys must be unique.`,
      );
    seen.add(metric.key);
    const model = index.byName.get(metric.table);
    if (!model || !("columns" in model))
      throw new Error(
        `lineage: metric "${metric.key}" names unknown table "${metric.table}".`,
      );
    const fields = [
      ...(metric.measure.op === "count" ? [] : [metric.measure.field]),
      ...metric.dimensions,
    ];
    for (const field of fields)
      if (!model.columns.has(field))
        throw new Error(
          `lineage: metric "${metric.key}" reads "${field}", which is not a column of "${metric.table}".`,
        );
    return {
      key: metric.key,
      table: metric.table,
      fields,
      dimensions: metric.dimensions,
      measure: metric.measure,
    };
  });
}
