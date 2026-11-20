// The PORTABLE TYPE MODEL — the keystone of multi-DB support (see docs/MULTI-DB-SPIKE.md).
//
// Today the Struct-IR carries a field's type as a SurrealQL type-expression STRING
// (`StructField.kind`, e.g. `option<int>`, `array<record<user>, 3>`). That string is a dialect leak:
// equality and rendering both have to understand SurrealQL grammar. This module defines the
// dialect-INDEPENDENT replacement — a structured type that every driver translates to/from.
//
// STATUS (Milestone 1): defined but NOT yet wired into `StructField`. Milestone 2 replaces
// `kind: string` with `type: PortableType`, makes `inferField` (src/ddl.ts) produce it, and flips
// diff equality to a structured deep-compare over the normalized IR. Until then this is the target
// shape, kept in code so the Surreal driver's `emitType`/`parseType` can builts it against it.

/**
 * The portable scalar set — the common denominator every driver maps to a concrete column type and
 * back. A driver MAY reject scalars it cannot represent (and authoring can pin a richer DB-native
 * type via `{ t: "native" }`). Names are lowercase and dialect-neutral.
 */
export type ScalarName =
  | "any"
  | "bool"
  | "bytes"
  | "datetime"
  | "decimal"
  | "duration"
  | "float"
  | "int"
  | "null" // the unit SQL NULL / Surreal `null` (distinct from `option`'s absence)
  | "number" // a numeric whose int/float/decimal-ness is unconstrained
  | "string"
  | "uuid"

/**
 * A dialect-independent field type. Drivers translate this to their own type expression (`emitType`)
 * and parse their introspection back into it (`parseType`). `option` and `nullable` are ORTHOGONAL
 * and BOTH equality-relevant — see the note on `nullable` below; never collapse them.
 */
export type PortableType =
  /** A primitive scalar. */
  | { db: string; name: string; params?: (number | string)[]; t: "native" }
  /** A literal value type, e.g. the `'active'` in `'active' | 'archived'`. */
  | { elem: PortableType; size?: number; t: "array" }
  /**
   * The field may be ABSENT / NONE (Surreal `option<T>`; SQL "column omitted / has a DEFAULT").
   * Orthogonal to `nullable`.
   */
  | { elem: PortableType; size?: number; t: "set" }
  /**
   * The field may be NULL (Surreal `T | null`; SQL `NULL` vs `NOT NULL`). Orthogonal to `option`:
   * `option<T>`, `T | null`, and `option<T | null>` are THREE DISTINCT types. `normalize()` folds
   * `nullable(option(X))` -> `option(nullable(X))` so `.optional().nullable()` ≡ `.nullish()`.
   */
  | { fields: Record<string, PortableType>; flexible?: boolean; t: "object" }
  /** An ordered, possibly length-bounded list. */
  | { inner: PortableType; t: "nullable" }
  /** A set (distinct elements), possibly length-bounded. */
  | { inner: PortableType; t: "option" }
  /** A discriminated/plain union. `normalize()` keeps `members` canonically sorted. */
  | { kind: GeometryKind; t: "geometry" }
  /** A nested object/record literal. `flexible` allows undeclared keys (Surreal FLEXIBLE). */
  | { members: PortableType[]; t: "union" }
  /**
   * A link to a row in one of `tables` (Surreal `record<a | b>`; SQL foreign key). The id-VALUE type
   * is intentionally NOT modelled here — the DDL never encodes it; it lives App/Wire-side (TS-).
   */
  | { name: ScalarName; t: "scalar" }
  /** A geometry type (Surreal-native; PostGIS or unsupported elsewhere). */
  | { t: "literal"; value: boolean | number | string }
  /** The bottom type (no value). */
  | { t: "never" }
  /**
   * An escape hatch for a DB-specific type with no portable meaning (a full-text vector type, etc.). Carries
   * the owning driver `db` so a schema authored for one DB can't  typecheck against another.
   * `params` carries the type's parameters for parameterized natives — `numeric(p,s)`, `varchar(n)`,
   * `timestamp(p)` — so a driver round-trips `numeric(10,2)` . Order matters; ignored when empty.
   */
  | { t: "record"; tables: string[] }

export type GeometryKind =
  | "collection"
  | "feature"
  | "line"
  | "multiline"
  | "multipoint"
  | "multipolygon"
  | "point"
  | "polygon"

// --- Constructors (ergonomic, and a single place to enforce the fold invariants) ----------------

export const scalar = (name: ScalarName): PortableType => ({
  name,
  t: "scalar",
})
export const literal = (value: boolean | number | string): PortableType => ({
  t: "literal",
  value,
})

/** `option<T>` — but `option<any>` collapses to `any` (any already admits NONE), matching ddl.ts. */
export const option = (inner: PortableType): PortableType =>
  inner.t === "scalar" && inner.name === "any" ? inner : { inner, t: "option" }

/**
 * `T | null` — with the fold rule `nullable(option(X))` -> `option(nullable(X))` so
 * `.optional().nullable()` ≡ `.nullish()`, and `nullable(any)` collapses to `any`.
 */
export const nullable = (inner: PortableType): PortableType => {
  if (inner.t === "scalar" && inner.name === "any") {
    return inner
  }
  if (inner.t === "option") {
    return { inner: nullable(inner.inner), t: "option" }
  }
  return { inner, t: "nullable" }
}

export const array = (elem: PortableType, size?: number): PortableType => ({
  elem,
  t: "array",
  ...(size === undefined ? {} : { size }),
})
export const union = (members: PortableType[]): PortableType =>
  members.length === 1 ? members[0] : { members, t: "union" }
export const record = (tables: string[]): PortableType => ({
  t: "record",
  tables,
})
