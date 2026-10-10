/**
 * Shared lowering primitives for the write compiler — `WritePlan`/modes, the runtime arg shapes
 * and the helpers every write domain (`./write`, `./mutate`, `./relate`) builds on:
 * codec-validated `data` with expression splice, record targets/ids, RETURN mapping, update
 * modes, patch/unset validation and the small arg guards. One place per rule, like `./shared`.
 */
import { BoundQuery, Decimal, RecordId, toSurqlString } from "surrealdb";
import { escapeIdentSafe as escapeIdent, unescapeIdPart } from "../../ident";
import { hasRefDeep, type IdStrategy } from "../../pure";
import { type Adjustment, adjustmentOf } from "../arithmetic";
import { normalizeError } from "../errors";
import type { ModelMeta, ResolvedIdStrategy, SchemaIndex } from "../meta";
import { compileProjection, type ProjectionSpec } from "./projection";
import {
  type Binds,
  coerceRecordId,
  compileError,
  describeValue,
  durationLiteral,
  escapeRecordIdPart,
  isLowerableValue,
  isPlainObject,
  isTableMeta,
  recordIdParts,
  renderPath,
  renderValue,
  splitRecordId,
} from "./shared";
import { uniqueTarget } from "./unique";
import { compileWhere, mergeScope, scopeWhere } from "./where";

/** The modes a write can rewrite a record with (SurrealQL verbs). */
export type WriteMode = "merge" | "set" | "content" | "replace" | "patch";
/** What a write hands back. */
export type WriteRet = "after" | "before" | "diff" | "none";

/** A compiled write: the statements to run and how to read their rows. */
export interface WritePlan {
  /** The user statements, in order (control statements are the executor's job). */
  readonly statements: readonly string[];
  /** Wrap in `BEGIN/COMMIT` (batch atomicity) — the executor skips it inside a transaction. */
  readonly transactional: boolean;
  /**
   * The statements whose rows carry the answer. Absent = every statement contributes rows
   * (batch ops); singular ops point at the one statement holding the row/state.
   */
  readonly resultIndexes?: readonly number[];
  /** `row` = one record; `many` = a row list; `none` = no payload; `diff` = the raw JSON Patch;
   *  `delta` = the `{ before, after }` envelope `upsertDelta` decodes. */
  readonly result: "row" | "many" | "none" | "diff" | "delta";
  /** The row may be absent (`.throw()` attaches `NotFoundInfo`) — singular update/patch/delete. */
  readonly mayMiss?: boolean;
  /** A miss is an ERROR, not a null: the decode raises `ResultNotFound` — `upsert` with
   *  `onMissing: "throw"` (the default) or a create-mode `return: "after"` that produced no row. */
  readonly missError?: boolean;
  /** The miss came from a STRICT update lowering (`UPDATE ONLY t:id` / `UPDATE … WHERE uniq`),
   *  never from a create branch filtered by a permission/plugin scope. The decode picks the
   *  teaching message from THIS, not from `args.onMissing` (a target-less create has no explicit
   *  `onMissing: "throw"` even though the arg is absent and the default is `"throw"`). */
  readonly strictMiss?: boolean;
  /** A compiled `select`/`omit` decode spec (writes always return whole records otherwise). */
  readonly select?: ProjectionSpec;
  /**
   * How {@link select} applies: `server` (the statement's RETURN clause already carries the
   * projection) or `client` (rows come back whole and are projected after decoding — the
   * before-state, `delete`, `upsertDelta` and OMIT paths; `updateEach`'s select used to be the
   * only client projector).
   */
  readonly selectMode?: "server" | "client";
}
// --- runtime arg shapes (types live in `../types/write`) -----------------------------------------

export interface CreateRuntimeArgs {
  data?: unknown;
  only?: unknown;
  return?: unknown;
  relate?: unknown;
  select?: unknown;
  omit?: unknown;
  meta?: Record<string, unknown>;
}

export interface CreateManyRuntimeArgs {
  data?: unknown;
  skipDuplicates?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  meta?: Record<string, unknown>;
}

export interface InsertRuntimeArgs {
  data?: unknown;
  onDuplicate?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpdateRuntimeArgs {
  where?: unknown;
  data?: unknown;
  mode?: unknown;
  patches?: unknown;
  unset?: unknown;
  only?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  /** Plugin scope (see `Operation.scope`) — AND-combined into the WHERE, never a unique target. */
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpdateManyRuntimeArgs {
  where?: unknown;
  data?: unknown;
  mode?: unknown;
  patches?: unknown;
  unset?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpsertRuntimeArgs {
  where?: unknown;
  data?: unknown;
  create?: unknown;
  update?: unknown;
  mode?: unknown;
  onMissing?: unknown;
  only?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpsertDeltaRuntimeArgs {
  where?: unknown;
  data?: unknown;
  create?: unknown;
  update?: unknown;
  mode?: unknown;
  onMissing?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpsertManyRuntimeArgs {
  data?: unknown;
  update?: unknown;
  conflict?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface DeleteRuntimeArgs {
  where?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface DeleteManyRuntimeArgs {
  where?: unknown;
  all?: unknown;
  return?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpdateEachRuntimeArgs {
  data?: unknown;
  by?: unknown;
  mode?: unknown;
  patches?: unknown;
  onEmpty?: unknown;
  return?: unknown;
  select?: unknown;
  omit?: unknown;
  timeout?: unknown;
  scope?: unknown;
  meta?: Record<string, unknown>;
}
// --- shared helpers ------------------------------------------------------------------------------

/** Validate + encode a `data` payload; fields with expressions bypass the codec (server-enforced). */
export function encodeData(
  meta: ModelMeta,
  data: unknown,
  kind: "create" | "update",
  operation: string,
): unknown {
  if (data === undefined)
    throw compileError("ValidationError", `${operation}: data is required.`, {
      operation,
      table: meta.name,
    });
  if (!isPlainObject(data))
    throw compileError(
      "ValidationError",
      `${operation}: data must be a plain object (got ${describeValue(data)}). Use a surql fragment inside a field for expressions.`,
      { operation, table: meta.name },
    );
  // BACKSTOP: adjustments are extracted (and lowered) BEFORE encoding on every update path; any
  // payload that still carries one here is a create-shaped write (create/insert/relate/ON
  // DUPLICATE map), which has no previous value to adjust.
  for (const [key, value] of Object.entries(data)) {
    const marker = adjustmentOf(value);
    if (marker)
      throw compileError(
        "ValidationError",
        `${operation}: "${key}" uses { ${marker.kind}: … } — an adjustment needs an EXISTING value, so it can't be written by a create/insert/relate or an ON DUPLICATE map. Use update/updateMany/updateEach (or pass a plain value here).`,
        { operation, table: meta.name, field: key },
      );
  }
  if (!isTableMeta(meta)) return data;
  const normalized: Record<string, unknown> = { ...data };
  if (normalized.id !== undefined && !(normalized.id instanceof RecordId))
    normalized.id = toRecordId(meta, normalized.id, operation);
  const literals: Record<string, unknown> = {};
  const expressions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    if (hasRefDeep(value)) expressions[key] = value;
    else literals[key] = value;
  }
  let encoded: Record<string, unknown> = {};
  if (Object.keys(literals).length > 0) {
    const result =
      kind === "create"
        ? meta.def.safeEncode(literals as never)
        : meta.def.safeEncodePartial(literals as never);
    if (!result.success)
      throw normalizeError(result.error, {
        table: meta.name,
        operation,
        details: result.error,
      });
    encoded = result.data as Record<string, unknown>;
  }
  return { ...encoded, ...expressions };
}

/** Render an encoded payload as a statement operand (whole-bind when pure, splice when expressions). */
export function payload(value: unknown, binds: Binds): string {
  return renderValue(value, binds, binds.ctx());
}

/** `t:<id>` with the id part escaped and the table validated (`user:aeon` / bare ids accepted). */
export function recordTarget(
  meta: ModelMeta,
  id: unknown,
  operation: string,
): string {
  const parts = recordIdParts(id, operation, {
    table: meta.name,
    fallbackTable: meta.name,
  });
  return `${escapeIdent(meta.name)}:${escapeRecordIdPart(parts.id)}`;
}

/** The RAW bare id text (`users:⟨a b⟩` -> `a b`) for comparing two record ids. */
export function recordIdText(id: unknown): string {
  return unescapeIdPart(splitRecordId(id)?.id ?? String(id));
}

// --- generated ids (per-table `idStrategy`) ------------------------------------------------------

/** The server expression that generates a record id for a strategy. */
const ID_FN: Record<IdStrategy, string> = {
  ulid: "rand::ulid()",
  uuid: "rand::uuid()",
  rand: "rand::id()",
};

/** The ORM create-id strategy of a model: typed tables carry the resolved strategy; schemaless
 *  entries can't declare one and ride the uniform `"ulid"` default. */
export function idStrategyOf(meta: ModelMeta): ResolvedIdStrategy {
  return isTableMeta(meta) ? meta.idStrategy : "ulid";
}

/** How (or whether) the ORM generates a create id for a model. */
type IdGeneration =
  /** No injection needed: the plain target already yields the server default (`rand`), or the id
   *  is fixed (a singleton). */
  | { readonly kind: "server" }
  /** `type::record(<table>, <fn>)` for CREATE/UPSERT targets, `<fn>` as the INSERT `id` field. */
  | { readonly kind: "target"; readonly fn: string }
  /** The declared id field's codec can't be produced by any strategy (uuid v4/v6) — creating
   *  without an explicit id is a compile error, never a doomed server write. */
  | { readonly kind: "explicit" };

/** Resolve the ONE generation decision every create path shares. */
function idGenerationOf(meta: ModelMeta): IdGeneration {
  if (isTableMeta(meta) && meta.singletonId !== undefined)
    return { kind: "server" };
  const strategy = idStrategyOf(meta);
  if (strategy === "rand") return { kind: "server" };
  if (strategy === "none") return { kind: "explicit" };
  return { kind: "target", fn: ID_FN[strategy] };
}

/** The teaching error for a create that needs a generated id on an explicit-only table. */
function explicitIdError(meta: ModelMeta): ReturnType<typeof compileError> {
  return compileError(
    "ValidationError",
    `cannot generate an id for table "${meta.name}": its declared id field uses a format no ORM strategy produces (uuid v4/v6) — pass an explicit "id", or change the id field.`,
    { table: meta.name },
  );
}

/** The explicit `id` of a payload, or a singleton delegate's fixed id. */
export function createId(meta: ModelMeta, data: unknown): unknown {
  if (isPlainObject(data) && data.id !== undefined) return data.id;
  const singleton = isTableMeta(meta) ? meta.singletonId : undefined;
  if (singleton !== undefined) return `${meta.name}:${singleton}`;
  return undefined;
}

/**
 * The `type::record(<table>, <fn>())` create target that generates an id server-side — or
 * `undefined` when the plain target already does the job (the server default for `rand`, or a
 * singleton's fixed id). An explicit-only table (uuid v4/v6 id field) THROWS: there is no id the
 * ORM can generate.
 *
 * The table name is rendered with `toSurqlString` (`s"user"`): an ESCAPED identifier
 * (`escapeIdent` -> `⟨weird-name⟩`) is double-escaped inside `type::record`, live-probed on 3.2.
 */
export function generatedTarget(meta: ModelMeta): string | undefined {
  const generation = idGenerationOf(meta);
  if (generation.kind === "explicit") throw explicitIdError(meta);
  if (generation.kind === "server") return undefined;
  return `type::record(${toSurqlString(meta.name)}, ${generation.fn})`;
}

/** `ONLY t:id` / `t:id` / `ONLY type::record(t, fn())` / `t` target for CREATE. An explicit payload
 *  `id` (or a singleton's fixed id) always wins over the table's strategy. */
export function createTarget(
  meta: ModelMeta,
  data: unknown,
  only: boolean,
  operation: string,
): string {
  const id = createId(meta, data);
  const prefix = only ? "ONLY " : "";
  if (id !== undefined) return `${prefix}${recordTarget(meta, id, operation)}`;
  const generated = generatedTarget(meta);
  if (generated !== undefined) return `${prefix}${generated}`;
  return `${prefix}${escapeIdent(meta.name)}`;
}

/**
 * Add the generated `id` expression field to an INSERT payload (`{ …, id: rand::ulid() }`) when the
 * model's strategy isn't the server default and the payload has no explicit id. The object renders
 * as a SurrealQL literal with per-field binds (object spread + expression is a parse error on 3.2).
 */
export function withGeneratedId(meta: ModelMeta, encoded: unknown): unknown {
  if (!isPlainObject(encoded) || encoded.id !== undefined) return encoded;
  const generation = idGenerationOf(meta);
  if (generation.kind === "explicit") throw explicitIdError(meta);
  if (generation.kind === "server") return encoded;
  return { ...encoded, id: new BoundQuery(generation.fn) };
}

/** Coerce an `id` payload to the SDK `RecordId` the codec expects (bare ids use the delegate's table). */
function toRecordId(
  meta: ModelMeta,
  value: unknown,
  operation: string,
): RecordId {
  return coerceRecordId(value, operation, {
    table: meta.name,
    fallbackTable: meta.name,
    field: "id",
    what: "id",
  });
}

/** Coerce a record-link value to the SDK `RecordId`; a bare id needs a SINGLE target table. */
export function toRecord(
  value: unknown,
  operation: string,
  targets?: readonly string[],
): RecordId {
  const single = targets?.length === 1 ? (targets[0] as string) : undefined;
  return coerceRecordId(value, operation, {
    ...(single === undefined ? {} : { table: single, fallbackTable: single }),
    what: "record link",
  });
}

/** The singular write target (id or single-field UNIQUE) + its optional WHERE. */
export function singleTarget(
  meta: ModelMeta,
  args: UpdateRuntimeArgs,
  binds: Binds,
  operation: string,
  index?: SchemaIndex,
): { target: string; where: string } {
  const target = uniqueTarget(meta, args.where, operation);
  if (target.kind === "id")
    return {
      target: `${args.only === true ? "ONLY " : ""}${recordTarget(meta, target.id, operation)}`,
      where: scopeWhere(args.scope, binds, meta, index),
    };
  return {
    target: `${args.only === true ? "ONLY " : ""}${escapeIdent(meta.name)}`,
    where: whereSql(mergeScope(args.where, args.scope), binds, meta, index),
  };
}

/** ` WHERE <predicate>` (empty string when there is no filter). */
export function whereSql(
  where: unknown,
  binds: Binds,
  meta: ModelMeta,
  index?: SchemaIndex,
): string {
  const predicate = compileWhere(where, binds, {
    ...(isTableMeta(meta) ? { meta } : {}),
    ...(index ? { index } : {}),
  });
  return predicate ? ` WHERE ${predicate}` : "";
}

/** Validate a `return` arg against the op's allowed modes (defaults when absent). */
export function readReturn(
  value: unknown,
  operation: string,
  allowed: readonly WriteRet[],
  fallback: WriteRet,
): WriteRet {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as WriteRet))
    throw compileError(
      "ReturnNotSupported",
      `${operation}: return must be ${allowed.map((entry) => `"${entry}"`).join(" | ")} (got ${describeValue(value)}).`,
      { operation },
    );
  return value as WriteRet;
}

/** ` RETURN AFTER|BEFORE|DIFF|NONE` + ` TIMEOUT …` (AFTER is the server default — omitted). When
 *  `projText` is given (a server-side `select`), the default AFTER form is replaced by the
 *  projection itself: ` RETURN name, balance` / ` RETURN *, author.id AS author_id`. */
export function mutationTail(
  ret: WriteRet,
  timeout: unknown,
  operation: string,
  projText?: string,
): string {
  const returnClause =
    ret === "after"
      ? projText === undefined
        ? ""
        : ` RETURN ${projText}`
      : ` RETURN ${ret.toUpperCase()}`;
  const timeoutClause =
    timeout === undefined
      ? ""
      : ` TIMEOUT ${durationLiteral(timeout, operation)}`;
  return `${returnClause}${timeoutClause}`;
}

/** The `upsertDelta` envelope: `before`/`after` come from the statement's own state (one snapshot). */
export const DELTA_ENVELOPE =
  " RETURN VALUE { before: $before, after: $after }";

/** The delta envelope + ` TIMEOUT …` (RETURN must precede TIMEOUT — live-probed 3.2). */
export function deltaTail(timeout: unknown, operation: string): string {
  const timeoutClause =
    timeout === undefined
      ? ""
      : ` TIMEOUT ${durationLiteral(timeout, operation)}`;
  return `${DELTA_ENVELOPE}${timeoutClause}`;
}

// --- write projections (`select`/`omit` on the returned rows) ------------------------------------

/** A compiled write projection: the server text + the decode spec + where it can apply. */
export interface CompiledWriteProjection {
  /** The projection list (`name, address.city`, `*`, an expression alias) for `RETURN <text>`. */
  readonly text: string;
  readonly spec: ProjectionSpec;
  /** The RETURN clause can carry it (no OMIT — `RETURN … OMIT` is a parse error, live-probed). */
  readonly server: boolean;
}

/** Compile `select`/`omit` for a write — `undefined` when neither was passed (zero overhead). */
export function compileWriteProjection(
  meta: ModelMeta,
  args: { select?: unknown; omit?: unknown },
  binds: Binds,
  operation: string,
): CompiledWriteProjection | undefined {
  if (args.select === undefined && args.omit === undefined) return undefined;
  const { text, spec } = compileProjection(
    meta,
    args.select,
    args.omit,
    false,
    binds,
    operation,
  );
  // `select: { "*": true }` / `omit: []` project nothing — skip the clause (and the client decode).
  if (spec.star && spec.omit.length === 0 && spec.fields.length === 0)
    return undefined;
  return { text, spec, server: spec.omit.length === 0 };
}

/** A resolved write projection: how it applies + the compiled pieces. */
export interface ProjectionPlan {
  readonly mode: "server" | "client";
  readonly proj: CompiledWriteProjection;
}

/**
 * Resolve how a projection applies (and validate it): `server` when the RETURN clause can carry it
 * (AFTER state, no OMIT), `client` when the rows must come back whole and be projected on the
 * decoded app rows (BEFORE state, `delete`, `upsertDelta`, OMIT and the `create.relate` sugar).
 * A client-side projection can't compute expressions — those are rejected with a teaching error.
 * `undefined` = no projection, or a state that returns no rows (`none`/`diff`).
 */
export function selectMode(
  proj: CompiledWriteProjection | undefined,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
  options: { readonly clientOnly?: boolean } = {},
): ProjectionPlan | undefined {
  if (!proj || ret === "none" || ret === "diff") return undefined;
  if (options.clientOnly === true || !proj.server || ret === "before") {
    if (proj.spec.fields.some((field) => field.computed === true))
      throw compileError(
        "ReturnNotSupported",
        `${operation}: a projection with an expression entry can't shape the ${
          ret === "before" ? "BEFORE state" : "rows this lowering returns"
        } client-side — use return: "after" with plain paths/aliases, or drop the expression.`,
        { operation, table: meta.name },
      );
    return { mode: "client", proj };
  }
  return { mode: "server", proj };
}

/** Reject a `select`/`omit` on a `RETURN DIFF` lowering (a patch list has no fields to project). */
export function assertProjectable(
  proj: CompiledWriteProjection | undefined,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
): void {
  if (!proj || ret !== "diff") return;
  throw compileError(
    "ReturnNotSupported",
    `${operation}: RETURN DIFF returns a JSON Patch list, not rows — drop select/omit, or use return: "after"/"before".`,
    { operation, table: meta.name },
  );
}

// --- arithmetic adjustments (`{ increment }` / `{ decrement }`) ----------------------------------

/** One field adjustment to lower as `SET <field> ±= <value>`. */
export interface ArithmeticStep {
  /** The top-level field (raw app name; `updateBody` escapes it). */
  readonly field: string;
  readonly op: "+" | "-";
  readonly value: unknown;
}

const NO_STEPS: readonly ArithmeticStep[] = [];

/**
 * Split a write payload into its adjustment STEPS and the CLEAN payload the codec validates.
 * Adjustments are a TOP-LEVEL concern (each operand substitutes its field in the clean copy).
 * `allow: false` (create-shaped writes) rejects any marker with a teaching error; every
 * adjustment is validated against the schema (numeric field, known name, non-id) at THIS point,
 * so a typo fails before any query runs.
 */
export function extractArithmetic(
  meta: ModelMeta,
  data: unknown,
  operation: string,
  allow: boolean,
): { clean: unknown; steps: readonly ArithmeticStep[] } {
  if (!isPlainObject(data)) return { clean: data, steps: NO_STEPS };
  let steps: ArithmeticStep[] | undefined;
  let clean: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(data)) {
    const marker = adjustmentOf(value);
    if (!marker) continue;
    if (!allow)
      throw compileError(
        "ValidationError",
        `${operation}: "${field}" uses { ${marker.kind}: … } — an adjustment changes an EXISTING value, so it can't run in a create/insert (or the create branch of an upsert). Use update/updateMany/updateEach, or pass a plain value here.`,
        { operation, table: meta.name, field },
      );
    assertAdjustment(meta, field, marker, operation);
    steps ??= [];
    steps.push({ field, op: marker.op, value: marker.value });
    clean ??= { ...data };
    delete clean[field];
  }
  return { clean: clean ?? data, steps: steps ?? NO_STEPS };
}

/** Validate one adjustment's target field + operand (numeric column, known name, never `id`). */
function assertAdjustment(
  meta: ModelMeta,
  field: string,
  marker: Adjustment,
  operation: string,
): void {
  if (field === "id")
    throw compileError(
      "ValidationError",
      `${operation}: "id" can't be adjusted — it is the record identity.`,
      { operation, table: meta.name, field },
    );
  const operand = marker.value;
  if (
    typeof operand !== "number" &&
    typeof operand !== "bigint" &&
    !(operand instanceof Decimal) &&
    !isLowerableValue(operand)
  )
    throw compileError(
      "ValidationError",
      `${operation}: { ${marker.kind}: … } needs a number, bigint, Decimal or expression operand (got ${describeValue(operand)}).`,
      { operation, table: meta.name, field },
    );
  if (!isTableMeta(meta)) return;
  const column = meta.columns.get(field);
  if (!column)
    throw compileError(
      "ValidationError",
      `${operation}: "${field}" is not a field of "${meta.name}". Known fields: ${[...meta.columns.keys()].join(", ")}.`,
      { operation, table: meta.name, field },
    );
  if (column.family !== "number")
    throw compileError(
      "ValidationError",
      `${operation}: "${field}" is a ${column.family} field — { ${marker.kind}: … } needs a numeric field (int/float/decimal). Use a plain value or a surql fragment for other sweeps.`,
      { operation, table: meta.name, field },
    );
}

/** `f = $p, g += $q` — the SET clause of an update body (`deep` flattens nested plain objects to
 *  leaf paths so merge semantics survive the mode switch, e.g. `address.city = $p`). */
export function setBody(
  encoded: unknown,
  steps: readonly ArithmeticStep[],
  binds: Binds,
  deep: boolean,
): string {
  const parts: string[] = [];
  if (isPlainObject(encoded)) {
    for (const [field, value] of Object.entries(encoded)) {
      if (value === undefined) continue;
      if (deep && isPlainObject(value)) {
        flattenAssignments(value, [field], parts, binds);
        continue;
      }
      parts.push(
        `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`,
      );
    }
  }
  for (const step of steps)
    parts.push(
      `${renderPath(step.field)} ${step.op}= ${renderValue(step.value, binds, binds.ctx())}`,
    );
  return `SET ${parts.join(", ")}`;
}

/** Flatten a nested plain object into `a.b.c = $p` assignments; empty objects contribute none
 *  (a deep `MERGE` of `{ a: {} }` is a no-op). */
function flattenAssignments(
  value: unknown,
  path: readonly string[],
  out: string[],
  binds: Binds,
): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value))
      flattenAssignments(child, [...path, key], out, binds);
    return;
  }
  out.push(
    `${path.map(renderPath).join(".")} = ${renderValue(value, binds, binds.ctx())}`,
  );
}

/**
 * The `data` clause of an update-shaped write, adjustment-aware:
 * - no adjustments → the plain mode body (`MERGE $p` / `SET …` / `CONTENT $p` / …);
 * - adjustments → a `SET` clause combining the clean fields with `f ±= $p` steps (merge flattens
 *   nested objects to leaves — a `SET f = $p` would replace them, where `MERGE` deep-merges).
 * `content`/`replace` reject adjustments (they rewrite the whole record, so there is no
 * "existing value" contract to add to).
 */
export function updateBody(
  meta: ModelMeta,
  mode: WriteMode,
  data: unknown,
  binds: Binds,
  operation: string,
): string {
  const { clean, steps } = extractArithmetic(meta, data, operation, true);
  if (steps.length === 0)
    return encodedBody(
      mode,
      encodeData(
        meta,
        clean,
        mode === "content" || mode === "replace" ? "create" : "update",
        operation,
      ),
      binds,
    );
  if (mode !== "merge" && mode !== "set")
    throw compileError(
      "ValidationError",
      `${operation}: { increment/decrement: … } needs an EXISTING value — mode "${mode}" rewrites the whole record. Use the default merge (or mode: "set").`,
      { operation, table: meta.name },
    );
  return setBody(
    encodeData(meta, clean, "update", operation),
    steps,
    binds,
    mode === "merge",
  );
}

/** Map a `return` + cardinality to the plan's result interpretation. */
export function resultOf(
  ret: WriteRet,
  cardinality: "row" | "many",
): WritePlan["result"] {
  if (ret === "none") return "none";
  if (ret === "diff") return "diff";
  return cardinality;
}

/** Validate an update `mode`. */
export function updateMode(
  value: unknown,
  operation: string,
  fallback: WriteMode,
): WriteMode {
  if (value === undefined) return fallback;
  if (
    typeof value !== "string" ||
    !["merge", "set", "content", "replace", "patch"].includes(value)
  )
    throw compileError(
      "ValidationError",
      `${operation}: mode must be "merge" | "set" | "content" | "replace" | "patch" (got ${describeValue(value)}).`,
      { operation },
    );
  return value as WriteMode;
}

/** The clause a mutation mode emits, from an ALREADY-ENCODED payload (`./write` encodes once). */
export function encodedBody(
  mode: WriteMode,
  encoded: unknown,
  binds: Binds,
): string {
  switch (mode) {
    case "merge":
      return `MERGE ${payload(encoded, binds)}`;
    case "content":
      return `CONTENT ${payload(encoded, binds)}`;
    case "replace":
      return `REPLACE ${payload(encoded, binds)}`;
    case "set":
      return `SET ${setAssignments(encoded, binds)}`;
    case "patch":
      return `PATCH ${binds.add(encoded)}`;
  }
}

/** `SET f = $p, g = <expr>` — literals bind per field (already codec-encoded), expressions splice. */
export function setAssignments(encoded: unknown, binds: Binds): string {
  if (!isPlainObject(encoded) || Object.keys(encoded).length === 0)
    throw compileError(
      "ValidationError",
      'mode "set" needs "data" with at least one field.',
    );
  return Object.entries(encoded)
    .map(
      ([field, value]) =>
        `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`,
    )
    .join(", ");
}

/** `f = $p.f, g = <expr>` for `ON DUPLICATE KEY UPDATE` from an encoded update payload. */
export function assignmentList(encoded: unknown, binds: Binds): string {
  if (!isPlainObject(encoded)) return "";
  const literals: Record<string, unknown> = {};
  const expressions: [string, unknown][] = [];
  for (const [field, value] of Object.entries(encoded)) {
    if (hasRefDeep(value)) expressions.push([field, value]);
    else literals[field] = value;
  }
  const parts: string[] = [];
  if (Object.keys(literals).length > 0) {
    const bind = binds.add(literals);
    for (const field of Object.keys(literals))
      parts.push(`${renderPath(field)} = ${bind}.${renderPath(field)}`);
  }
  for (const [field, value] of expressions)
    parts.push(
      `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`,
    );
  return parts.join(", ");
}

/** The top-level fields an `ON DUPLICATE` update may touch (never identity). */
export function updatableFields(encoded: unknown): string[] {
  const items = Array.isArray(encoded) ? encoded : [encoded];
  const fields = new Set<string>();
  for (const item of items)
    if (isPlainObject(item))
      for (const field of Object.keys(item))
        if (field !== "id" && field !== "in" && field !== "out")
          fields.add(field);
  return [...fields];
}

/** Validate `unset` and return the field list (id is identity, unknown fields are typos). */
export function unsetList(
  value: unknown,
  meta: ModelMeta,
  operation: string,
): readonly string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: "unset" is empty — list the fields to remove.`,
      { operation, table: meta.name },
    );
  for (const field of entries) {
    if (typeof field !== "string" || !field)
      throw compileError(
        "ValidationError",
        `${operation}: unset entries must be field names, got ${describeValue(field)}.`,
        { operation, table: meta.name },
      );
    if (field === "id")
      throw compileError(
        "ValidationError",
        `${operation}: "id" cannot be unset (it is the record identity).`,
        { operation, table: meta.name, field },
      );
    requireColumn(meta, field, operation);
  }
  return entries as readonly string[];
}

/** Validate a JSON Patch array (shape + ops) and return it for binding. */
export function patchOps(
  value: unknown,
  operation: string,
): readonly unknown[] {
  const entries = requireArray(value, "patches", operation);
  if (entries.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: "patches" is empty — pass at least one JSON Patch op.`,
      { operation },
    );
  const allowed = ["add", "remove", "replace", "move", "copy", "test"];
  entries.forEach((entry, i) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.op !== "string" ||
      typeof entry.path !== "string"
    )
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] must be { op, path, … } (JSON Patch), got ${describeValue(entry)}.`,
        { operation },
      );
    if (!allowed.includes(entry.op))
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}].op must be one of ${allowed.join(", ")} (got "${entry.op}").`,
        { operation },
      );
    if (
      (entry.op === "move" || entry.op === "copy") &&
      typeof entry.from !== "string"
    )
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] (${entry.op}) needs a "from" path.`,
        { operation },
      );
    if (
      (entry.op === "add" || entry.op === "replace" || entry.op === "test") &&
      entry.value === undefined
    )
      throw compileError(
        "ValidationError",
        `${operation}: patches[${i}] (${entry.op}) needs a "value".`,
        { operation },
      );
  });
  return entries;
}

/** A non-empty array arg. */
export function requireArray(
  value: unknown,
  name: string,
  operation: string,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: "${name}" must be a non-empty array (got ${describeValue(value)}).`,
      { operation },
    );
  return value;
}

/** A non-empty string arg. */
export function requireString(
  value: unknown,
  name: string,
  operation: string,
): string {
  if (typeof value !== "string" || !value)
    throw compileError(
      "ValidationError",
      `${operation}: "${name}" must be a non-empty string (got ${describeValue(value)}).`,
      { operation },
    );
  return value;
}

/** A field of the table (schemaless delegates accept anything). */
export function requireColumn(
  meta: ModelMeta,
  field: string,
  operation: string,
): void {
  if (!isTableMeta(meta) || meta.columns.has(field)) return;
  throw compileError(
    "ValidationError",
    `${operation}: "${field}" is not a field of "${meta.name}". Known fields: ${[...meta.columns.keys()].join(", ")}.`,
    { operation, table: meta.name, field },
  );
}

/** Is `field` the record id or a record-link column (values coerce to `RecordId`)? */
export function isRecordColumn(meta: ModelMeta, field: string): boolean {
  if (field === "id") return true;
  return isTableMeta(meta) && meta.columns.get(field)?.record !== undefined;
}
