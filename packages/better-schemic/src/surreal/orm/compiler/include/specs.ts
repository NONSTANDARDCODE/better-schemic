/**
 * The `include` decode specs + the compiler context shared by the `include/` modules. `../decode`
 * reads these to hydrate the fetched/remounted relations.
 */
import type { SchemaIndex, TableMeta } from "../../meta"
import type { ProjectionSpec } from "../projection"
import type { Binds } from "../shared"

/** A relation hydration entry produced by the include compiler. */
export type IncludeSpec = CountIncludeSpec | EdgeIncludeSpec | LinkFetchSpec | LinkProjectionSpec

/** `include: { author: true }` / `{ author: { include: … } }` — FETCH materializes the link. */
export type LinkFetchSpec = {
  readonly key: string
  readonly kind: "link-fetch"
  readonly list: boolean
  readonly nested: readonly IncludeSpec[]
  /** Physical target names (empty = a bare `record` — decode by the row's own id table). */
  readonly targets: readonly string[]
}

/** `include: { author: { select: … } }` — flat columns remounted into the link object. */
export type LinkProjectionSpec = {
  readonly key: string
  readonly kind: "link-projection"
  readonly leaves: readonly LinkLeafSpec[]
  readonly list: boolean
  readonly targets: readonly string[]
}

/** One flat link leaf: `author.id AS author_id` -> `author: { id }`. */
export type LinkLeafSpec = {
  /** Path inside the remounted object (`["address", "city"]`; empty = presence-leaf). */
  readonly out: readonly string[]
  /** Path in the TARGET shape (brackets preserved) for codec resolution. */
  readonly schemaPath: readonly string[]
  /** The flat top-level key in the raw row (`author_address_city`). */
  readonly source: string
}

/** The decoded projection of one target table. */
export type TargetEntry = {
  readonly meta?: TableMeta
  /** Physical target name (`""` for the wildcard passthrough entry). */
  readonly name: string
  readonly spec: ProjectionSpec
}

/** How to decode the target records of an edge include. */
export type TargetProjection = {
  readonly entries: readonly TargetEntry[]
  /** No declared targets (`->?`) — rows pass through undecoded. */
  readonly wildcard: boolean
}

/** The edge projection of an `edge:` entry. */
export type EdgeProjection = {
  readonly meta?: TableMeta
  readonly spec: ProjectionSpec
  readonly wildcard: boolean
}

/** Edge records alone: `(SELECT <edgeProj> FROM ->edge)`. */
export type EdgeRecordSpec = {
  readonly edge: EdgeProjection
  readonly key: string
  readonly kind: "edge"
  readonly shape: "edge"
}

/** Target records alone: `(SELECT <targetProj> FROM ->edge->target)`. */
export type EdgeTargetSpec = {
  readonly key: string
  readonly kind: "edge"
  readonly shape: "target"
  readonly target: TargetProjection
}

/** `{ edge, target }` remount — the row IS the edge, the target lives under `out`/`in`. */
export type EdgeRemountSpec = {
  /** The materialized target key inside the row. */
  readonly alias: "in" | "out"
  readonly edge: EdgeProjection
  readonly key: string
  readonly kind: "edge"
  readonly shape: "edge-target"
  readonly target: TargetProjection
}

/** `include: { likes: … }` — a per-parent traversal subquery. */
export type EdgeIncludeSpec = EdgeRecordSpec | EdgeRemountSpec | EdgeTargetSpec

/** One `_count` key — `count(->likes) AS _count_likes`. */
export type CountIncludeSpec = {
  readonly key: string
  readonly kind: "count"
  /** The flat raw key holding the number. */
  readonly source: string
}

/** The compiled `include` of one read. */
export type IncludeCompiled = {
  /** FETCH paths (`FETCH author.profile, editor`) — the clause emits it last. */
  readonly fetch: readonly string[]
  /** Top-level keys the include occupies (for conflict checks). */
  readonly keys: readonly string[]
  /** SQL expressions appended to the projection. */
  readonly parts: readonly string[]
  /** Top-level link fields materialized by FETCH (the base `*` decode must pass them through). */
  readonly passthrough: readonly string[]
  /** Hydration specs. */
  readonly specs: readonly IncludeSpec[]
}

/** The include compiler's shared mutable state (projection + hydration accumulators). */
export type CompileCtx = {
  readonly binds: Binds
  /** Claim a projected flat alias (rejects column collisions + duplicates). */
  readonly claimFlat: (key: string) => void
  /** FETCH paths (emitted as the read's LAST clause). */
  readonly fetch: string[]
  readonly index: SchemaIndex
  readonly operation: string
  /** SQL expressions appended to the read's projection. */
  readonly parts: string[]
  /** Link fields materialized by FETCH (the base `*` decode passes them through). */
  readonly passthrough: string[]
  /** Hydration specs for the decoder. */
  readonly specs: IncludeSpec[]
}

export const EMPTY_INCLUDE: IncludeCompiled = {
  fetch: [],
  keys: [],
  parts: [],
  passthrough: [],
  specs: [],
}
