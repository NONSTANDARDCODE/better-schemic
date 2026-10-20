/**
 * The cursor keyset projection — where `cursor`'s `orderBy` fields ride in the result rows.
 *
 * A keyset read must carry every ordered field to build `nextCursor`/`previousCursor`, but the
 * user's `select` does not have to return them. When the projection already returns a field, the
 * cursor reads it in place; when it doesn't (a narrower sub-select, an alias, an expression, a
 * `*` + `omit`), the compiler APPENDS a reserved top-level alias (`path AS _keyset_<n>`) that the
 * runtime reads for the cursor and deletes from `data` afterwards. Cursor values come from the RAW
 * rows (never the codec-decoded app values), so a `DateTime` keeps its nanoseconds. The user's
 * projection is never rewritten and `omit` is never dropped, so `data` stays exactly the selection.
 * The one remaining teaching error is a projection entry that REDEFINES the ordered name
 * (`{ age: "id" }`): ORDER BY binds select aliases, so the keyset predicate and the sort would read
 * different values.
 */
import type { ModelMeta } from "../meta";
import { compileError, isTableMeta, pathSegments } from "./shared";
import {
  type ProjectionForm,
  omittedPaths,
  projectedInPlace,
  projectionForm,
  projectionKeys,
  redefinedPath,
} from "./projection";

/** Where one `orderBy` field rides in the result row. */
export interface CursorKey {
  /** The ordered field path (also the `nextCursor`/`previousCursor` tuple key). */
  readonly field: string;
  /**
   * The reserved alias carrying the value; absent = the projection returns it in place. The
   * cursor reads the value from the RAW row under this key (never the decoded app value).
   */
  readonly alias?: string;
}

/** A keyset column the projection must append: `path AS alias`. */
export interface KeysetAlias {
  readonly alias: string;
  readonly path: string;
}

/** What a cursor read must project to build its keyset. */
export interface KeysetProjection {
  /** One entry per `orderBy` field, in order. */
  readonly keys: readonly CursorKey[];
  /** The aliases to append (empty when every ordered field rides in place). */
  readonly aliases: readonly KeysetAlias[];
}

/** An `orderBy` field the keyset needs (direction/validation is the pagination compiler's job). */
export interface KeysetField {
  readonly field: string;
}

/** The reserved alias prefix (`_keyset_0`, `_keyset_1`, …). */
const ALIAS_PREFIX = "_keyset_";

/**
 * Resolve where each ordered field rides + the aliases the projection must append.
 */
export function keysetProjection(
  meta: ModelMeta,
  select: unknown,
  omit: unknown,
  order: readonly KeysetField[],
  operation: string,
): KeysetProjection {
  const form = projectionForm(select);
  // A malformed projection is `compileRead`'s teaching error — the keyset must not paper over it.
  if (!form)
    return { keys: order.map(({ field }) => ({ field })), aliases: [] };
  const omitted = omittedPaths(omit);
  const keys: CursorKey[] = [];
  const aliases: KeysetAlias[] = [];
  for (const [index, { field }] of order.entries()) {
    const target = pathSegments(field);
    // ORDER BY resolves SELECT aliases: a projection entry that redefines the ordered name would
    // make the keyset ORDER BY sort by the alias while the WHERE predicate compares the stored
    // field — silently wrong pages. `true`/same-path entries (and nested sub-selects, which create
    // no alias) keep binding the stored path.
    const redefined =
      form.kind === "object" ? redefinedPath(form.entries, target) : undefined;
    if (redefined !== undefined)
      throw compileError(
        "ValidationError",
        `${operation}: orderBy field "${field}" is redefined by the select entry "${redefined}" — ORDER BY would sort by that alias while the keyset predicate compares the stored field. Rename the entry (or select "${field}: true").`,
        { operation, field },
      );
    if (projectedInPlace(form, omitted, field)) {
      keys.push({ field });
      continue;
    }
    const alias = `${ALIAS_PREFIX}${index}`;
    assertAliasFree(meta, form, alias, operation);
    aliases.push({ alias, path: field });
    keys.push({ field, alias });
  }
  return { keys, aliases };
}

/** The projection must not already use the reserved alias (a user field named `_keyset_<n>`). */
function assertAliasFree(
  meta: ModelMeta,
  form: ProjectionForm,
  alias: string,
  operation: string,
): void {
  const used = projectionKeys(form);
  // `*` returns the whole declared row, so a real field with the alias name collides too.
  const shape =
    form.kind === "star" && isTableMeta(meta)
      ? (meta.def.object as { shape?: Record<string, unknown> }).shape
      : undefined;
  if (!used.has(alias) && !(shape && alias in shape)) return;
  throw compileError(
    "ValidationError",
    `${operation}: "${alias}" is reserved for the keyset cursor columns — rename that field or drop it from the projection.`,
    { operation, field: alias },
  );
}
