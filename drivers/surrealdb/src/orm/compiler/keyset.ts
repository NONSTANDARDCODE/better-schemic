/**
 * The cursor keyset projection — where `cursor`'s `orderBy` fields ride in the decoded row.
 *
 * A keyset read must carry every ordered field to build `nextCursor`/`previousCursor`, but the
 * user's `select` does not have to return them. When the projection already returns a field, the
 * cursor reads it in place; when it doesn't (a narrower sub-select, an alias, an expression, a
 * `*` + `omit`), the compiler APPENDS a reserved top-level alias (`path AS _keyset_<n>`) that the
 * runtime reads for the cursor and deletes from `data` afterwards. The user's projection is never
 * rewritten and `omit` is never dropped, so `data` stays exactly the selection. The one remaining
 * teaching error is a projection entry that REDEFINES the ordered name (`{ age: "id" }`): ORDER BY
 * binds select aliases, so the keyset predicate and the sort would read different values.
 */
import type { ModelMeta } from "../meta";
import {
  compileError,
  isPlainObject,
  isTableMeta,
  pathSegments,
} from "./shared";

/** Where one `orderBy` field rides in the decoded row. */
export interface CursorKey {
  /** The ordered field path (also the `nextCursor`/`previousCursor` tuple key). */
  readonly field: string;
  /** The reserved alias carrying the value; absent = the projection returns it in place. */
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

/** The analyzed shape of a VALID user projection (`undefined` = malformed; `compileRead` teaches). */
type ProjectionForm =
  | { readonly kind: "star"; readonly entries: Record<string, unknown> }
  | { readonly kind: "list"; readonly fields: readonly string[] }
  | { readonly kind: "object"; readonly entries: Record<string, unknown> };

/** Resolve where each ordered field rides + the aliases the projection must append. */
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
  const omitted = omitPaths(omit);
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

/** Normalize a user projection for analysis; `undefined` when it is malformed. */
function projectionForm(select: unknown): ProjectionForm | undefined {
  if (select === undefined || select === null)
    return { kind: "star", entries: {} };
  if (Array.isArray(select)) {
    const fields = select as readonly unknown[];
    if (
      fields.length === 0 ||
      fields.some((entry) => typeof entry !== "string" || entry.length === 0)
    )
      return undefined;
    return { kind: "list", fields: fields as readonly string[] };
  }
  if (!isPlainObject(select)) return undefined;
  const entries = select as Record<string, unknown>;
  const contributes = Object.values(entries).some(
    (entry) => entry !== undefined && entry !== false,
  );
  if (!contributes) return undefined;
  return entries["*"] === true
    ? { kind: "star", entries }
    : { kind: "object", entries };
}

/** Does the projection already return `field` in the decoded row? */
function projectedInPlace(
  form: ProjectionForm,
  omitted: readonly (readonly string[])[],
  field: string,
): boolean {
  const target = pathSegments(field);
  if (form.kind === "star")
    return !omitted.some((entry) => covers(entry, target));
  if (form.kind === "list")
    return form.fields.some((entry) => covers(pathSegments(entry), target));
  return coveredByEntries(form.entries, target);
}

/**
 * Does an object projection descend to `segments` through `true` entries and same-path aliases?
 * The longest key that prefixes the path decides (a dotted key wins over its parent), mirroring
 * how `compileEntry` lays the leaves out.
 */
function coveredByEntries(
  entries: Record<string, unknown>,
  segments: readonly string[],
): boolean {
  const match = longestKey(entries, segments);
  if (!match) return false;
  const entry = entries[match.key];
  if (entry === undefined || entry === false) return false;
  if (entry === true) return true;
  // A string entry is an alias: it returns the field only when it re-projects its own key
  // (`{ address: "address" }`, or the flat `{ "address.city": "address.city" }`).
  if (typeof entry === "string") return entry === match.key;
  if (isPlainObject(entry))
    return (
      match.end < segments.length &&
      coveredByEntries(entry, segments.slice(match.end))
    );
  return false;
}

/** The longest entry key matching a prefix of `segments` (`"address.city"` before `"address"`). */
function longestKey(
  entries: Record<string, unknown>,
  segments: readonly string[],
): { readonly key: string; readonly end: number } | undefined {
  for (let end = segments.length; end > 0; end--) {
    const key = segments.slice(0, end).join(".");
    if (key in entries) return { key, end };
  }
  return undefined;
}

/** Is `path` the same as, or a descendant of, `ancestor`? */
function covers(ancestor: readonly string[], path: readonly string[]): boolean {
  return (
    ancestor.length <= path.length &&
    ancestor.every((segment, index) => segment === path[index])
  );
}

/** Are two paths the same, segment by segment? */
function samePath(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((segment, index) => segment === b[index])
  );
}

/**
 * The select key that REDEFINES the ordered path (`{ age: "id" }`, `{ age: surql\`…\` }`) — the
 * emitted `ORDER BY age` would bind that alias, while the keyset `WHERE age > $c` binds the stored
 * field. A `true` entry, a same-path alias and a nested sub-select (which creates no alias of that
 * name) are not redefinitions.
 */
function redefinedPath(
  entries: Record<string, unknown>,
  segments: readonly string[],
): string | undefined {
  const key = segments.join(".");
  if (!(key in entries)) return undefined;
  const entry = entries[key];
  if (entry === undefined || entry === false || entry === true)
    return undefined;
  if (isPlainObject(entry)) return undefined;
  if (typeof entry === "string" && samePath(pathSegments(entry), segments))
    return undefined;
  return key;
}

/** The omit entries that can hide a `*`-projected path (malformed ones are `compileRead`'s error). */
function omitPaths(omit: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(omit)) return [];
  return omit
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    .map(pathSegments);
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

/** The top-level output keys a valid projection can emit. */
function projectionKeys(form: ProjectionForm): ReadonlySet<string> {
  const keys = new Set<string>();
  if (form.kind === "list") {
    for (const field of form.fields) keys.add(pathSegments(field)[0] as string);
    return keys;
  }
  for (const key of Object.keys(form.entries)) {
    keys.add(pathSegments(key)[0] as string);
  }
  return keys;
}
