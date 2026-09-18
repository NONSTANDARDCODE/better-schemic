/**
 * The `where` compiler — the typed filter vocabulary lowered to a SurrealQL predicate. Every value
 * binds (`$p0`, `$p1`, …) and every field name is escaped (see `./shared`), so a `where` can never
 * inject syntax. Operator dispatch is FAMILY-AWARE only where the language is ambiguous:
 * `length` (`string::len` vs `array::len`) and `outside` (interval vs set membership). The family
 * comes from the shared field walker (`wire.ts`) via `TableMeta.columns` — never from re-parsing a
 * type string.
 *
 * Verified forms live in `docs/orm-syntax-map.md` §4; unverified spellings (`~`/`?~`/`*~`) are
 * rejected with a teaching `UnsupportedCapability` instead of being emitted.
 */
import { RecordId } from "surrealdb";
import type { FieldFamily, TableMeta } from "../meta";
import {
  type Binds,
  compileError,
  describeValue,
  isArrayPath,
  isLowerableValue,
  isPlainObject,
  joinAnd,
  paren,
  renderPath,
  renderValue,
  splitRecordId,
} from "./shared";

/** Options shared by every clause compiler. */
export interface WhereOptions {
  /** Table metadata, for family-aware operators (`length`, `outside`, `near`). */
  readonly meta?: TableMeta;
}

/** Compile a `where` input to its predicate text (no `WHERE` keyword); `undefined` = no filter. */
export function compileWhere(
  where: unknown,
  binds: Binds,
  options: WhereOptions = {},
): string | undefined {
  if (where === undefined || where === null) return undefined;
  if (isLowerableValue(where)) return renderValue(where, binds, binds.ctx());
  if (!isPlainObject(where))
    throw compileError(
      "ValidationError",
      `where must be a filter object or a fragment, got ${describeValue(where)}.`,
      { details: where },
    );

  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR") {
      parts.push(paren(compileLogical(key, value, binds, options)));
      continue;
    }
    if (key === "NOT") {
      parts.push(`NOT (${compileLogical("AND", value, binds, options)})`);
      continue;
    }
    const compiled = compileFieldValue(key, value, binds, options);
    if (compiled !== undefined) parts.push(compiled);
  }
  return parts.length ? joinAnd(parts) : undefined;
}

/** Compile an `AND`/`OR`/`NOT` operand (each entry a full filter object). */
function compileLogical(
  joiner: "AND" | "OR",
  value: unknown,
  binds: Binds,
  options: WhereOptions,
): string {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0)
    throw compileError(
      "ValidationError",
      `${joiner} expects a non-empty filter or array of filters.`,
    );
  return entries
    .map((entry, i) => {
      const compiled = compileWhere(entry, binds, options);
      if (compiled === undefined)
        throw compileError(
          "ValidationError",
          `${joiner}[${i}] is an empty filter — every ${joiner} branch must constrain something.`,
        );
      return compiled;
    })
    .join(` ${joiner} `);
}

/** The compiled context of one field's filter (escaped path, family, binds). */
interface FieldFilterContext {
  /** The escaped path (`address.city`, `contacts[*].type`). */
  readonly path: string;
  /** The raw field name, for teaching messages. */
  readonly field: string;
  readonly family: FieldFamily | undefined;
  readonly arrayPath: boolean;
  readonly binds: Binds;
  readonly options: WhereOptions;
}

/** Compile one field entry (`{ age: {...} }` / `{ 'address.city': 'BR' }`). */
function compileFieldValue(
  field: string,
  value: unknown,
  binds: Binds,
  options: WhereOptions,
): string | undefined {
  const context: FieldFilterContext = {
    path: renderPath(field),
    field,
    family: familyOf(field, options.meta),
    arrayPath: isArrayPath(field),
    binds,
    options,
  };
  if (!isFilterObject(value)) return equality(context, value);
  const operators = Object.entries(value).filter(([, v]) => v !== undefined);
  if (operators.length === 0) return undefined;
  return compileOperators(context, operators);
}

/** AND-join a field filter object's operators. */
function compileOperators(
  context: FieldFilterContext,
  operators: readonly (readonly [string, unknown])[],
): string {
  return joinAnd(
    operators.map(([op, operand]) => compileOperator(context, op, operand)),
  );
}

/** One operator of a field filter. */
function compileOperator(
  context: FieldFilterContext,
  op: string,
  operand: unknown,
): string {
  const { path, field, family, arrayPath, binds } = context;
  const ctx = binds.ctx();
  const value = (v: unknown = operand) =>
    renderValue(coerceRecord(context, v), binds, ctx);
  switch (op) {
    case "equals":
      return equality(context, operand);
    case "notEquals":
      return arrayPath
        ? `${path} CONTAINSNOT ${value()}`
        : `${path} != ${value()}`;
    case "exact":
      return `${path} == ${value()}`;
    case "isNull":
      requireFlag(op, operand);
      return `${path} = NULL`;
    case "isNotNull":
      requireFlag(op, operand);
      return `${path} != NULL`;
    case "isNone":
      requireFlag(op, operand);
      return `${path} = NONE`;
    case "isNotNone":
      requireFlag(op, operand);
      return `${path} != NONE`;
    case "not": {
      if (!isFilterObject(operand))
        throw compileError(
          "ValidationError",
          `"not" on "${field}" expects a filter object, got ${describeValue(operand)}.`,
          { field },
        );
      const operators = Object.entries(operand).filter(
        ([, v]) => v !== undefined,
      );
      if (operators.length === 0)
        throw compileError(
          "ValidationError",
          `"not" on "${field}" has an empty filter — nothing to negate.`,
          { field },
        );
      return `NOT (${compileOperators(context, operators)})`;
    }
    case "lt":
      return `${path} < ${value()}`;
    case "lte":
      return `${path} <= ${value()}`;
    case "gt":
      return `${path} > ${value()}`;
    case "gte":
      return `${path} >= ${value()}`;
    case "between":
    case "inRange": {
      const [a, b] = bounds(op, operand);
      return `${path} >= ${value(a)} AND ${path} <= ${value(b)}`;
    }
    case "outside":
      if (isComparable(family)) {
        const [a, b] = bounds(op, operand);
        return paren(`${path} < ${value(a)} OR ${path} > ${value(b)}`);
      }
      return `${path} OUTSIDE ${value()}`;
    case "in":
      return `${path} IN ${value()}`;
    case "notIn":
      return `${path} NOT IN ${value()}`;
    case "any":
      return compileAnyAll("?", context, operand);
    case "all":
      return compileAnyAll("*", context, operand);
    case "contains":
      return `${path} CONTAINS ${value()}`;
    case "containsNot":
      return `${path} CONTAINSNOT ${value()}`;
    case "containsAll":
      return `${path} CONTAINSALL ${value()}`;
    case "containsAny":
      return `${path} CONTAINSANY ${value()}`;
    case "containsNone":
      return `${path} CONTAINSNONE ${value()}`;
    case "inside":
      return `${path} INSIDE ${value()}`;
    case "notInside":
      return `${path} NOTINSIDE ${value()}`;
    case "allInside":
      return `${path} ALLINSIDE ${value()}`;
    case "anyInside":
      return `${path} ANYINSIDE ${value()}`;
    case "noneInside":
      return `${path} NONEINSIDE ${value()}`;
    case "intersects":
      return `${path} INTERSECTS ${value()}`;
    case "anyEquals":
      return `${path} ?= ${value()}`;
    case "allEquals":
      return `${path} *= ${value()}`;
    case "length":
      return `${
        family === "string" ? "string::len" : "array::len"
      }(${path}) = ${value()}`;
    case "startsWith":
      return `string::starts_with(${path}, ${value()})`;
    case "endsWith":
      return `string::ends_with(${path}, ${value()})`;
    case "matches":
      if (!(operand instanceof RegExp))
        throw compileError(
          "ValidationError",
          `"matches" on "${field}" expects a RegExp (e.g. /^post-/), got ${describeValue(operand)}.`,
          { field },
        );
      return `string::matches(${path}, ${regexLiteral(operand, field)})`;
    case "eqInsensitive":
      return `string::lowercase(${path}) = string::lowercase(${value()})`;
    case "containsInsensitive":
      return `string::lowercase(${path}) CONTAINS string::lowercase(${value()})`;
    case "matchesFullText":
      return compileFullText(context, operand);
    case "near":
      return compileNear(context, operand);
    case "fuzzy":
    case "anyFuzzy":
    case "allFuzzy":
      throw compileError(
        "UnsupportedCapability",
        `"${op}" is not valid SurrealQL 3.x ("~"/"?~"/"*~" are parse errors). Use a fragment: surql\`string::similarity::*(${renderPath(field)}, \${term})\`, or a full-text index with "matchesFullText".`,
        { field },
      );
    default:
      throw compileError(
        "ValidationError",
        `unknown where operator "${op}" on "${field}". See PLANO-QUERYS-TIPADAS.md §2.2.2 for the vocabulary.`,
        { field, details: { operator: op } },
      );
  }
}

/** The `any`/`all` comparison family — `f ?< $p` / `f *>= $p`, AND-joined. */
function compileAnyAll(
  prefix: "?" | "*",
  context: FieldFilterContext,
  operand: unknown,
): string {
  const { path, field, binds } = context;
  const ctx = binds.ctx();
  const label = prefix === "?" ? "any" : "all";
  if (!isFilterObject(operand))
    throw compileError(
      "ValidationError",
      `"${label}" on "${field}" expects a comparison filter, got ${describeValue(operand)}.`,
      { field },
    );
  const SYMBOLS: Record<string, string> = {
    lt: "<",
    lte: "<=",
    gt: ">",
    gte: ">=",
    equals: "=",
  };
  const parts: string[] = [];
  for (const [op, bound] of Object.entries(operand)) {
    if (bound === undefined) continue;
    const symbol = SYMBOLS[op];
    if (!symbol)
      throw compileError(
        "ValidationError",
        `"${label}" on "${field}" supports lt/lte/gt/gte/equals, got "${op}".`,
        { field },
      );
    parts.push(
      `${path} ${prefix}${symbol} ${renderValue(coerceRecord(context, bound), binds, ctx)}`,
    );
  }
  if (parts.length === 0)
    throw compileError(
      "ValidationError",
      `"${label}" on "${field}" has no comparison — pass at least one of lt/lte/gt/gte/equals.`,
      { field },
    );
  return joinAnd(parts);
}

/** `matchesFullText: 'term'` / `{ query, index?|indexes?, operator? }` -> `@@` / `@n@`. */
function compileFullText(
  context: FieldFilterContext,
  operand: unknown,
): string {
  const { path, field, binds } = context;
  const ctx = binds.ctx();
  if (typeof operand === "string")
    return `${path} @@ ${renderValue(operand, binds, ctx)}`;
  if (!isFilterObject(operand))
    throw compileError(
      "ValidationError",
      `"matchesFullText" on "${field}" expects a string or { query, index|indexes, operator }, got ${describeValue(operand)}.`,
      { field },
    );
  const query = operand.query;
  if (typeof query !== "string")
    throw compileError(
      "ValidationError",
      `"matchesFullText.query" on "${field}" must be a string.`,
      { field },
    );
  if (operand.index !== undefined && operand.indexes !== undefined)
    throw compileError(
      "ValidationError",
      `"matchesFullText" on "${field}": pass "index" OR "indexes", not both.`,
      { field },
    );
  const rawIndexes =
    operand.indexes !== undefined
      ? (operand.indexes as unknown[])
      : operand.index !== undefined
        ? [operand.index]
        : [];
  const indexes = rawIndexes.map((i) => {
    if (!Number.isInteger(i) || (i as number) < 0)
      throw compileError(
        "ValidationError",
        `"matchesFullText" index on "${field}" must be a non-negative integer (got ${describeValue(i)}).`,
        { field },
      );
    return i as number;
  });
  const operator = operand.operator ?? "AND";
  if (operator !== "AND" && operator !== "OR")
    throw compileError(
      "ValidationError",
      `"matchesFullText.operator" on "${field}" must be "AND" or "OR".`,
      { field },
    );
  const bind = renderValue(query, binds, ctx);
  if (indexes.length === 0) return `${path} @@ ${bind}`;
  const parts = indexes.map((i) => `${path} @${i}@ ${bind}`);
  return parts.length === 1
    ? (parts[0] as string)
    : paren(parts.join(` ${operator} `));
}

/** `near: { vector, k, distance? }` (KNN) or `{ point, distance }` (geo radius). */
function compileNear(context: FieldFilterContext, operand: unknown): string {
  const { path, field, binds } = context;
  const ctx = binds.ctx();
  if (!isFilterObject(operand))
    throw compileError(
      "ValidationError",
      `"near" on "${field}" expects { vector, k, distance? } or { point, distance }, got ${describeValue(operand)}.`,
      { field },
    );
  if (operand.vector !== undefined) {
    const k = operand.k;
    if (!Number.isInteger(k) || (k as number) <= 0)
      throw compileError(
        "ValidationError",
        `"near.k" on "${field}" must be a positive integer (got ${describeValue(k)}).`,
        { field },
      );
    const metric = operand.distance;
    const metricText =
      metric === undefined ? "" : `, ${metricName(metric, field)}`;
    return `${path} <|${k as number}${metricText}|> ${renderValue(operand.vector, binds, ctx)}`;
  }
  if (operand.point !== undefined) {
    const distance = operand.distance;
    if (typeof distance !== "number")
      throw compileError(
        "ValidationError",
        `"near.distance" on "${field}" must be a number (the radius) when using "point".`,
        { field },
      );
    return `geo::distance(${path}, ${renderValue(operand.point, binds, ctx)}) <= ${renderValue(distance, binds, ctx)}`;
  }
  throw compileError(
    "ValidationError",
    `"near" on "${field}" needs "vector" (KNN) or "point" (geo distance).`,
    { field },
  );
}

/** A KNN metric: an identifier-safe name, canonicalized to SurrealQL's uppercase spelling. */
function metricName(metric: unknown, field: string): string {
  if (typeof metric !== "string" || !/^[A-Za-z]+$/.test(metric))
    throw compileError(
      "ValidationError",
      `"near.distance" on "${field}" must be a metric name like "cosine"/"euclidean" (got ${describeValue(metric)}).`,
      { field },
    );
  return metric.toUpperCase();
}

/** `f = $p` / `f != $p`; a `[*]` path's value is an ARRAY, so equality is membership (`CONTAINS`). */
function equality(context: FieldFilterContext, value: unknown): string {
  const { path, arrayPath, binds } = context;
  if (value === null) return `${path} = NULL`;
  return arrayPath
    ? `${path} CONTAINS ${renderValue(coerceRecord(context, value), binds, binds.ctx())}`
    : `${path} = ${renderValue(coerceRecord(context, value), binds, binds.ctx())}`;
}

/**
 * Coerce string record values (`user:aeon`) to `RecordId` when the filter targets a record column
 * itself (not a path THROUGH a record). A bare `"a:b"` string on a record field would otherwise
 * bind as a string and silently match nothing.
 */
function coerceRecord(context: FieldFilterContext, value: unknown): unknown {
  if (context.field.includes(".")) return value;
  const base = context.field.replace(/\[.*$/, "");
  const column = context.options.meta?.columns.get(base);
  if (!column?.record) return value;
  return Array.isArray(value)
    ? value.map((entry) => coerceRecordId(entry))
    : coerceRecordId(value);
}

/** `"user:aeon"` -> `RecordId` (strings without a table stay untouched). */
function coerceRecordId(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parts = splitRecordId(value);
  return parts ? new RecordId(parts.table, parts.id) : value;
}

/** The base column's family (from `wire.ts` classification), when the table is typed. */
function familyOf(path: string, meta?: TableMeta): FieldFamily | undefined {
  const first = path.split(".")[0] ?? "";
  return meta?.columns.get(first.replace(/\[.*$/, ""))?.family;
}

/** Number/date/duration fields treat `outside: [a, b]` as the interval complement. */
function isComparable(family: FieldFamily | undefined): boolean {
  return family === "number" || family === "date" || family === "duration";
}

/** A `[a, b]` tuple operand for `between`/`outside`/`inRange`. */
function bounds(op: string, operand: unknown): [unknown, unknown] {
  if (!Array.isArray(operand) || operand.length !== 2)
    throw compileError(
      "ValidationError",
      `"${op}" expects exactly two bounds: [min, max] (got ${describeValue(operand)}).`,
    );
  return [operand[0], operand[1]];
}

/** `isNull`/`isNone`-style flags take `true` (the key's presence is the intent). */
function requireFlag(op: string, operand: unknown): void {
  if (operand !== true)
    throw compileError(
      "ValidationError",
      `"${op}" is a presence check — pass true (got ${describeValue(operand)}).`,
    );
}

/** Compile a RegExp to a SurrealQL regex literal (Rust syntax: inline flags, no trailing flags). */
function regexLiteral(re: RegExp, field: string): string {
  const flags = re.flags.replace(/[gyd]/g, "");
  if (/[^imsx]/.test(flags))
    throw compileError(
      "ValidationError",
      `"matches" on "${field}" uses unsupported RegExp flags "${flags}" — use i/m/s/x, or a surql fragment.`,
      { field },
    );
  return `/${flags ? `(?${flags})` : ""}${re.source}/`;
}

/** A plain object that isn't a lowerable fragment/ref/range. */
function isFilterObject(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && !isLowerableValue(v);
}
