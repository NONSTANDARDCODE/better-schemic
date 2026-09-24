/**
 * Shared lowering primitives for the write compiler — `WritePlan`/modes, the runtime arg shapes
 * and the helpers every write domain (`./write`, `./mutate`, `./relate`) builds on:
 * codec-validated `data` with expression splice, record targets/ids, RETURN mapping, update
 * modes, patch/unset validation and the small arg guards. One place per rule, like `./shared`.
 */
import { escapeIdent, RecordId } from "surrealdb";
import { hasRefDeep } from "../../pure";
import { normalizeError } from "../errors";
import type { ModelMeta, SchemaIndex } from "../meta";
import type { ProjectionSpec } from "./projection";
import {
  type Binds,
  compileError,
  describeValue,
  durationLiteral,
  escapeRecordIdPart,
  isPlainObject,
  isTableMeta,
  recordIdParts,
  renderPath,
  renderValue,
  splitRecordId,
} from "./shared";
import { uniqueTarget } from "./unique";
import { compileWhere } from "./where";

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
  /** `row` = one record; `many` = a row list; `none` = no payload; `diff` = the raw JSON Patch. */
  readonly result: "row" | "many" | "none" | "diff";
  /** The row may be absent (`.throw()` attaches `NotFoundInfo`) — singular update/patch/delete. */
  readonly mayMiss?: boolean;
  /** `updateEach`'s eager `select` decode spec (the rows come back whole from the server). */
  readonly select?: ProjectionSpec;
}
// --- runtime arg shapes (types live in `../types/write`) -----------------------------------------

export interface CreateRuntimeArgs {
  data?: unknown;
  only?: unknown;
  return?: unknown;
  relate?: unknown;
  meta?: Record<string, unknown>;
}

export interface CreateManyRuntimeArgs {
  data?: unknown;
  skipDuplicates?: unknown;
  return?: unknown;
  meta?: Record<string, unknown>;
}

export interface InsertRuntimeArgs {
  data?: unknown;
  onDuplicate?: unknown;
  return?: unknown;
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
  timeout?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpdateManyRuntimeArgs {
  where?: unknown;
  data?: unknown;
  mode?: unknown;
  patches?: unknown;
  unset?: unknown;
  return?: unknown;
  timeout?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpsertRuntimeArgs {
  where?: unknown;
  data?: unknown;
  create?: unknown;
  update?: unknown;
  mode?: unknown;
  only?: unknown;
  return?: unknown;
  timeout?: unknown;
  meta?: Record<string, unknown>;
}

export interface UpsertManyRuntimeArgs {
  data?: unknown;
  update?: unknown;
  conflict?: unknown;
  return?: unknown;
  meta?: Record<string, unknown>;
}

export interface DeleteRuntimeArgs {
  where?: unknown;
  return?: unknown;
  timeout?: unknown;
  meta?: Record<string, unknown>;
}

export interface DeleteManyRuntimeArgs {
  where?: unknown;
  all?: unknown;
  return?: unknown;
  timeout?: unknown;
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
  timeout?: unknown;
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

/** The bare id text (`users:aeon` -> `aeon`) for comparing two record ids. */
export function recordIdText(id: unknown): string {
  return splitRecordId(id)?.id ?? String(id);
}

/** Coerce an `id` payload to the SDK `RecordId` the codec expects (bare ids use the delegate's table). */
function toRecordId(
  meta: ModelMeta,
  value: unknown,
  operation: string,
): RecordId {
  if (value instanceof RecordId) return value;
  const parts = recordIdParts(value, operation, {
    table: meta.name,
    fallbackTable: meta.name,
    field: "id",
  });
  return new RecordId(parts.table, parts.id);
}

/** Coerce a record-link value to the SDK `RecordId` (the table must be part of the id). */
export function toRecord(value: unknown, operation: string): RecordId {
  if (value instanceof RecordId) return value;
  const parts = recordIdParts(value, operation, { what: "record link" });
  return new RecordId(parts.table, parts.id);
}

/** Resolve the singular write target (id or single-field UNIQUE) + its optional WHERE. */
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
      where: "",
    };
  return {
    target: `${args.only === true ? "ONLY " : ""}${escapeIdent(meta.name)}`,
    where: whereSql(args.where, binds, meta, index),
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

/** ` RETURN AFTER|BEFORE|DIFF|NONE` + ` TIMEOUT …` (AFTER is the server default — omitted). */
export function mutationTail(
  ret: WriteRet,
  timeout: unknown,
  operation: string,
): string {
  const returnClause = ret === "after" ? "" : ` RETURN ${ret.toUpperCase()}`;
  const timeoutClause =
    timeout === undefined
      ? ""
      : ` TIMEOUT ${durationLiteral(timeout, operation)}`;
  return `${returnClause}${timeoutClause}`;
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
