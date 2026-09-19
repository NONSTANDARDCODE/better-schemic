/**
 * Relation resolution shared by `include`, `_count` and the relational `where`: given a model's
 * `TableMeta` (+ the schema index), resolve an include/filter key to a record LINK FIELD or a graph
 * EDGE, and resolve an edge's direction/endpoints.
 *
 * The rules mirror `schema.ts` bootstrap validation: a record-link FIELD wins over a same-named
 * edge (the collision is a `SchemaInvalid` at bootstrap), so resolution checks `meta.links` first.
 * Direction is AUTO (outgoing `->` when the table is in `from`; incoming `<-` when only in `to`)
 * with an explicit `direction: "out" | "in" | "both"` override on the edge surfaces.
 */
import { escapeIdent } from "surrealdb";
import { BetterSchemicError } from "../errors";
import type { EdgeRef, SchemaIndex, TableMeta } from "../meta";
import { describeValue, isLowerableValue, isPlainObject } from "./shared";

/** The requested/derived direction of an edge traversal. */
export type EdgeDirection = "out" | "in" | "both";

/** A resolved graph edge: the schema entry + the arrow direction relative to this table. */
export interface ResolvedEdge {
  readonly edge: EdgeRef;
  /** `out` = `->`, `in` = `<-`, `both` = `<->`. */
  readonly direction: Exclude<EdgeDirection, "both"> | "both";
  /** Physical target table names the traversal reaches. */
  readonly targets: readonly string[];
}

/** Resolve an edge by its PHYSICAL name or its schema key (the schema key is the DX name). */
export function findEdge(meta: TableMeta, name: string): EdgeRef | undefined {
  return edgesOf(meta).find((edge) => edge.name === name || edge.key === name);
}

/** The relation edges adjacent to a table, outgoing + incoming (deduped by physical name). */
export function edgesOf(meta: TableMeta): readonly EdgeRef[] {
  const seen = new Map<string, EdgeRef>();
  for (const edge of [...meta.outgoing, ...meta.incoming])
    if (!seen.has(edge.name)) seen.set(edge.name, edge);
  return [...seen.values()];
}

/** The record-link fields + edge names a table exposes (for teaching "valid include keys" errors). */
export function availableKeys(meta: TableMeta): {
  links: readonly string[];
  edges: readonly string[];
} {
  return {
    links: [...meta.links.keys()],
    edges: edgesOf(meta).map((edge) => edge.name),
  };
}

/** A relation-resolution failure (`UnknownField` — a typo'd include/where key). */
function unknownKey(
  meta: TableMeta,
  key: string,
  what: string,
  operation: string,
): BetterSchemicError {
  const { links, edges } = availableKeys(meta);
  const known = [...links, ...edges];
  return new BetterSchemicError(
    "UnknownField",
    `${operation}: "${key}" is not a relation of "${meta.name}" (${what}). Known relations: ${known.length ? known.join(", ") : "(none)"}.`,
    { table: meta.name, field: key, operation, details: { known } },
  );
}

/**
 * Resolve an edge by name + direction. `explicit` enforces the requested direction (fail-fast when
 * the table isn't on that side); AUTO prefers outgoing, falls back to incoming.
 */
export function resolveEdge(
  meta: TableMeta,
  name: string,
  explicit: EdgeDirection | undefined,
  operation: string,
): ResolvedEdge {
  const outgoing = meta.outgoing.find(
    (edge) => edge.name === name || edge.key === name,
  );
  const incoming = meta.incoming.find(
    (edge) => edge.name === name || edge.key === name,
  );
  if (!outgoing && !incoming)
    throw unknownKey(meta, name, "an edge", operation);

  const requires = (direction: EdgeDirection): BetterSchemicError =>
    new BetterSchemicError(
      "ValidationError",
      `${operation}: "${name}" is not a ${direction === "out" ? "FROM" : "TO"} edge of "${meta.name}" — the declared endpoints do not allow direction "${direction}". Use the other direction or fix the relation.`,
      { table: meta.name, field: name, operation },
    );

  if (explicit === "out") {
    if (!outgoing) throw requires("out");
    return {
      edge: outgoing,
      direction: "out",
      targets: targetsOf(outgoing, "out"),
    };
  }
  if (explicit === "in") {
    if (!incoming) throw requires("in");
    return {
      edge: incoming,
      direction: "in",
      targets: targetsOf(incoming, "in"),
    };
  }
  if (explicit === "both") {
    if (!outgoing && !incoming) throw requires("out");
    const edge = (outgoing ?? incoming) as EdgeRef;
    // `targets` for `both` is informational; the traversal reaches both endpoint sides.
    const targets = [
      ...new Set([
        ...(outgoing ? targetsOf(outgoing, "out") : []),
        ...(incoming ? targetsOf(incoming, "in") : []),
      ]),
    ];
    return { edge, direction: "both", targets };
  }
  if (outgoing)
    return {
      edge: outgoing,
      direction: "out",
      targets: targetsOf(outgoing, "out"),
    };
  return {
    edge: incoming as EdgeRef,
    direction: "in",
    targets: targetsOf(incoming as EdgeRef, "in"),
  };
}

/** The physical target table names an edge reaches from `direction`. */
function targetsOf(edge: EdgeRef, direction: "out" | "in"): readonly string[] {
  const relation = edge.def.config.relation;
  return direction === "out"
    ? [...(relation?.to ?? [])]
    : [...(relation?.from ?? [])];
}

/** The arrow token of a direction (`->` / `<-` / `<->`). */
function arrowOf(direction: EdgeDirection): "->" | "<-" | "<->" {
  if (direction === "in") return "<-";
  if (direction === "both") return "<->";
  return "->";
}

/** A rendered edge ref: `likes` / `(likes WHERE score > $p)` / `?` (wildcard edge). */
function edgeRef(name: string, filter?: string): string {
  const ident = name === "?" ? "?" : escapeIdent(name);
  return filter ? `(${ident} WHERE ${filter})` : ident;
}

/** `post` / `(post, user)` / `?` — the target ref of a traversal. */
function targetRef(names: readonly string[]): string {
  if (names.length === 0) return "?";
  if (names.length === 1) return escapeIdent(names[0] as string);
  return `(${names.map(escapeIdent).join(", ")})`;
}

/**
 * `->(edge WHERE …)->(target WHERE …)` (`<-`/`<->` mirror both arrows). Omitting `targets` stops
 * at the edge (`->(edge WHERE …)`), which is what the `edge`+`target` projection needs.
 */
export function edgeTraversal(args: {
  readonly edge: string;
  readonly direction: EdgeDirection;
  readonly edgeFilter?: string;
  readonly targets?: readonly string[];
  readonly targetFilter?: string;
}): string {
  const arrow = arrowOf(args.direction);
  const head = `${arrow}${edgeRef(args.edge, args.edgeFilter)}`;
  if (args.targets === undefined) return head;
  const base = targetRef(args.targets);
  const target = args.targetFilter
    ? `(${base} WHERE ${args.targetFilter})`
    : base;
  return `${head}${arrow}${target}`;
}

/** Resolve the target `TableMeta` of a link field (undefined = a bare `record` / unknown target). */
export function targetMetas(
  index: SchemaIndex,
  targets: readonly string[] | undefined,
): readonly TableMeta[] {
  if (!targets) return [];
  const out: TableMeta[] = [];
  for (const name of targets) {
    const meta = index.byName.get(name);
    if (meta && !("schemaless" in meta)) out.push(meta);
  }
  return out;
}

/** The edge's own `TableMeta` (edges are schema entries too — their fields are decodable). */
export function edgeMeta(
  index: SchemaIndex,
  name: string,
): TableMeta | undefined {
  const meta = index.byName.get(name);
  return meta && !("schemaless" in meta) ? meta : undefined;
}

// --- where ownership (edge vs target) ------------------------------------------------------------

/** A `where` split by column owner: the edge predicate, the target predicate, or a raw fragment. */
export interface OwnedWhere {
  readonly edge?: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
  /** A whole-clause fragment — spliced into the target-side WHERE (cannot be split). */
  readonly fragment?: unknown;
}

/** `AND`/`OR`/`NOT` keys — conjunction can be distributed, the others cannot. */
const LOGICAL = new Set(["AND", "OR", "NOT"]);

/** Does `meta` declare `field` as a column, link or edge? (`id` is implicit on every table.) */
function ownsField(meta: TableMeta | undefined, field: string): boolean {
  if (!meta) return false;
  if (field === "id") return true;
  return (
    meta.columns.has(field) ||
    meta.links.has(field) ||
    meta.outgoing.some((edge) => edge.name === field || edge.key === field) ||
    meta.incoming.some((edge) => edge.name === field || edge.key === field)
  );
}

/**
 * Classify a relation filter object by column OWNER (the split decided for include/where):
 * a field declared on the edge compiles into the edge predicate, one declared on the target into
 * the target predicate; a name on both is ambiguous (except `id`, which the caller routes);
 * a name on neither is an `UnknownField` typo.
 */
export function classifyWhereByOwner(args: {
  readonly where: unknown;
  readonly edge?: TableMeta;
  readonly targets: readonly TableMeta[];
  /** Which owner wins for `id` (both tables always declare it). */
  readonly idOwner: "edge" | "target";
  readonly operation: string;
  /** Extra label for messages (`"include.likes"`, `"where.likes"`). */
  readonly context: string;
}): OwnedWhere {
  const { operation, context } = args;
  if (args.where === undefined || args.where === null) return {};
  if (isLowerableValue(args.where)) return { fragment: args.where };
  if (!isPlainObject(args.where))
    throw new BetterSchemicError(
      "ValidationError",
      `${operation}: ${context} expects a filter object, a fragment or { edge, target }, got ${describeValue(args.where)}.`,
      { operation, details: { where: args.where } },
    );

  const ownsEdge = (field: string) => ownsField(args.edge, field);
  const ownsTarget = (field: string) =>
    args.targets.length === 0
      ? !ownsEdge(field) || field === "id"
      : args.targets.some((meta) => ownsField(meta, field));

  /** The owner of a filter entry key. */
  const ownerOf = (field: string): "edge" | "target" => {
    const edge = ownsEdge(field);
    const target = ownsTarget(field);
    if (edge && target) {
      if (field === "id") return args.idOwner;
      throw new BetterSchemicError(
        "ValidationError",
        `${operation}: "${field}" exists on both the edge and the target — separate the filter (e.g. a surql fragment) so it is unambiguous.`,
        { operation, field },
      );
    }
    if (edge) return "edge";
    if (target) return "target";
    throw new BetterSchemicError(
      "UnknownField",
      `${operation}: "${field}" is not a column of the edge or the target — check the relation schema.`,
      { operation, field },
    );
  };

  const edge: Record<string, unknown> = {};
  const target: Record<string, unknown> = {};

  /** Gather every field name referenced inside a logical group (peeks one level of nesting). */
  const fieldsIn = (value: unknown): string[] => {
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const entry of v) walk(entry);
        return;
      }
      if (!isPlainObject(v)) return;
      for (const key of Object.keys(v)) {
        if (LOGICAL.has(key)) walk(v[key]);
        else out.push(key);
      }
    };
    walk(value);
    return out;
  };

  for (const [key, value] of Object.entries(args.where)) {
    if (value === undefined) continue;
    if (LOGICAL.has(key)) {
      const fields = fieldsIn(value);
      const owners = new Set(fields.map(ownerOf));
      if (fields.length === 0)
        throw new BetterSchemicError(
          "ValidationError",
          `${operation}: ${context}.${key} is empty — nothing to constrain.`,
          { operation },
        );
      if (owners.size !== 1)
        throw new BetterSchemicError(
          "ValidationError",
          `${operation}: ${context}.${key} mixes edge and target fields — split it into "edge"/"target" predicates or use a surql fragment.`,
          { operation },
        );
      const owner = [...owners][0] as "edge" | "target";
      (owner === "edge" ? edge : target)[key] = value;
      continue;
    }
    // A nested relational filter object (`{ likes: { some: … } }`) — classify by the key itself.
    (ownerOf(key) === "edge" ? edge : target)[key] = value;
  }

  return {
    ...(Object.keys(edge).length ? { edge } : {}),
    ...(Object.keys(target).length ? { target } : {}),
  };
}
