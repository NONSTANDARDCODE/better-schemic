/**
 * The `include` decode specs + the compiler context shared by the `include/` modules. `../decode`
 * reads these to hydrate the fetched/remounted relations.
 */
import type { SchemaIndex, TableMeta } from "../../meta";
import type { ProjectionSpec } from "../projection";
import type { Binds } from "../shared";

/** A relation hydration entry produced by the include compiler. */
export type IncludeSpec =
  | LinkFetchSpec
  | LinkProjectionSpec
  | EdgeIncludeSpec
  | CountIncludeSpec;

/** `include: { author: true }` / `{ author: { include: … } }` — FETCH materializes the link. */
export interface LinkFetchSpec {
  readonly kind: "link-fetch";
  readonly key: string;
  readonly list: boolean;
  /** Physical target names (empty = a bare `record` — decode by the row's own id table). */
  readonly targets: readonly string[];
  readonly nested: readonly IncludeSpec[];
}

/** `include: { author: { select: … } }` — flat columns remounted into the link object. */
export interface LinkProjectionSpec {
  readonly kind: "link-projection";
  readonly key: string;
  readonly list: boolean;
  readonly targets: readonly string[];
  readonly leaves: readonly LinkLeafSpec[];
}

/** One flat link leaf: `author.id AS author_id` -> `author: { id }`. */
export interface LinkLeafSpec {
  /** Path inside the remounted object (`["address", "city"]`; empty = presence-only leaf). */
  readonly out: readonly string[];
  /** The flat top-level key in the raw row (`author_address_city`). */
  readonly source: string;
  /** Path in the TARGET shape (brackets preserved) for codec resolution. */
  readonly schemaPath: readonly string[];
}

/** The decoded projection of one target table. */
export interface TargetEntry {
  /** Physical target name (`""` for the wildcard passthrough entry). */
  readonly name: string;
  readonly meta?: TableMeta;
  readonly spec: ProjectionSpec;
}

/** How to decode the target records of an edge include. */
export interface TargetProjection {
  readonly entries: readonly TargetEntry[];
  /** No declared targets (`->?`) — rows pass through undecoded. */
  readonly wildcard: boolean;
}

/** The edge projection of an `edge:` entry. */
export interface EdgeProjection {
  readonly meta?: TableMeta;
  readonly spec: ProjectionSpec;
  readonly wildcard: boolean;
}

/** Edge records alone: `(SELECT <edgeProj> FROM ->edge)`. */
export interface EdgeRecordSpec {
  readonly kind: "edge";
  readonly shape: "edge";
  readonly key: string;
  readonly edge: EdgeProjection;
}

/** Target records alone: `(SELECT <targetProj> FROM ->edge->target)`. */
export interface EdgeTargetSpec {
  readonly kind: "edge";
  readonly shape: "target";
  readonly key: string;
  readonly target: TargetProjection;
}

/** `{ edge, target }` remount — the row IS the edge, the target lives under `out`/`in`. */
export interface EdgeRemountSpec {
  readonly kind: "edge";
  readonly shape: "edge-target";
  readonly key: string;
  /** The materialized target key inside the row. */
  readonly alias: "out" | "in";
  readonly target: TargetProjection;
  readonly edge: EdgeProjection;
}

/** `include: { likes: … }` — a per-parent traversal subquery. */
export type EdgeIncludeSpec = EdgeRecordSpec | EdgeTargetSpec | EdgeRemountSpec;

/** One `_count` key — `count(->likes) AS _count_likes`. */
export interface CountIncludeSpec {
  readonly kind: "count";
  readonly key: string;
  /** The flat raw key holding the number. */
  readonly source: string;
}

/** The compiled `include` of one read. */
export interface IncludeCompiled {
  /** SQL expressions appended to the projection. */
  readonly parts: readonly string[];
  /** FETCH paths (`FETCH author.profile, editor`) — the clause is emitted last. */
  readonly fetch: readonly string[];
  /** Top-level link fields materialized by FETCH (the base `*` decode must pass them through). */
  readonly passthrough: readonly string[];
  /** Hydration specs. */
  readonly specs: readonly IncludeSpec[];
  /** Top-level keys the include occupies (for conflict checks). */
  readonly keys: readonly string[];
}

/** The include compiler's shared mutable state (projection + hydration accumulators). */
export interface CompileCtx {
  readonly binds: Binds;
  readonly index: SchemaIndex;
  readonly operation: string;
  /** SQL expressions appended to the read's projection. */
  readonly parts: string[];
  /** Hydration specs for the decoder. */
  readonly specs: IncludeSpec[];
  /** FETCH paths (emitted as the read's LAST clause). */
  readonly fetch: string[];
  /** Link fields materialized by FETCH (the base `*` decode passes them through). */
  readonly passthrough: string[];
  /** Claim a projected flat alias (rejects column collisions + duplicates). */
  readonly claimFlat: (key: string) => void;
}

export const EMPTY_INCLUDE: IncludeCompiled = {
  parts: [],
  fetch: [],
  passthrough: [],
  specs: [],
  keys: [],
};
