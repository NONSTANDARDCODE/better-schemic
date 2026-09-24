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
import type { EdgeRef, FieldFamily, SchemaIndex, TableMeta } from "../meta";
import {
  classifyWhereByOwner,
  type EdgeDirection,
  edgeTraversal,
  findEdge,
  resolveEdge,
  edgeMeta as resolveEdgeMeta,
  targetMetas,
} from "./relations";
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
  /** The schema index — required for RELATIONAL operators (`some`/`every`/`none`/`is`/`isNot`). */
  readonly index?: SchemaIndex;
  /** A path prefix applied to every field (`out`/`in` in edge includes, the link in `is`). */
  readonly prefix?: string;
  /** The operation label for teaching messages (defaults to `where`). */
  readonly operation?: string;
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

/** Relation-only operators (`is`/`isNot` on a single link; `some`/`every`/`none` on a collection). */
const RELATION_OPS = new Set(["is", "isNot", "some", "every", "none"]);

/** Compile one field entry (`{ age: {...} }` / `{ 'address.city': 'BR' }`). */
function compileFieldValue(
  field: string,
  value: unknown,
  binds: Binds,
  options: WhereOptions,
): string | undefined {
  const context: FieldFilterContext = {
    path: renderPath(options.prefix ? `${options.prefix}.${field}` : field),
    field,
    family: familyOf(field, options.meta),
    arrayPath: isArrayPath(field),
    binds,
    options,
  };
  if (!isFilterObject(value)) {
    // A fragment on a relation key is a whole correlated PREDICATE, not a value
    // (`{ likes: surql`count(->likes) > ${2}` }`).
    if (relationOf(context) && isLowerableValue(value))
      return paren(renderValue(value, binds, binds.ctx()));
    return equality(context, value);
  }
  const operators = Object.entries(value).filter(([, v]) => v !== undefined);
  if (operators.length === 0) return undefined;
  const relationOps = operators.filter(([op]) => RELATION_OPS.has(op));
  if (relationOps.length === 0) return compileOperators(context, operators);
  const foreign = operators.filter(
    ([op]) => !RELATION_OPS.has(op) && op !== "direction",
  );
  if (foreign.length > 0)
    throw compileError(
      "ValidationError",
      `"${field}" mixes relational operators (${relationOps.map(([op]) => op).join("/")}) with "${foreign[0]?.[0]}" — use either form.`,
      { field },
    );
  return compileRelation(context, relationOps, value);
}

/** What kind of relation a where key resolves to (`undefined` = a plain column). */
type RelationKind =
  | {
      readonly kind: "link";
      readonly cardinality: "one" | "many";
      /** Resolved target metas (empty for a bare/union link — operators stay loose). */
      readonly targets: readonly TableMeta[];
      readonly meta: TableMeta;
      readonly index: SchemaIndex;
    }
  | {
      readonly kind: "edge";
      readonly edge: EdgeRef;
      readonly meta: TableMeta;
      readonly index: SchemaIndex;
    };

/** Resolve a key to a relation of the CURRENT scope's table (links win over same-named edges). */
function relationOf(context: FieldFilterContext): RelationKind | undefined {
  const { meta, index } = context.options;
  if (!meta || !index) return undefined;
  const link = meta.links.get(context.field);
  if (link)
    return {
      kind: "link",
      cardinality: link.cardinality,
      targets: targetMetas(index, link.targets),
      meta,
      index,
    };
  const edge = findEdge(meta, context.field);
  return edge ? { kind: "edge", edge, meta, index } : undefined;
}

/** Compile `is`/`isNot` (links) and `some`/`every`/`none` (edges and array links). */
function compileRelation(
  context: FieldFilterContext,
  operators: readonly (readonly [string, unknown])[],
  value: Record<string, unknown>,
): string {
  const { field } = context;
  const operation = context.options.operation ?? "where";
  const relation = relationOf(context);
  if (!relation)
    throw compileError(
      "ValidationError",
      `"${operators[0]?.[0]}" is a relational operator, but "${field}" is not a link or edge of this table. Use the relation key (schema links/edges).`,
      { field },
    );
  const direction = relationFilterDirection(value, operation, field);

  if (relation.kind === "link" && relation.cardinality === "one")
    return compileSingleLink(context, relation, operators, direction);
  return compileCollection(context, relation, operators, direction);
}

/** Parse the optional `direction` alongside the relational operator. */
function relationFilterDirection(
  value: Record<string, unknown>,
  operation: string,
  field: string,
): EdgeDirection | undefined {
  const raw = value.direction;
  if (raw === undefined) return undefined;
  if (raw !== "out" && raw !== "in" && raw !== "both")
    throw compileError(
      "ValidationError",
      `${operation}: "${field}.direction" must be "out", "in" or "both" (got ${describeValue(raw)}).`,
      { field },
    );
  return raw;
}

/** `is`/`isNot` on a single record link — the target filter compiles behind the link path. */
function compileSingleLink(
  context: FieldFilterContext,
  relation: Extract<RelationKind, { kind: "link" }>,
  operators: readonly (readonly [string, unknown])[],
  direction: EdgeDirection | undefined,
): string {
  const { field, path, binds } = context;
  const operation = context.options.operation ?? "where";
  if (direction !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "direction" is only valid on edges, not on the link "${field}".`,
      { field },
    );
  const invalid = operators.find(([op]) => op !== "is" && op !== "isNot");
  if (invalid)
    throw compileError(
      "ValidationError",
      `${operation}: "${invalid[0]}" does not apply to the single link "${field}" — use "is"/"isNot" (or make it an array link).`,
      { field },
    );
  const target =
    relation.targets.length === 1 ? relation.targets[0] : undefined;
  const parts: string[] = [];
  for (const [op, operand] of operators) {
    if (!isFilterObject(operand))
      throw compileError(
        "ValidationError",
        `${operation}: "${field}.${op}" expects a filter object (got ${describeValue(operand)}).`,
        { field },
      );
    const predicate = compileWhere(operand, binds, {
      ...(target ? { meta: target } : {}),
      ...(context.options.index ? { index: context.options.index } : {}),
      prefix: path,
      operation,
    });
    if (predicate === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: "${field}.${op}" is an empty filter — nothing to constrain.`,
        { field },
      );
    parts.push(op === "isNot" ? `NOT (${predicate})` : predicate);
  }
  return joinAnd(parts);
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
        `unknown where operator "${op}" on "${field}". See docs/orm-syntax-map.md §4 for the vocabulary.`,
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

/** `some`/`every`/`none` over a link array or a graph edge (counts, NONE-safe). */
function compileCollection(
  context: FieldFilterContext,
  relation: Extract<RelationKind, { kind: "link" } | { kind: "edge" }>,
  operators: readonly (readonly [string, unknown])[],
  direction: EdgeDirection | undefined,
): string {
  const { field, path } = context;
  const operation = context.options.operation ?? "where";
  const invalid = operators.find(
    ([op]) => op !== "some" && op !== "every" && op !== "none",
  );
  if (invalid)
    throw compileError(
      "ValidationError",
      `${operation}: "${invalid[0]}" does not apply to the ${relation.kind === "edge" ? `edge "${field}"` : `array link "${field}"`} — use some/every/none.`,
      { field },
    );

  const resolved =
    relation.kind === "edge"
      ? resolveEdge(relation.meta, field, direction, operation)
      : undefined;
  const edgeMeta =
    resolved !== undefined
      ? resolveEdgeMeta(relation.index, resolved.edge.name)
      : undefined;
  const targets =
    resolved !== undefined ? targetMetas(relation.index, resolved.targets) : [];

  const parts: string[] = [];
  for (const [op, operand] of operators) {
    let base = path;
    let filtered: string;
    if (resolved) {
      const compiled = compileEdgeOperand(context, operand, edgeMeta, targets);
      if (!compiled.edge && !compiled.target)
        throw compileError(
          "ValidationError",
          `${operation}: "${field}.${op}" is an empty filter — nothing to constrain.`,
          { field },
        );
      base = edgeTraversal({
        edge: resolved.edge.name,
        direction: resolved.direction,
        targets: resolved.targets,
      });
      filtered = edgeTraversal({
        edge: resolved.edge.name,
        direction: resolved.direction,
        ...(compiled.edge ? { edgeFilter: compiled.edge } : {}),
        targets: resolved.targets,
        ...(compiled.target ? { targetFilter: compiled.target } : {}),
      });
    } else {
      const predicate = compileLinkOperand(
        context,
        operand,
        relation.kind === "link" ? relation.targets : [],
      );
      if (predicate === undefined)
        throw compileError(
          "ValidationError",
          `${operation}: "${field}.${op}" is an empty filter — nothing to constrain.`,
          { field },
        );
      filtered = `${path}[WHERE ${predicate}]`;
    }
    if (op === "some") parts.push(`count(${filtered}) > 0`);
    else if (op === "none") parts.push(`count(${filtered}) = 0`);
    else parts.push(`count(${base}) = count(${filtered})`);
  }
  return joinAnd(parts);
}

/** A relation filter compiled per column owner (edge predicate / target predicate / fragment). */
export interface CompiledRelationFilter {
  readonly edge?: string;
  readonly target?: string;
  /** A whole-clause fragment, already parenthesized (`surql` / param ref). */
  readonly fragment?: string;
}

/**
 * Compile a relation filter split by column OWNER — the ONE lowering shared by `where` relational
 * operators, `include.where` and `_count.where`: a field declared on the edge compiles into the
 * edge predicate, one on the target into the target predicate (prefixed when the row IS the edge),
 * and a whole-clause fragment is rendered raw. `../relations.classifyWhereByOwner` owns the split.
 */
export function compileRelationFilter(args: {
  readonly where: unknown;
  readonly edge?: TableMeta;
  readonly targets: readonly TableMeta[];
  /** Which owner wins for `id` (both always declare it). */
  readonly idOwner: "edge" | "target";
  /** Path prefix for the target predicate (`out`/`in` when the row is the edge). */
  readonly prefix?: string;
  readonly index?: SchemaIndex;
  readonly binds: Binds;
  readonly operation: string;
  /** Extra label for teaching messages (`include.likes`, `where.likes`). */
  readonly context: string;
}): CompiledRelationFilter {
  const owned = classifyWhereByOwner({
    where: args.where,
    ...(args.edge ? { edge: args.edge } : {}),
    targets: args.targets,
    idOwner: args.idOwner,
    operation: args.operation,
    context: args.context,
  });
  const edge = owned.edge
    ? compileWhere(owned.edge, args.binds, {
        ...(args.edge ? { meta: args.edge } : {}),
        ...(args.index ? { index: args.index } : {}),
        operation: args.operation,
      })
    : undefined;
  const target = owned.target
    ? compileWhere(owned.target, args.binds, {
        ...(args.targets.length === 1 ? { meta: args.targets[0] } : {}),
        ...(args.index ? { index: args.index } : {}),
        ...(args.prefix ? { prefix: args.prefix } : {}),
        operation: args.operation,
      })
    : undefined;
  const fragment = owned.fragment
    ? paren(renderValue(owned.fragment, args.binds, args.binds.ctx()))
    : undefined;
  return {
    ...(edge ? { edge } : {}),
    ...(target ? { target } : {}),
    ...(fragment ? { fragment } : {}),
  };
}

/** Split + compile one edge operand into its edge-side and target-side predicates. */
function compileEdgeOperand(
  context: FieldFilterContext,
  operand: unknown,
  edgeMeta: TableMeta | undefined,
  targets: readonly TableMeta[],
): { readonly edge?: string; readonly target?: string } {
  const { binds } = context;
  const operation = context.options.operation ?? "where";
  const index = context.options.index;
  if (isLowerableValue(operand))
    return { target: paren(renderValue(operand, binds, binds.ctx())) };
  if (!isFilterObject(operand))
    throw compileError(
      "ValidationError",
      `${operation}: "${context.field}" expects a filter object or a fragment (got ${describeValue(operand)}).`,
      { field: context.field },
    );
  if (!edgeMeta)
    return {
      target: compileWhere(operand, binds, {
        ...(targets.length === 1 ? { meta: targets[0] } : {}),
        ...(index ? { index } : {}),
        operation,
      }),
    };
  const compiled = compileRelationFilter({
    where: operand,
    edge: edgeMeta,
    targets,
    idOwner: "target",
    ...(index ? { index } : {}),
    binds,
    operation,
    context: `where.${context.field}`,
  });
  const target = [compiled.target, compiled.fragment]
    .filter(Boolean)
    .join(" AND ");
  return {
    ...(compiled.edge ? { edge: compiled.edge } : {}),
    ...(target ? { target } : {}),
  };
}

/** Compile one array-link operand (the element rows are the link targets). */
function compileLinkOperand(
  context: FieldFilterContext,
  operand: unknown,
  targets: readonly TableMeta[],
): string | undefined {
  const { binds } = context;
  const operation = context.options.operation ?? "where";
  const index = context.options.index;
  if (isLowerableValue(operand))
    return paren(renderValue(operand, binds, binds.ctx()));
  if (!isFilterObject(operand))
    throw compileError(
      "ValidationError",
      `${operation}: "${context.field}" expects a filter object or a fragment (got ${describeValue(operand)}).`,
      { field: context.field },
    );
  const target = targets.length === 1 ? targets[0] : undefined;
  return compileWhere(operand, binds, {
    ...(target ? { meta: target } : {}),
    ...(index ? { index } : {}),
    operation,
  });
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
