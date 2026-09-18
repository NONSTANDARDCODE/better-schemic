/**
 * The compiler's shared lowering primitives — the ONE place a value becomes a bind and a name
 * becomes a SurrealQL identifier. Every clause compiler (`where`, `select`, `pagination`, …) builds
 * on these, so parameterization and identifier escaping are enforced in a single spot:
 *
 * - VALUES always bind (`$p0`, `$p1`, …) — a user value is never concatenated into the statement.
 * - NAMES are escaped (`⟨…⟩` when needed) and their bracket suffixes (`[*]`, `[0]`) validated, so a
 *   hostile key can't inject syntax either.
 * - FRAGMENTS (`surql`/`BoundQuery`), refs and `$param` refs keep the lowering semantics the rest
 *   of the codebase already uses (`mergeRaw`/`renderData`/`renderRef`), so a fragment behaves the
 *   same inside a `where` as it does in a DDL position.
 *
 * The bind map is SHARED across every statement of one operation, so names never collide when the
 * executor merges a batch (`paginate` compiles its two statements into one round-trip).
 */
import { BoundQuery, escapeIdent } from "surrealdb";
import {
  type Ctx,
  fragOf,
  hasRefDeep,
  isParamRef,
  isRange,
  mergeRaw,
  paramDefName,
  type Range,
  refState,
  rejectDefValue,
  renderData,
  renderRef,
} from "../../pure";
import {
  BetterSchemicError,
  type BetterSchemicErrorCode,
  type BetterSchemicErrorOptions,
} from "../errors";
import type { ModelMeta, TableMeta } from "../meta";

/** The bind accumulator one compiled operation carries. */
export interface Binds {
  /** The bindings collected so far (what the executor passes as `vars`). */
  readonly vars: Record<string, unknown>;
  /** Bind a value under a fresh `$p<n>` and return its reference text. */
  add(value: unknown): string;
  /** A lowering {@link Ctx} over this bind map (`row` sets the current row token for `$parent`). */
  ctx(row?: symbol): Ctx;
}

/** Create a fresh {@link Binds} (`$<prefix>0`, `$<prefix>1`, … in call order). */
export function createBinds(prefix = "p"): Binds {
  const vars: Record<string, unknown> = {};
  let next = 0;
  return {
    vars,
    add(value) {
      // Skip names a merged fragment already claimed: `mergeRaw` writes into the SAME vars map, so
      // handing out an existing name would silently overwrite the fragment's bind.
      let name: string;
      do name = `${prefix}${next++}`;
      while (name in vars);
      vars[name] = value;
      return `$${name}`;
    },
    ctx(row) {
      return row === undefined ? { vars } : { vars, row };
    },
  };
}

/** Build a compiler failure — every one carries a `code` the caller can branch on. */
export function compileError(
  code: BetterSchemicErrorCode,
  message: string,
  options: BetterSchemicErrorOptions = {},
): BetterSchemicError {
  return new BetterSchemicError(code, message, options);
}

/** Is this a fragment/ref/param value the lowering primitives must handle instead of binding? */
export function isLowerableValue(v: unknown): boolean {
  return (
    v instanceof BoundQuery ||
    isParamRef(v) ||
    isRange(v) ||
    refState(v) !== undefined ||
    paramDefName(v) !== undefined ||
    fragOf(v) !== undefined
  );
}

/**
 * Lower a VALUE position: fragments/refs/`$param` refs keep their semantics; a range renders as
 * `a..=b` (its bounds bind); anything else binds as a fresh `$p<n>` — never interpolated text.
 */
export function renderValue(value: unknown, binds: Binds, ctx: Ctx): string {
  if (isParamRef(value)) return value.toText();
  if (isRange(value)) return renderRange(value, binds, ctx);
  const param = paramDefName(value);
  if (param !== undefined) return `$${param}`;
  const ref = refState(value);
  if (ref) return renderRef(ref, ctx);
  if (value instanceof BoundQuery) return `(${mergeRaw(value, ctx.vars)})`;
  const frag = fragOf(value);
  if (frag) return mergeRaw(frag, ctx.vars);
  if (hasRefDeep(value)) return renderData(value, ctx);
  rejectDefValue(value);
  return binds.add(value);
}

/** Render a {@link Range} with the compiler's `$p<n>` binds (`a..b` / `a..=b`, either end open). */
function renderRange(r: Range, binds: Binds, ctx: Ctx): string {
  const start = r.start
    ? `${renderValue(r.start.value, binds, ctx)}${r.start.exclusive ? ">" : ""}`
    : "";
  const end = r.end
    ? `${r.end.exclusive ? "" : "="}${renderValue(r.end.value, binds, ctx)}`
    : "";
  return `${start}..${end}`;
}

/**
 * Splice a fragment BARE (no parens) — for clause positions where a parenthesized expression is a
 * parse error (e.g. `ORDER BY (expr)`). Returns `undefined` when the value isn't a fragment.
 */
export function renderBareFragment(
  value: unknown,
  binds: Binds,
): string | undefined {
  if (value instanceof BoundQuery) return mergeRaw(value, binds.vars);
  const frag = fragOf(value);
  return frag ? mergeRaw(frag, binds.vars) : undefined;
}

/** One path segment: a base name plus only `[<digits>]`/`[*]` suffixes. */
const SEGMENT = /^([^[\]]+)((?:\[\d+\]|\[\*\])*)$/;

/**
 * Escape a field PATH as an identifier chain: each dot-separated segment's base is escaped
 * (`⟨weird name⟩`) and its index suffixes are validated — `contacts[*].type` and `contacts[0].type`
 * pass, `contacts[abc]` is a teaching `ValidationError` (silently quoting it would hide the typo).
 */
export function renderPath(path: string): string {
  if (typeof path !== "string" || path.length === 0)
    throw compileError(
      "ValidationError",
      `a field path must be a non-empty string (got ${typeof path}).`,
    );
  return path
    .split(".")
    .map((segment) => {
      const match = SEGMENT.exec(segment);
      if (!match)
        throw compileError(
          "ValidationError",
          `field path "${path}" has an invalid segment "${segment}" — only [<n>] and [*] indexes are allowed.`,
          { field: path },
        );
      return `${escapeIdent(match[1] as string)}${match[2]}`;
    })
    .join(".");
}

/** Does this path end in an array projection (`[*]`) — i.e. its value is an ARRAY, not a scalar? */
export function isArrayPath(path: string): boolean {
  return path.split(".").some((segment) => segment.includes("[*]"));
}

/** AND-join already-compiled fragments (assumes non-empty). */
export function joinAnd(parts: readonly string[]): string {
  return parts.join(" AND ");
}

/** AND-join inside explicit parens — used for nested logical groups. */
export function paren(part: string): string {
  return `(${part})`;
}

// --- canonical arg guards / schema metadata -------------------------------------------------------

/** The args every read op rejects (removed or renamed in the M1 surface). */
export interface RemovedArgs {
  /** Removed: SurrealDB 3.2 rejects PARALLEL (parse error). */
  parallel?: unknown;
  /** Renamed to `limit`. */
  take?: unknown;
  /** Renamed to `start`. */
  skip?: unknown;
}

/**
 * Reject the args that no longer exist: `parallel` (SurrealDB 3.2 has no PARALLEL) and the
 * prototype aliases `take`/`skip` (canonical is `limit`/`start`). Failing loudly beats ignoring.
 * The ONE place this rule lives — every read compiler calls it.
 */
export function rejectRemovedArgs(args: RemovedArgs, operation: string): void {
  if (args.parallel !== undefined)
    throw compileError(
      "UnsupportedCapability",
      `${operation}: "parallel" was removed — SurrealDB 3.2 rejects PARALLEL (parse error). Use $raw/$query if a future server supports it.`,
      { operation },
    );
  if (args.take !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "take" was renamed — use "limit" (take is not part of the surface).`,
      { operation },
    );
  if (args.skip !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "skip" was renamed — use "start" (skip is not part of the surface).`,
      { operation },
    );
}

/** A typed table/edge meta (vs. a schemaless entry). */
export function isTableMeta(meta: ModelMeta): meta is TableMeta {
  return !("schemaless" in meta);
}

/** The single-field UNIQUE indexes of a table (empty for schemaless entries). */
export function uniqueFields(meta: ModelMeta): readonly string[] {
  if (!isTableMeta(meta)) return [];
  return (meta.def.config.indexes ?? [])
    .filter((index) => index.unique === true && index.fields.length === 1)
    .map((index) => index.fields[0] as string);
}

/** A path string -> its segments, brackets stripped (`contacts[*].type` -> `contacts.type`). */
export function pathSegments(path: string): readonly string[] {
  return path
    .split(".")
    .map((segment) => segment.replace(/\[\d+\]|\[\*\]/g, ""));
}

/** Normalize a single-or-list field-path arg (`groupBy`, `split`-adjacent lists). */
export function pathList(
  value: unknown,
  name: string,
  operation?: string,
): readonly string[] {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries)
    if (typeof entry !== "string" || !entry)
      throw compileError(
        "ValidationError",
        `${operation ? `${operation}: ` : ""}${name} entries must be field paths, got ${describeValue(entry)}.`,
        operation ? { operation } : {},
      );
  return entries as readonly string[];
}

/** A non-negative integer arg (LIMIT/START), bound as `$p<n>` by the caller. */
export function nonNegativeInt(
  value: unknown,
  name: string,
  operation: string,
): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw compileError(
      "ValidationError",
      `${operation}: ${name} must be a non-negative integer (got ${describeValue(value)}).`,
      { operation },
    );
  return value as number;
}

/** A positive integer arg (page sizes). */
export function positiveInt(
  value: unknown,
  name: string,
  operation: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0)
    throw compileError(
      "ValidationError",
      `${operation}: ${name} must be a positive integer (got ${describeValue(value)}).`,
      { operation },
    );
  return value as number;
}

// --- targets --------------------------------------------------------------------------------------

/** The `FROM` target of a record range: `table:1..=2` (bounds validated + escaped). */
export function rangeTarget(
  meta: ModelMeta,
  range: unknown,
  operation: string,
): string {
  if (!isPlainObject(range))
    throw compileError(
      "ValidationError",
      `${operation}: range must be { start, end, inclusive? }, got ${describeValue(range)}.`,
      { operation },
    );
  const start = recordIdSuffix(meta.name, range.start, "start", operation);
  const end = recordIdSuffix(meta.name, range.end, "end", operation);
  const eq = range.inclusive === true ? "=" : "";
  return `${escapeIdent(meta.name)}:${start}..${eq}${end}`;
}

// --- clause fragments shared by the read compilers -------------------------------------------------

/** `WITH INDEX a, b` / `WITH NOINDEX`. */
export function compileWithClause(withArg: unknown, operation: string): string {
  if (!isPlainObject(withArg))
    throw compileError(
      "ValidationError",
      `${operation}: with must be { index } or { noIndex: true }, got ${describeValue(withArg)}.`,
      { operation },
    );
  const noIndex = withArg.noIndex === true;
  const index = withArg.index;
  if (noIndex && index !== undefined)
    throw compileError(
      "ClauseNotSupported",
      `${operation}: with.index and with.noIndex are mutually exclusive.`,
      { operation },
    );
  if (noIndex) return "WITH NOINDEX";
  if (index === undefined)
    throw compileError(
      "ValidationError",
      `${operation}: with needs "index" (a name or list) or "noIndex: true".`,
      { operation },
    );
  const names = Array.isArray(index) ? index : [index];
  if (names.length === 0 || names.some((n) => typeof n !== "string" || !n))
    throw compileError(
      "ValidationError",
      `${operation}: with.index must be a non-empty name or list of names.`,
      { operation },
    );
  return `WITH INDEX ${names.map((n) => escapeIdent(n as string)).join(", ")}`;
}

/** `VERSION d'…'` — a datetime literal (binds are not accepted in VERSION). */
export function datetimeLiteral(value: unknown, operation: string): string {
  const iso =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : undefined;
  if (iso === undefined || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(iso))
    throw compileError(
      "ValidationError",
      `${operation}: version must be a Date or an ISO-8601 string (got ${describeValue(value)}).`,
      { operation },
    );
  return `d'${iso}'`;
}

/** `TIMEOUT 10s` — a duration literal; a number is milliseconds. */
export function durationLiteral(value: unknown, operation: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw compileError(
        "ValidationError",
        `${operation}: timeout (ms) must be a finite, non-negative number (got ${value}).`,
        { operation },
      );
    return `${value}ms`;
  }
  if (
    typeof value === "string" &&
    /^\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y)$/.test(value)
  )
    return value;
  throw compileError(
    "ValidationError",
    `${operation}: timeout must be milliseconds (number) or a duration string like "10s" (got ${describeValue(value)}).`,
    { operation },
  );
}

/** The `<id>` part of a record id (`users:1` -> `1`), validated against the delegate's table. */
export function recordIdSuffix(
  tableName: string,
  value: unknown,
  side: string,
  operation: string,
): string {
  return escapeRecordIdPart(
    recordIdParts(value, operation, {
      table: tableName,
      fallbackTable: tableName,
      what: `range.${side} record id`,
    }).id,
  );
}

/** Quote an id part only when it isn't a bare identifier/number. */
export function escapeRecordIdPart(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(id) ? id : escapeIdent(id);
}

// --- record ids — ONE parser per rule ------------------------------------------------------------

/** A record-id value split into its table and id parts. */
export interface RecordIdParts {
  readonly table: string;
  readonly id: string;
}

/**
 * Non-throwing record-id split: `"user:aeon"` / `RecordId` -> `{ table, id }`; anything without a
 * table prefix (bare ids, non-strings) resolves `undefined`. The ONE place `table:id` is parsed.
 */
export function splitRecordId(value: unknown): RecordIdParts | undefined {
  const text = String(value ?? "");
  const colon = text.indexOf(":");
  if (colon === -1) return undefined;
  return { table: text.slice(0, colon), id: text.slice(colon + 1) };
}

/**
 * Parse a record-id VALUE with teaching errors: `fallbackTable` accepts a bare id for that table,
 * `table` rejects a record id naming a different table, and `field`/`what` shape the message.
 */
export function recordIdParts(
  value: unknown,
  operation: string,
  options: {
    /** Accept a bare id by attributing it to this table. */
    readonly fallbackTable?: string;
    /** Require an explicit `table:` prefix to name this table. */
    readonly table?: string;
    readonly field?: string;
    readonly what?: string;
  } = {},
): RecordIdParts {
  const what = options.what ?? "record id";
  const context = {
    operation,
    ...(options.table ? { table: options.table } : {}),
    ...(options.field ? { field: options.field } : {}),
  };
  const text = String(value ?? "");
  if (!text)
    throw compileError(
      "ValidationError",
      `${operation}: a ${what} must be non-empty (e.g. "${options.fallbackTable ?? options.table ?? "table"}:1").`,
      context,
    );
  const parts = splitRecordId(text);
  if (!parts) {
    if (options.fallbackTable === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: a ${what} must be "table:id" (got ${describeValue(value)}).`,
        context,
      );
    return { table: options.fallbackTable, id: text };
  }
  if (options.table !== undefined && parts.table !== options.table)
    throw compileError(
      "ValidationError",
      `${operation}: "${text}" is a "${parts.table}" record id, but this delegate targets "${options.table}".`,
      context,
    );
  return parts;
}

/** A plain data object (not a class instance). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Short, safe rendering of a value for teaching messages. */
export function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.length} item(s)]`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const ctor = v.constructor?.name;
    return ctor && ctor !== "Object" ? ctor : "{…}";
  }
  return JSON.stringify(v) ?? String(v);
}
