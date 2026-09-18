/**
 * The mutation lowering — `update`/`updateMany`/`patch`/`upsert`/`upsertMany`/`delete`/
 * `deleteMany`/`updateEach`. Singular targets are record ids or a single-field UNIQUE index
 * (`uniqueTarget`) and never create; batches set `transactional: true` for atomicity.
 */
import { escapeIdent, RecordId } from "surrealdb";
import { hasRefDeep } from "../../pure";
import type { ModelMeta } from "../meta";
import { compileProjection } from "./projection";
import {
  type Binds,
  compileError,
  describeValue,
  isPlainObject,
  renderPath,
} from "./shared";
import { requireUniqueField, uniqueTarget } from "./unique";
import {
  assignmentList,
  type DeleteManyRuntimeArgs,
  type DeleteRuntimeArgs,
  encodeData,
  encodedBody,
  isRecordColumn,
  mutationTail,
  patchOps,
  payload,
  readReturn,
  recordIdText,
  recordTarget,
  requireArray,
  requireColumn,
  requireString,
  resultOf,
  singleTarget,
  toRecord,
  type UpdateEachRuntimeArgs,
  type UpdateManyRuntimeArgs,
  type UpdateRuntimeArgs,
  type UpsertManyRuntimeArgs,
  type UpsertRuntimeArgs,
  unsetList,
  updatableFields,
  updateMode,
  type WriteMode,
  type WritePlan,
  type WriteRet,
  whereSql,
} from "./write-shared";

// --- update / patch ------------------------------------------------------------------------------

/** Compile `update` — unique target only; a miss resolves `null` (never creates). */
export function compileUpdate(
  meta: ModelMeta,
  args: UpdateRuntimeArgs,
  binds: Binds,
  operation = "update",
): WritePlan {
  const { target, where } = singleTarget(meta, args, binds, operation);
  return compileMutation(meta, target, where, args, binds, operation, "row");
}

/** Compile `updateMany` — every matching row (`where` optional; `rules` guards land in M6). */
export function compileUpdateMany(
  meta: ModelMeta,
  args: UpdateManyRuntimeArgs,
  binds: Binds,
  operation = "updateMany",
): WritePlan {
  const where = whereSql(args.where, binds, meta);
  return compileMutation(
    meta,
    escapeIdent(meta.name),
    where,
    args,
    binds,
    operation,
    "many",
  );
}

/** Compile `patch` — JSON Patch by unique target (`UPDATE … PATCH $ops`). */
export function compilePatch(
  meta: ModelMeta,
  args: UpdateRuntimeArgs,
  binds: Binds,
  operation = "patch",
): WritePlan {
  const { target, where } = singleTarget(meta, args, binds, operation);
  return compileMutation(
    meta,
    target,
    where,
    { ...args, mode: "patch" },
    binds,
    operation,
    "row",
  );
}

/** The `UPDATE` mutation shared by `update`, `updateMany` and `patch`. */
function compileMutation(
  meta: ModelMeta,
  target: string,
  where: string,
  args: UpdateRuntimeArgs,
  binds: Binds,
  operation: string,
  cardinality: "row" | "many",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  const mode = updateMode(
    args.mode,
    operation,
    args.patches !== undefined && args.data === undefined ? "patch" : "merge",
  );
  const hasData = args.data !== undefined;
  const hasPatches = args.patches !== undefined;
  const unset = unsetList(args.unset, meta, operation);
  const hasUnset = unset.length > 0;

  if (hasData && hasPatches)
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" OR "patches", not both.`,
      { operation, table: meta.name },
    );
  if (!hasData && !hasPatches && !hasUnset)
    throw compileError(
      "ValidationError",
      `${operation}: nothing to write — pass "data", "patches" or "unset".`,
      { operation, table: meta.name },
    );
  if (mode === "patch" && !hasPatches)
    throw compileError(
      "ValidationError",
      `${operation}: mode "patch" needs "patches" (an array of JSON Patch ops).`,
      { operation, table: meta.name },
    );
  if (mode !== "patch" && hasPatches)
    throw compileError(
      "ValidationError",
      `${operation}: "patches" requires mode "patch" (got "${mode}").`,
      { operation, table: meta.name },
    );
  if (hasData && isPlainObject(args.data) && args.data.id !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "id" cannot be updated (it is the record identity) — use upsert to target-or-create.`,
      { operation, table: meta.name, field: "id" },
    );

  const steps: string[] = [];
  if (hasData) {
    const encoded = encodeData(
      meta,
      args.data,
      mode === "content" || mode === "replace" ? "create" : "update",
      operation,
    );
    steps.push(
      `UPDATE ${target} ${encodedBody(mode, encoded, binds)}${where}${mutationTail(ret, args.timeout, operation)}`,
    );
  }
  if (hasPatches)
    steps.push(
      `UPDATE ${target} ${encodedBody("patch", patchOps(args.patches, operation), binds)}${where}${mutationTail(ret, args.timeout, operation)}`,
    );
  if (hasUnset)
    steps.push(
      `UPDATE ${target} UNSET ${unset.map(renderPath).join(", ")}${where}${mutationTail(ret, args.timeout, operation)}`,
    );

  // `before` reads the FIRST statement (the state before anything changed); `diff` combines every
  // statement's patch (data + unset); `after` reads the last (the final state).
  const resultIndexes =
    ret === "before"
      ? [0]
      : ret === "diff"
        ? steps.map((_, i) => i)
        : [steps.length - 1];
  const result = resultOf(ret, cardinality);
  return {
    statements: steps,
    transactional: steps.length > 1,
    resultIndexes,
    result,
    mayMiss: result === "row",
  };
}

// --- upsert --------------------------------------------------------------------------------------

/** Compile `upsert` — create-or-update by id or a single-field UNIQUE index. */
export function compileUpsert(
  meta: ModelMeta,
  args: UpsertRuntimeArgs,
  binds: Binds,
  operation = "upsert",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  const hasData = args.data !== undefined;
  const hasCreate = args.create !== undefined;
  const hasUpdate = args.update !== undefined;
  if (!hasData && !(hasCreate && hasUpdate))
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" (one payload for both branches) OR "create" + "update".`,
      { operation, table: meta.name },
    );
  if (hasData && (hasCreate || hasUpdate))
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" OR "create" + "update" — not both.`,
      { operation, table: meta.name },
    );

  const target = uniqueTarget(meta, args.where, operation);
  const mode = updateMode(args.mode, operation, "merge");
  if (mode === "patch")
    throw compileError(
      "ValidationError",
      `${operation}: mode "patch" is not part of upsert — use patch() or update({ mode: "patch" }).`,
      { operation, table: meta.name },
    );
  const only = args.only === true ? "ONLY " : "";

  if (hasData) {
    const encoded = encodeData(
      meta,
      args.data,
      mode === "content" || mode === "replace" ? "create" : "update",
      operation,
    );
    const hasExpressions =
      isPlainObject(encoded) && Object.values(encoded).some(hasRefDeep);
    if (!hasExpressions) {
      const body = encodedBody(mode, encoded, binds);
      const sql =
        target.kind === "id"
          ? `UPSERT ${only}${recordTarget(meta, target.id, operation)} ${body}${mutationTail(ret, args.timeout, operation)}`
          : `UPSERT ${only}${escapeIdent(meta.name)} ${body} WHERE ${renderPath(target.field)} = ${binds.add(target.value)}${mutationTail(ret, args.timeout, operation)}`;
      return {
        statements: [sql],
        transactional: false,
        resultIndexes: [0],
        result: resultOf(ret, "row"),
      };
    }
    // Expressions can reference the existing row — `UPSERT … WHERE` would evaluate them on the
    // (empty) create branch too, so the LET/IF form distinguishes the branches first.
    return compileUpsertIfElse(
      meta,
      upsertWhere(meta, target, binds),
      { ...args, create: args.data, update: args.data },
      mode,
      ret,
      binds,
      operation,
    );
  }

  return compileUpsertBranches(meta, target, args, mode, ret, binds, operation);
}

/** The LET/IF `WHERE` for a resolved unique target (`id = $record` / `uniq = $value`). */
function upsertWhere(
  meta: ModelMeta,
  target: ReturnType<typeof uniqueTarget>,
  binds: Binds,
): string {
  return target.kind === "id"
    ? `id = ${binds.add(new RecordId(meta.name, target.id))}`
    : `${renderPath(target.field)} = ${binds.add(target.value)}`;
}

/** `create` + `update` distinct: `INSERT … ON DUPLICATE` (literal update) or `LET`/`IF`. */
function compileUpsertBranches(
  meta: ModelMeta,
  target: ReturnType<typeof uniqueTarget>,
  args: UpsertRuntimeArgs,
  mode: WriteMode,
  ret: WriteRet,
  binds: Binds,
  operation: string,
): WritePlan {
  const updateEncoded = encodeData(meta, args.update, "update", operation);
  if (target.kind === "id") {
    const createId = isPlainObject(args.create) ? args.create.id : undefined;
    if (createId === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: "create" must include the "id" when targeting one.`,
        { operation, table: meta.name },
      );
    if (recordIdText(createId) !== recordIdText(target.id))
      throw compileError(
        "ValidationError",
        `${operation}: "create.id" (${String(createId)}) must match where.id (${String(target.id)}).`,
        { operation, table: meta.name },
      );
  }
  const hasExpressions =
    isPlainObject(updateEncoded) &&
    Object.values(updateEncoded).some(hasRefDeep);
  if (target.kind === "id" && !hasExpressions) {
    const createEncoded = encodeData(meta, args.create, "create", operation);
    const assignments = assignmentList(updateEncoded, binds);
    if (!assignments)
      throw compileError(
        "ValidationError",
        `${operation}: "update" needs at least one field.`,
        { operation, table: meta.name },
      );
    const sql =
      `INSERT INTO ${escapeIdent(meta.name)} ${payload(createEncoded, binds)} ` +
      `ON DUPLICATE KEY UPDATE ${assignments}${mutationTail(ret, args.timeout, operation)}`;
    return {
      statements: [sql],
      transactional: false,
      resultIndexes: [0],
      result: resultOf(ret, "row"),
    };
  }
  return compileUpsertIfElse(
    meta,
    upsertWhere(meta, target, binds),
    args,
    mode,
    ret,
    binds,
    operation,
  );
}

/**
 * The LET/IF create-or-update: `LET $__existing = (SELECT VALUE id … LIMIT 1); IF … THEN CREATE …
 * ELSE UPDATE … END;`. Correct for expressions that read the existing row (`age + 1`), which the
 * `ON DUPLICATE KEY UPDATE` path evaluates on the create branch too (live-probed). The one lowering
 * that cannot honor `RETURN DIFF` — the guard lives HERE so every caller inherits it.
 */
function compileUpsertIfElse(
  meta: ModelMeta,
  where: string,
  args: UpsertRuntimeArgs,
  mode: WriteMode,
  ret: WriteRet,
  binds: Binds,
  operation: string,
): WritePlan {
  if (ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF is not supported when expressions must read the existing row (LET/IF) — use "after"/"before"/"none".`,
      { operation, table: meta.name },
    );
  const table = escapeIdent(meta.name);
  const createEncoded = encodeData(meta, args.create, "create", operation);
  // `CREATE … RETURN BEFORE` has no prior state; NONE is the honest empty answer.
  const createInner = ret === "none" || ret === "before" ? " RETURN NONE" : "";
  const updateInner =
    ret === "before" ? " RETURN BEFORE" : ret === "none" ? " RETURN NONE" : "";
  const steps = [
    `LET $__existing = (SELECT VALUE id FROM ${table} WHERE ${where} LIMIT 1);`,
    `IF array::len($__existing) = 0 THEN CREATE ${table} CONTENT ${payload(createEncoded, binds)}${createInner} ELSE UPDATE $__existing[0] ${encodedBody(mode, encodeData(meta, args.update, "update", operation), binds)}${updateInner} END;`,
  ];
  return {
    statements: steps,
    transactional: true,
    resultIndexes: [1],
    result: resultOf(ret, "row"),
  };
}

/** Compile `upsertMany` — ids → one `INSERT … ON DUPLICATE`; conflict field → per-row upserts. */
export function compileUpsertMany(
  meta: ModelMeta,
  args: UpsertManyRuntimeArgs,
  binds: Binds,
  operation = "upsertMany",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  const data = requireArray(args.data, "data", operation);
  const encoded = data.map((item) =>
    encodeData(meta, item, "create", operation),
  );
  const ids = encoded.map((item) =>
    isPlainObject(item) ? item.id : undefined,
  );
  const withIds = ids.filter((id) => id !== undefined).length;
  if (withIds > 0 && withIds !== encoded.length)
    throw compileError(
      "ValidationError",
      `${operation}: either EVERY item carries an id or none does (found ${withIds} of ${encoded.length}).`,
      { operation, table: meta.name },
    );
  const updateMap = explicitUpdateMap(meta, args.update, operation);

  if (withIds === encoded.length) {
    const assignments = updateMap
      ? assignmentList(updateMap, binds)
      : updatableFields(encoded)
          .map((field) => `${renderPath(field)} = $input.${renderPath(field)}`)
          .join(", ");
    if (!assignments)
      throw compileError(
        "ValidationError",
        `${operation}: no updatable fields — pass "update" explicitly or include fields in the payload.`,
        { operation, table: meta.name },
      );
    const sql = `INSERT INTO ${escapeIdent(meta.name)} ${payload(encoded, binds)} ON DUPLICATE KEY UPDATE ${assignments}${mutationTail(ret, undefined, operation)}`;
    return {
      statements: [sql],
      transactional: false,
      resultIndexes: [0],
      result: resultOf(ret, "many"),
    };
  }

  const conflict = args.conflict;
  if (typeof conflict !== "string" || !conflict)
    throw compileError(
      "ValidationError",
      `${operation}: items without an id need "conflict" (the unique field that resolves each row), e.g. conflict: "email".`,
      { operation, table: meta.name },
    );
  requireColumn(meta, conflict, operation);
  requireUniqueField(meta, conflict, operation);
  if (ret === "diff" && updateMap)
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF is not supported with an explicit "update" map (per-item LET/IF) — use "after"/"before"/"none".`,
      { operation, table: meta.name },
    );

  const table = escapeIdent(meta.name);
  const updatePayload = updateMap ? payload(updateMap, binds) : undefined;
  const statements: string[] = [];
  const resultIndexes: number[] = [];
  encoded.forEach((item, i) => {
    const itemBind = binds.add(item);
    const where = `${renderPath(conflict)} = ${itemBind}.${renderPath(conflict)}`;
    if (updatePayload === undefined) {
      statements.push(
        `UPSERT ${table} MERGE ${itemBind} WHERE ${where}${mutationTail(ret, undefined, operation)};`,
      );
    } else {
      // Expressions must read the existing row → LET/IF (`ON DUPLICATE` evaluates them on create).
      statements.push(
        `LET $__e${i} = (SELECT VALUE id FROM ${table} WHERE ${where} LIMIT 1);`,
        `IF array::len($__e${i}) = 0 THEN CREATE ${table} CONTENT ${itemBind}${ret === "none" || ret === "before" ? " RETURN NONE" : ""} ELSE UPDATE $__e${i}[0] MERGE ${updatePayload}${ret === "before" ? " RETURN BEFORE" : ret === "none" ? " RETURN NONE" : ""} END;`,
      );
    }
    resultIndexes.push(statements.length - 1);
  });
  return {
    statements,
    transactional: statements.length > 1,
    resultIndexes,
    result: resultOf(ret, "many"),
  };
}

/**
 * Validate `upsertMany.update` and encode it once: `undefined`/`"all"` → `undefined` (every
 * payload field updates), a map → its codec-validated merge payload.
 */
function explicitUpdateMap(
  meta: ModelMeta,
  update: unknown,
  operation: string,
): Record<string, unknown> | undefined {
  if (update === undefined || update === "all") return undefined;
  if (!isPlainObject(update))
    throw compileError(
      "ValidationError",
      `${operation}: "update" must be "all" or a map of fields (got ${describeValue(update)}).`,
      { operation, table: meta.name },
    );
  const encoded = encodeData(meta, update, "update", operation) as Record<
    string,
    unknown
  >;
  if (Object.keys(encoded).length === 0)
    throw compileError(
      "ValidationError",
      `${operation}: the "update" map is empty.`,
      { operation, table: meta.name },
    );
  return encoded;
}

// --- delete --------------------------------------------------------------------------------------

/** Compile `delete` — unique target; `RETURN BEFORE` (default) or `NONE`. */
export function compileDelete(
  meta: ModelMeta,
  args: DeleteRuntimeArgs,
  binds: Binds,
  operation = "delete",
): WritePlan {
  const ret = readReturn(args.return, operation, ["before", "none"], "before");
  const target = uniqueTarget(meta, args.where, operation);
  const sql =
    target.kind === "id"
      ? `DELETE ${recordTarget(meta, target.id, operation)}`
      : `DELETE FROM ${escapeIdent(meta.name)}${whereSql(args.where, binds, meta)}`;
  return {
    statements: [`${sql}${mutationTail(ret, args.timeout, operation)}`],
    transactional: false,
    resultIndexes: [0],
    result: ret === "none" ? "none" : "row",
    mayMiss: ret !== "none",
  };
}

/** Compile `deleteMany` — `where` or `all: true`; the count comes from `RETURN BEFORE`. */
export function compileDeleteMany(
  meta: ModelMeta,
  args: DeleteManyRuntimeArgs,
  binds: Binds,
  operation = "deleteMany",
): WritePlan {
  const ret = readReturn(args.return, operation, ["before", "none"], "before");
  const where = whereSql(args.where, binds, meta);
  if (!where && args.all !== true)
    throw compileError(
      "UnsafeMutation",
      `${operation}: no "where" deletes EVERY record of "${meta.name}". Confirm with all: true (or add a where).`,
      { operation, table: meta.name },
    );
  const sql = where
    ? `DELETE FROM ${escapeIdent(meta.name)}${where}`
    : `DELETE ${escapeIdent(meta.name)}`;
  return {
    statements: [`${sql}${mutationTail(ret, args.timeout, operation)}`],
    transactional: false,
    result: ret === "none" ? "none" : "many",
  };
}

// --- updateEach ----------------------------------------------------------------------------------

/**
 * Compile `updateEach` — one `UPDATE … WHERE by = $by` statement per item (ONE round-trip). The
 * `FOR` loop returns NO result on 3.2.x (live-probed), so per-item statements are what makes
 * `data`/`skipped` observable; they are wrapped in a transaction like every other batch.
 */
export function compileUpdateEach(
  meta: ModelMeta,
  args: UpdateEachRuntimeArgs,
  binds: Binds,
  operation = "updateEach",
): WritePlan {
  const ret = readReturn(args.return, operation, ["after", "none"], "after");
  if (
    args.onEmpty !== undefined &&
    args.onEmpty !== "return" &&
    args.onEmpty !== "throw"
  )
    throw compileError(
      "ValidationError",
      `${operation}: onEmpty must be "return" or "throw" (got ${describeValue(args.onEmpty)}).`,
      { operation, table: meta.name },
    );
  if (ret === "none" && args.onEmpty === "throw")
    throw compileError(
      "ValidationError",
      `${operation}: "onEmpty: throw" needs rows back — use return: "after" (RETURN NONE can't tell a miss from a match).`,
      { operation, table: meta.name },
    );
  const data = requireArray(args.data, "data", operation);
  const by =
    args.by === undefined ? "id" : requireString(args.by, "by", operation);
  requireColumn(meta, by, operation);
  const mode = updateMode(args.mode, operation, "merge");
  const rows = buildEachRows(meta, data, mode, args.patches, by, operation);
  const table = escapeIdent(meta.name);
  const tail = mutationTail(ret, args.timeout, operation);
  const statements = rows.map((row) => {
    const target = `${renderPath(by)} = ${binds.add(row.by)}`;
    const body =
      mode === "patch" ? patchOps(row.patches, operation) : (row.fields ?? {});
    return `UPDATE ${table} ${encodedBody(mode, body, binds)} WHERE ${target}${tail}`;
  });
  // `select` only shapes the decode — compile it HERE (with the plan) so a bad projection throws
  // at the call site, before the write runs.
  const select =
    args.select !== undefined
      ? compileProjection(meta, args.select, undefined, false, binds, operation)
          .spec
      : undefined;
  return {
    statements,
    transactional: statements.length > 1,
    result: resultOf(ret, "many"),
    ...(select ? { select } : {}),
  };
}

/** One `updateEach` item ready for lowering. */
interface EachRow {
  readonly by: unknown;
  readonly fields?: unknown;
  readonly patches?: readonly unknown[];
}

/** Build the per-item rows: the normalized `by` value + the encoded `fields` (or `patches`). */
function buildEachRows(
  meta: ModelMeta,
  data: readonly unknown[],
  mode: WriteMode,
  patches: unknown,
  by: string,
  operation: string,
): readonly EachRow[] {
  const seen = new Set<string>();
  const patchItems =
    mode === "patch"
      ? (requireArray(patches, "patches", operation) as readonly unknown[])
      : undefined;
  if (patchItems && patchItems.length !== data.length)
    throw compileError(
      "ValidationError",
      `${operation}: "patches" must have one entry per data item (${patchItems.length} vs ${data.length}).`,
      { operation, table: meta.name },
    );
  return data.map((item, i) => {
    if (!isPlainObject(item))
      throw compileError(
        "ValidationError",
        `${operation}: every data item must be an object, got ${describeValue(item)}.`,
        { operation, table: meta.name },
      );
    const byValue = item[by];
    if (byValue === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: item ${i} is missing the "by" field "${by}".`,
        { operation, table: meta.name, field: by },
      );
    const key = String(byValue);
    if (seen.has(key))
      throw compileError(
        "ValidationError",
        `${operation}: duplicate "${by}" value ${describeValue(byValue)} — each item must target a distinct row.`,
        { operation, table: meta.name, field: by },
      );
    seen.add(key);
    const fields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(item))
      if (field !== by) fields[field] = value;
    if (fields.id !== undefined)
      throw compileError(
        "ValidationError",
        `${operation}: "id" cannot be updated — use by: "id" to target the record.`,
        { operation, table: meta.name, field: "id" },
      );
    const normalizedBy = isRecordColumn(meta, by)
      ? toRecord(byValue, operation)
      : byValue;
    if (mode === "patch")
      return {
        by: normalizedBy,
        patches: patchOps(patchItems?.[i], operation),
      };
    return {
      by: normalizedBy,
      fields: encodeData(meta, fields, "update", operation),
    };
  });
}
