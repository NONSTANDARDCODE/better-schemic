// The Struct-IR normalizer: ONE `normalize(Struct) -> Struct` pass that both lowerings
// (fromTableDef / fromInfo) run through, so equality becomes a deep-compare and diffing is
// structural. This factors the deterministic transforms previously baked into the `canonical*`
// DDL builders (structure.ts) out into a standalone Struct->Struct form. See docs/STRUCT-IR.md.
//
// Status: normalize() + deep-equal. fromTableDef() / fromInfo() lowerings land next (the latter is
// today's introspectStructured). This module does NOT touch the live `diff --live` path yet.

import { forcesBareType } from "../ddl";
import { splitTopUnion, topLevelSplitOnce } from "../surql-type-expr";
import type {
  DbStructured,
  StructAccess,
  StructEvent,
  StructField,
  StructFunction,
  StructIndex,
  StructParam,
  StructPermissions,
  StructSequence,
  StructTable,
} from "./structure";

// --- Type-expression normalization -----------------------------------------------------------

/**
 * Canonical form of a SurrealQL type expression, applied recursively:
 *  - fold a top-level `none` member into `option<…>` (gotcha 1: `T | none` == `option<T>`), while
 *    keeping `T | null` distinct (nullable is a different type);
 *  - sort union members deterministically AND dedupe them — SurrealDB collapses a repeated member
 *    (`string | string | null`), so both sides must (`s.union([s.string().optional(),
 *    s.string().nullable()])` authoring must not phantom-diff);
 *  - at the top level AND inside `record<…>` (gotcha 3), `array<…>`, `set<…>`, `option<…>`;
 *  - leave a single literal / primitive untouched.
 *
 * `'a' | 'b'` literal unions and `record<b|a>` therefore converge regardless of authoring order, and
 * enum-vs-union is left to the renderer (both produce the same sorted `kind`).
 */
export function normalizeType(kind: string): string {
  // Canonicalize literal quotes first (checklist item 2): inferField emits double-quoted literals
  // (`"admin"` via JSON.stringify), INFO STRUCTURE returns single-quoted (`'admin'`). Convert
  // double → single so both lowerings converge. Idempotent (single-quoted tokens are left alone).
  const t = canonicalizeLiterals(kind.trim());

  // Top-level union FIRST: `option<A> | B` starts with `option<` and can end with `>`, so testing the
  // option wrapper before splitting would swallow the whole union (the regex is greedy). splitTopUnion
  // ignores `|` inside `<…>`, so `option<A | B>` still resolves to a single option below.
  const parts = splitTopUnion(t);
  if (parts.length > 1) {
    const hasNone = parts.includes("none");
    const rest = [
      ...new Set(parts.filter((p) => p !== "none").map(normalizeType)),
    ];
    const inner = rest.length === 1 ? rest[0] : [...rest].sort().join(" | ");
    if (hasNone) return rest.length ? `option<${inner}>` : "none";
    return inner;
  }

  // option<X> wrapper — normalize the inner type, stay `option<…>`.
  const opt = /^option<([\s\S]+)>$/.exec(t);
  if (opt) return `option<${normalizeType(opt[1])}>`;

  // Single constructor term `ctor<inner>`: recurse. record<…>'s inner is a `|`-list of targets.
  const ctor = /^(array|set|record|references)<([\s\S]+)>$/.exec(t);
  if (ctor) {
    const [, name, innerRaw] = ctor;
    // array<T, N> / set<T, N>: keep a trailing size arg as-is, normalize the element only.
    const comma = topLevelSplitOnce(innerRaw, ",");
    if (comma && (name === "array" || name === "set")) {
      return `${name}<${normalizeType(comma[0])}, ${comma[1].trim()}>`;
    }
    if (name === "record" || name === "references") {
      const targets = innerRaw
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      return `${name}<${[...targets].sort().join(" | ")}>`;
    }
    return `${name}<${normalizeType(innerRaw)}>`;
  }

  return t;
}

/** Convert double-quoted string literals to single-quoted (SurrealQL's output form), leaving single ones. */
function canonicalizeLiterals(s: string): string {
  // Also folds the explicit-string prefix (`s"..."` — what value inlining emits) to the bare
  // single-quoted form INFO prints.
  return s.replace(/(?:\bs)?"(?:[^"\\]|\\.)*"/g, (m) => {
    const raw = m.startsWith('s"') ? m.slice(1) : m;
    let value: string;
    try {
      value = JSON.parse(raw) as string;
    } catch {
      return m;
    }
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  });
}

// --- Permission normalization ----------------------------------------------------------------

const TABLE_OPS = ["select", "create", "update", "delete"] as const;
const FIELD_OPS = ["select", "create", "update"] as const;

/**
 * Canonical permissions (gotcha 5): `undefined` when every op is the kind default (FULL for
 * fields/functions, NONE for tables), else only the non-default ops, so an unspecified
 * `PERMISSIONS` deep-compares equal to a materialized default on the other side.
 */
function normalizePermissions(
  perms: StructPermissions | undefined,
  ops: readonly (keyof StructPermissions)[],
  defaultFull: boolean,
): StructPermissions | undefined {
  // An omitted op (undefined) always means the kind default; otherwise default is FULL for fields
  // and NONE for tables.
  const isDefault = (v: StructPermissions[keyof StructPermissions]) =>
    v === undefined || (defaultFull ? v === true : v === false);
  const out: StructPermissions = {};
  let any = false;
  for (const op of ops) {
    const v = perms?.[op];
    if (isDefault(v)) continue;
    out[op] = (
      typeof v === "string" ? collapseWs(v) : v
    ) as StructPermissions[keyof StructPermissions];
    any = true;
  }
  return any ? out : undefined;
}

// --- Array-element folding -------------------------------------------------------------------

/** Fold an element type into a bare `array`/`set` kind, so `array` + `array.* TYPE object` == `array<object>`. */
function foldArrayElement(kind: string, elementKind: string): string {
  const elem = normalizeType(elementKind);
  return kind.replace(/\b(array|set)\b(?!<)/, (kw) => `${kw}<${elem}>`);
}

/** Whether every listed op is FULL (`true`) or unset — the field default. */
function isFullPerms(
  perms: StructPermissions | undefined,
  ops: readonly (keyof StructPermissions)[],
): boolean {
  return ops.every((op) => perms?.[op] === undefined || perms?.[op] === true);
}

/**
 * A trivial `x.*` element — exactly what SurrealDB auto-creates from `array<…>` (no extra clause) —
 * is folded into the parent type and dropped. A customized element is kept.
 */
function isTrivialElement(f: StructField): boolean {
  return (
    !f.flexible &&
    !f.readonly &&
    f.default === undefined &&
    f.value === undefined &&
    f.assert === undefined &&
    f.comment === undefined &&
    isFullPerms(f.permissions, FIELD_OPS)
  );
}

// --- Field / table / standalone normalization ------------------------------------------------

/** A field's parent-before-child sort key: compare path segments so `address` precedes `address.city`. */
function fieldSortKey(name: string): string {
  // Append a separator that sorts before any path char so a prefix sorts before its extensions.
  return name
    .split(".")
    .map((seg) => `${seg}\x00`)
    .join("");
}

/** Strip a leading `option<…>` wrapper (used when a clause makes the field always-present). */
function stripOption(kind: string): string {
  const m = /^option<([\s\S]+)>$/.exec(kind);
  return m ? m[1] : kind;
}

/** Normalize one field (kind + permissions + drop the back-pointer table name from the compare). */
function normalizeField(f: StructField): StructField {
  let kind = normalizeType(f.kind);
  // DEFAULT/COMPUTED guarantee a populated column, so SurrealDB stores the BARE type (INFO drops
  // `option<>`). `fromTableDef` keeps the `option<>` — strip it on both sides via the SAME predicate
  // the emitter uses, so the two can't drift.
  if (forcesBareType(f)) kind = stripOption(kind);
  const out: StructField = { name: f.name, kind, table: f.table };
  if (f.flexible) out.flexible = true;
  if (f.readonly) out.readonly = true;
  // Clause exprs are canonicalized for quotes too (inferField/inline emit double-quoted literals;
  // INFO returns single-quoted).
  if (f.default !== undefined) {
    out.default = collapseWs(canonicalizeLiterals(f.default));
    if (f.default_always) out.default_always = true;
  }
  if (f.value !== undefined)
    out.value = collapseWs(canonicalizeLiterals(f.value));
  if (f.computed !== undefined)
    out.computed = collapseWs(canonicalizeLiterals(f.computed));
  if (f.assert !== undefined)
    out.assert = collapseWs(canonicalizeLiterals(f.assert));
  if (f.comment !== undefined) out.comment = f.comment;
  if (f.reference !== undefined) out.reference = f.reference;
  const perms = normalizePermissions(f.permissions, FIELD_OPS, true);
  if (perms) out.permissions = perms;
  return out;
}

/** Implicit fields INFO materializes that the generator omits — dropped on both sides. */
function implicitFields(t: StructTable): Set<string> {
  return t.kind.kind === "RELATION"
    ? new Set(["id", "in", "out"])
    : new Set(["id"]);
}

/**
 * Normalize a table to its canonical Struct: fold trivial array elements, drop implicit fields,
 * normalize + sort fields (parent-before-child), normalize permissions, sort relation endpoints /
 * indexes / events. Two semantically-equal tables normalize to deep-equal Structs.
 */
export function normalizeTable(t: StructTable): StructTable {
  const implicit = implicitFields(t);
  const byName = new Map(t.fields.map((f) => [f.name, f]));
  const elementOf = new Map<string, StructField>();
  for (const f of t.fields)
    if (f.name.endsWith(".*")) elementOf.set(f.name.slice(0, -2), f);

  const fields: StructField[] = [];
  for (const f of t.fields) {
    // A LITERAL-typed id (`'default'`) is a SINGLETON key — real, kept on both sides so it
    // emits, diffs, and pulls. Only the plain implicit id/in/out are dropped.
    if (implicit.has(f.name) && !(f.name === "id" && /^'.*'$/.test(f.kind)))
      continue;
    if (f.name.endsWith(".*")) {
      const parent = byName.get(f.name.slice(0, -2));
      const parentIsArray = parent
        ? /\b(?:array|set)\b/.test(parent.kind)
        : false;
      if (parentIsArray && isTrivialElement(f)) continue; // folded into the parent type
    }
    const elem = elementOf.get(f.name);
    const folded = elem
      ? { ...f, kind: foldArrayElement(f.kind, elem.kind) }
      : f;
    fields.push(normalizeField(folded));
  }
  fields.sort((a, b) =>
    fieldSortKey(a.name).localeCompare(fieldSortKey(b.name)),
  );

  const kind: StructTable["kind"] = { kind: t.kind.kind };
  if (t.kind.in?.length) kind.in = [...t.kind.in].sort();
  if (t.kind.out?.length) kind.out = [...t.kind.out].sort();
  if (t.kind.enforced) kind.enforced = true;

  const out: StructTable = {
    name: t.name,
    kind,
    schemafull: t.schemafull,
    fields,
    indexes: [...t.indexes]
      .map(normalizeIndex)
      .sort((a, b) => a.name.localeCompare(b.name)),
    events: [...t.events]
      .map(normalizeEvent)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  if (t.drop) out.drop = true;
  if (t.comment !== undefined) out.comment = t.comment;
  if (t.changefeed) out.changefeed = t.changefeed;
  const perms = normalizePermissions(t.permissions, TABLE_OPS, false);
  if (perms) out.permissions = perms;
  return out;
}

function normalizeIndex(idx: StructIndex): StructIndex {
  return { name: idx.name, cols: idx.cols, index: idx.index };
}

/** Strip backticks around PLAIN identifiers (quote-aware): SurrealDB's printer defensively
 *  backtick-escapes some idents (e.g. `` `rand`::string ``) that authors write bare — both spell
 *  the same ident, so canonicalize to the bare form. Backticks inside string literals are kept. */
function stripPlainBackticks(s: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < s.length) {
        out += s[i + 1];
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "`") {
      const m = /^`([A-Za-z_][A-Za-z0-9_]*)`/.exec(s.slice(i));
      if (m) {
        out += m[1];
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Canonicalize FORMATTING (outside string literals) so it can never phantom-diff: authors write
 *  multi-line `surql` bodies, INFO prints blocks single-line — and the reverse also happens
 *  (nested multi-statement blocks print with NEWLINES). Whitespace runs collapse to one space,
 *  and punctuation spacing is normalized to INFO's style: none inside `()`/`[]`, exactly one
 *  after `,`/`;`/`{`, one before `}`. `:` is untouched (record ids vs object keys are lexically
 *  ambiguous). BOTH sides normalize through here, so the exact style only has to be
 *  deterministic. Whitespace inside strings is preserved. */
function collapseWs(s: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let pendingSpace = false;
  const last = () => out[out.length - 1];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < s.length) {
        out += s[i + 1];
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    // No space BEFORE closers/separators; none right AFTER an opener.
    if (c === ")" || c === "]" || c === "," || c === ";") pendingSpace = false;
    if (pendingSpace && last() !== "(" && last() !== "[") out += " ";
    pendingSpace = false;
    if (c === "}" && last() !== " " && out.length > 0) out += " ";
    if (c === '"' || c === "'") quote = c;
    out += c;
    // Exactly one space AFTER `,`/`;`/`{` (unless a closer follows — handled above).
    if (c === "," || c === ";" || c === "{") pendingSpace = true;
  }
  return out;
}

/** Drop a `;` that directly precedes a `}`, and a `,` that directly precedes a `}`/`]`/`)`
 *  (quote-aware). INFO keeps the trailing `;` in multi-statement blocks but drops it in
 *  single-statement ones — and never prints trailing commas — so stripping BOTH everywhere on
 *  both sides converges (and stays valid SurrealQL). Hand-authored trailing commas no longer
 *  phantom-diff. */
function stripSemiBeforeBrace(s: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < s.length) {
        out += s[i + 1];
        i++;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === ";" && /^\s*\}/.test(s.slice(i + 1))) continue;
    if (c === "," && /^\s*[}\])]/.test(s.slice(i + 1))) continue;
    out += c;
  }
  return out;
}

const normalizeExprText = (s: string): string =>
  collapseWs(
    stripSemiBeforeBrace(stripPlainBackticks(canonicalizeLiterals(s))),
  );

function normalizeEvent(ev: StructEvent): StructEvent {
  // An omitted WHEN is stored by SurrealDB as the literal "true" — drop it so authored-with/without
  // compare equal.
  const out: StructEvent = {
    name: ev.name,
    what: ev.what,
    // biome-ignore lint/suspicious/noThenProperty: `then` mirrors SurrealQL's event THEN clause.
    then: ev.then.map(normalizeExprText),
  };
  if (ev.when !== undefined && ev.when !== "true")
    out.when = normalizeExprText(ev.when);
  // ASYNC + comment round-trip: SurrealDB materializes RETRY 1 / MAXDEPTH 3 on read; `canonicalEvent`
  // strips those defaults via `renderAsync`, so an authored bare `ASYNC` compares equal to the read form.
  if (ev.async) {
    out.async = true;
    if (ev.retry !== undefined) out.retry = ev.retry;
    if (ev.maxdepth !== undefined) out.maxdepth = ev.maxdepth;
  }
  if (ev.comment !== undefined) out.comment = ev.comment;
  return out;
}

/** Canonicalize a `{ … }` block body: collapse whitespace (multi-line authored bodies vs INFO's
 *  single-line printing — and INFO's own newlines in nested blocks) and strip a trailing `;`
 *  before the closing brace (INFO drops it, the emitter keeps it). */
function normalizeBlock(block: string): string {
  return normalizeExprText(block);
}

/** Normalize a db-level function: default (FULL) execute permission becomes undefined. */
export function normalizeFunction(fn: StructFunction): StructFunction {
  const out: StructFunction = {
    name: fn.name,
    args: fn.args,
    block: normalizeBlock(fn.block),
  };
  if (fn.returns !== undefined) out.returns = fn.returns;
  if (fn.permissions !== undefined && fn.permissions !== true)
    out.permissions = fn.permissions;
  if (fn.comment !== undefined) out.comment = fn.comment;
  return out;
}

/** Normalize a MANAGED param: canonicalize the value literal ('...' quoting, formatting), drop a
 *  default FULL permission. */
export function normalizeParam(p: StructParam): StructParam {
  const out: StructParam = {
    name: p.name,
    value: collapseWs(canonicalizeLiterals(p.value)),
  };
  if (p.permissions === false) out.permissions = false;
  if (p.comment !== undefined) out.comment = p.comment;
  return out;
}

/** Normalize a db-level access def (signing key is intentionally excluded — SurrealDB redacts it). */
export function normalizeAccess(a: StructAccess): StructAccess {
  return a;
}

/** Normalize a `DEFINE SEQUENCE`: drop SurrealDB's materialized BATCH 1000 / START 0 defaults so an
 *  authored minimal sequence deep-compares equal to the introspected form. */
export function normalizeSequence(s: StructSequence): StructSequence {
  const out: StructSequence = { name: s.name };
  if (s.batch !== undefined && s.batch !== 1000) out.batch = s.batch;
  if (s.start !== undefined && s.start !== 0) out.start = s.start;
  if (s.timeout !== undefined) out.timeout = s.timeout;
  return out;
}

/** Normalize a whole introspected/lowered database to its canonical Struct form. */
export function normalizeDb(db: DbStructured): DbStructured {
  return {
    tables: db.tables.map(normalizeTable),
    functions: db.functions.map(normalizeFunction),
    accesses: db.accesses.map(normalizeAccess),
    // Analyzers carry an ordered tokenizer/filter pipeline (order-significant) — passed through as-is.
    analyzers: db.analyzers,
    params: (db.params ?? []).map(normalizeParam),
    sequences: (db.sequences ?? []).map(normalizeSequence),
  };
}

// --- Structural equality ---------------------------------------------------------------------

/** Order-insensitive deep equality over plain JSON-ish values (the Struct shapes). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
  }
  return false;
}
