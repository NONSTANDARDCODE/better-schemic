/**
 * A `BoundQuery` whose BINDINGS and RESULT rows type them. The SDK's `BoundQuery<R>` types 
 * the result tuple (`R`) and leaves `bindings` as `Record<string, unknown>` — that's why app code
 * writes `$query<unknown[]>(new BoundQuery(sql, { limit, query, … }))` and then casts every row.
 * `surqlWith` keeps both ends of the boundary typed with no cast.
 */
import { BoundQuery, escapeIdent } from "surrealdb"

import type { App } from "../pure"

export class TypedBoundQuery<
  B extends Record<string, unknown>,
  R extends unknown[] = unknown[],
> extends BoundQuery<R> {
  /** The typed view of the bindings (`super.bindings` stays the SDK's broad record). */
  readonly $bindings: B

  constructor(sql: string, bindings: B) {
    super(sql, bindings)
    this.$bindings = bindings
  }
}

/** Build a bound query with typed bindings and an optional typed result-row tuple. */
export function surqlWith<B extends Record<string, unknown>, R extends unknown[] = unknown[]>(
  sql: string,
  bindings: B,
): TypedBoundQuery<B, R> {
  return new TypedBoundQuery<B, R>(sql, bindings)
}

/** A projection source: an authored table def (column types know them) or a physical table name. */
export interface QueryShapeArg<C, Sel> {
  readonly from: C
  readonly select: Sel
}

type ProjectedRow<C, K extends PropertyKey> = C extends { name: string }
  ? Pick<App<C>, Extract<K, keyof App<C>>>
  : Record<K, unknown>

/**
 * Build a typed `SELECT <allowlist> FROM <table>` from a schema-aware projection. `select` is a
 * readonly tuple of column names — the app's allowlist — so each row has a FIXED set of keys (and,
 * for an authored table def, each value has the field's decoded type). No `<unknown[]>` at the
 * call site, and identifiers escap them via the SDK.
 */
export function selectQuery<
  C extends { readonly name: string } | string,
  const Sel extends readonly string[],
>(from: C, select: Sel): TypedBoundQuery<Record<string, never>, ProjectedRow<C, Sel[number]>[]> {
  const table = typeof from === "string" ? from : from.name
  const sql = `SELECT ${select.map((col) => escapeIdent(col)).join(", ")} FROM ${escapeIdent(table)}`
  return new TypedBoundQuery(sql, {})
}
