/**
 * The mutation lowering — `update`/`updateMany`/`patch`/`upsert`/`upsertMany`/`delete`/
 * `deleteMany`/`updateEach`. Singular targets resolve `where` (a record id or a single-field
 * UNIQUE index) or an inferred `data.id`; `update`/`patch`/`delete` never create, while `upsert`
 * creates when a target is absent and creates outright when there is none. Batches set
 * `transactional: true` for atomicity.
 */
import { RecordId } from "surrealdb";
import { escapeIdentSafe as escapeIdent } from "../../ident";
import { hasRefDeep } from "../../pure";
import type { ModelMeta, SchemaIndex } from "../meta";
import { compileProjection } from "./projection";
import {
  type Binds,
  compileError,
  describeValue,
  isPlainObject,
  renderPath,
} from "./shared";
import { requireUniqueField, type UniqueTarget, uniqueTarget } from "./unique";
import { mergeScope, scopePredicate, scopeWhere } from "./where";
import {
  assignmentList,
  createId,
  createTarget,
  type DeleteManyRuntimeArgs,
  type DeleteRuntimeArgs,
  deltaTail,
  encodeData,
  encodedBody,
  generatedTarget,
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
  type UpsertDeltaRuntimeArgs,
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
  options: { readonly index?: SchemaIndex } = {},
): WritePlan {
  const { target, where } = singleTarget(
    meta,
    args,
    binds,
    operation,
    options.index,
  );
  return compileMutation(meta, target, where, args, binds, operation, "row");
}

/** Compile `updateMany` — every matching row (`where` optional; `rules` guards land in M6). */
export function compileUpdateMany(
  meta: ModelMeta,
  args: UpdateManyRuntimeArgs,
  binds: Binds,
  operation = "updateMany",
  options: { readonly index?: SchemaIndex } = {},
): WritePlan {
  const where = whereSql(
    mergeScope(args.where, args.scope),
    binds,
    meta,
    options.index,
  );
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
  options: { readonly index?: SchemaIndex } = {},
): WritePlan {
  const { target, where } = singleTarget(
    meta,
    args,
    binds,
    operation,
    options.index,
  );
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

/** Compile `upsert` — by default a STRICT update by id, a single-field UNIQUE index or an inferred
 *  `data.id`: a target that does not exist (or is filtered out by a permission/plugin scope)
 *  rejects `ResultNotFound` instead of silently creating or resolving `null`. `onMissing: "create"`
 *  restores the create-or-update lowering. With NO target at all (`where` omitted and no `data.id`)
 *  the call is a plain `CREATE` (mirroring `create()`); only an explicit `onMissing: "throw"`
 *  forbids that. */
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
  const explicit = readOnMissing(args.onMissing, operation);
  const onMissing = explicit ?? "throw";
  const hasData = args.data !== undefined;
  const hasCreate = args.create !== undefined;
  const hasUpdate = args.update !== undefined;
  // Resolve the payload shape ONCE (like `upsertDelta`): `anyBranch` gates "which payload" guards.
  const anyBranch = hasCreate || hasUpdate;
  if (!hasData && !(hasCreate && hasUpdate))
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" (one payload for both branches) OR "create" + "update".`,
      { operation, table: meta.name },
    );
  if (hasData && anyBranch)
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" OR "create" + "update" — not both.`,
      { operation, table: meta.name },
    );
  if (onMissing === "throw" && anyBranch)
    throw compileError(
      "ValidationError",
      `${operation}: onMissing "throw" (the default) is a strict UPDATE — it never creates; pass "data" (applied by the update) or onMissing: "create" to allow the create branch.`,
      { operation, table: meta.name },
    );

  const mode = updateMode(args.mode, operation, "merge");
  if (mode === "patch")
    throw compileError(
      "ValidationError",
      `${operation}: mode "patch" is not part of upsert — use patch() or update({ mode: "patch" }).`,
      { operation, table: meta.name },
    );
  const target = resolveUpsertTarget(meta, args, operation);

  if (target === undefined) {
    assertTargetlessCreate(meta, operation, {
      explicit,
      anyBranch,
      mode: args.mode,
    });
    const encoded = encodeData(meta, args.data, "create", operation);
    return {
      statements: [
        `CREATE ${createTarget(meta, args.data, args.only === true, operation)} CONTENT ${payload(encoded, binds)}${mutationTail(ret, args.timeout, operation)}`,
      ],
      transactional: false,
      resultIndexes: [0],
      result: resultOf(ret, "row"),
      ...(ret === "after" ? { missError: true } : {}),
    };
  }

  if (onMissing === "throw")
    return compileStrictUpsert(meta, target, args, mode, ret, binds, operation);

  // A create-mode `return: "after"` promises a row (`WrittenResult` = `Promise<App>`): when the
  // write produced NONE (the target was filtered out by a permission/plugin scope) the decode
  // raises `ResultNotFound` instead of resolving the contract-breaking `null`.
  const missError: Pick<WritePlan, "missError"> =
    ret === "after" ? { missError: true } : {};
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
      if (target.kind === "id") {
        const body = encodedBody(mode, encoded, binds);
        return {
          statements: [
            `UPSERT ${only}${recordTarget(meta, target.id, operation)} ${body}${scopeWhere(args.scope, binds, meta)}${mutationTail(ret, args.timeout, operation)}`,
          ],
          transactional: false,
          resultIndexes: [0],
          result: resultOf(ret, "row"),
          ...missError,
        };
      }
      // Unique-field target, no expressions. A payload `id` wins (the plain-table form carries it
      // in the payload), so only an id-less payload switches to the generated target: injecting the
      // generated expression into a MERGE against an existing record is a server error (`Found … for
      // the id field, but a specific record has been specified` — live-probed 3.2; a matching id is
      // accepted). The subquery resolves the existing record by the unique field, `??` falls back to
      // `type::record(<table>, <fn>())` on a miss. One statement, so `RETURN DIFF` stays supported.
      // `encodeData` above already rejected non-object data — while `createId` handles both.
      const generated =
        createId(meta, args.data) === undefined
          ? generatedTarget(meta)
          : undefined;
      if (generated !== undefined) {
        const where = upsertWhere(meta, target, binds, args.scope);
        const body = encodedBody(mode, encoded, binds);
        return {
          statements: [
            `UPSERT ${only}((SELECT VALUE id FROM ${escapeIdent(meta.name)} WHERE ${where} LIMIT 1)[0] ?? ${generated}) ${body}${mutationTail(ret, args.timeout, operation)}`,
          ],
          transactional: false,
          resultIndexes: [0],
          result: resultOf(ret, "row"),
          ...missError,
        };
      }
      const body = encodedBody(mode, encoded, binds);
      return {
        statements: [
          `UPSERT ${only}${escapeIdent(meta.name)} ${body} WHERE ${upsertWhere(meta, target, binds, args.scope)}${mutationTail(ret, args.timeout, operation)}`,
        ],
        transactional: false,
        resultIndexes: [0],
        result: resultOf(ret, "row"),
        ...missError,
      };
    }
    // Expressions can reference the existing row — `UPSERT … WHERE` would evaluate them on the
    // (empty) create branch too, so the LET/IF form distinguishes the branches first.
    return {
      ...compileUpsertIfElse(
        meta,
        upsertWhere(meta, target, binds, args.scope),
        { ...args, create: args.data, update: args.data },
        mode,
        ret,
        binds,
        operation,
      ),
      ...missError,
    };
  }

  return compileUpsertBranches(meta, target, args, mode, ret, binds, operation);
}

/**
 * The strict (`onMissing: "throw"`, the default) upsert lowering: a pure UPDATE by id/unique —
 * never creates. A miss returns no row and the runtime raises `ResultNotFound`. `return: "none"`
 * still compiles the row-returning form (the miss must stay observable) and the decode discards
 * the row; `return: "diff"` is rejected because an empty diff cannot tell "no match" from
 * "no change". `strictMiss` tells the decode this is a STRICT miss (the "it never creates"
 * teaching message), as opposed to a create branch filtered by a permission/plugin scope.
 */
function compileStrictUpsert(
  meta: ModelMeta,
  target: ReturnType<typeof uniqueTarget>,
  args: UpsertRuntimeArgs,
  mode: WriteMode,
  ret: WriteRet,
  binds: Binds,
  operation: string,
): WritePlan {
  if (ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF is not supported on a strict upsert (an empty diff can't tell "no match" from "no change") — use "after"/"before", or onMissing: "create".`,
      { operation, table: meta.name },
    );
  const encoded = encodeData(
    meta,
    args.data,
    mode === "content" || mode === "replace" ? "create" : "update",
    operation,
  );
  const body = encodedBody(mode, encoded, binds);
  const tail = mutationTail(
    ret === "none" ? "after" : ret,
    args.timeout,
    operation,
  );
  const sql =
    target.kind === "id"
      ? `UPDATE ONLY ${recordTarget(meta, target.id, operation)} ${body}${scopeWhere(args.scope, binds, meta)}${tail}`
      : `UPDATE ${escapeIdent(meta.name)} ${body} WHERE ${upsertWhere(meta, target, binds, args.scope)}${tail}`;
  return {
    statements: [sql],
    transactional: false,
    resultIndexes: [0],
    result: resultOf(ret, "row"),
    missError: true,
    strictMiss: true,
  };
}

/** The LET/IF `WHERE` for a resolved unique target (`id = $record` / `uniq = $value`), ANDed with
 *  the plugin `scope` (see `Operation.scope`) when present. */
function upsertWhere(
  meta: ModelMeta,
  target: ReturnType<typeof uniqueTarget>,
  binds: Binds,
  scope?: unknown,
): string {
  const base =
    target.kind === "id"
      ? `id = ${binds.add(new RecordId(meta.name, target.id))}`
      : `${renderPath(target.field)} = ${binds.add(target.value)}`;
  const scoped = scopePredicate(scope, binds, meta);
  return scoped ? `${base} AND ${scoped}` : base;
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
    if (args.scope !== undefined)
      throw compileError(
        "UnsupportedCapability",
        `${operation}: a plugin scope can't be applied to the INSERT … ON DUPLICATE KEY UPDATE path — pass "data" (a single payload) instead of "create" + "update", or use $withoutPlugins().`,
        { operation, table: meta.name },
      );
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
      ...(ret === "after" ? { missError: true } : {}),
    };
  }
  return compileUpsertIfElse(
    meta,
    upsertWhere(meta, target, binds, args.scope),
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
  // `CREATE … RETURN BEFORE` has no prior state; NONE is the honest empty answer.
  const plan = compileIfElse(
    meta,
    where,
    args.create,
    args.update,
    mode,
    binds,
    operation,
    ret === "none" || ret === "before" ? " RETURN NONE" : "",
    ret === "before" ? " RETURN BEFORE" : ret === "none" ? " RETURN NONE" : "",
    resultOf(ret, "row"),
  );
  return ret === "after" ? { ...plan, missError: true } : plan;
}

/**
 * The LET/IF lowering shared by `upsert` (RETURN tails from `ret`) and `upsertDelta` (the
 * `{ before, after }` envelope + TIMEOUT on EACH branch — the only form that carries `$before`/
 * `$after` while branching; live-probed 3.2). `result` is whatever the caller's decode expects.
 */
function compileIfElse(
  meta: ModelMeta,
  where: string,
  create: unknown,
  update: unknown,
  mode: WriteMode,
  binds: Binds,
  operation: string,
  createTail: string,
  updateTail: string,
  result: WritePlan["result"],
): WritePlan {
  const table = escapeIdent(meta.name);
  const createEncoded = encodeData(meta, create, "create", operation);
  const steps = [
    `LET $__existing = (SELECT VALUE id FROM ${table} WHERE ${where} LIMIT 1);`,
    `IF array::len($__existing) = 0 THEN CREATE ${createTarget(meta, create, false, operation)} CONTENT ${payload(createEncoded, binds)}${createTail} ELSE UPDATE $__existing[0] ${encodedBody(mode, encodeData(meta, update, "update", operation), binds)}${updateTail} END;`,
  ];
  return {
    statements: steps,
    transactional: true,
    resultIndexes: [1],
    result,
  };
}

// --- upsertDelta ---------------------------------------------------------------------------------

/**
 * Compile `upsertDelta` — by default a STRICT update with `onMissing: "throw"` (a targeted miss
 * rejects `ResultNotFound`; a target-less call is still a plain create); `onMissing: "create"`
 * restores create-or-update. Returns the `{ before, after }` envelope from the SAME statement
 * that wrote. Every lowering is the `upsert` equivalent with the envelope tail; the LET/IF form
 * carries it (plus TIMEOUT) on EACH branch — the one form the server lets carry `$before`/`$after`
 * while branching.
 */
export function compileUpsertDelta(
  meta: ModelMeta,
  args: UpsertDeltaRuntimeArgs,
  binds: Binds,
  operation = "upsertDelta",
): WritePlan {
  const explicit = readOnMissing(args.onMissing, operation);
  const onMissing = explicit ?? "throw";
  const hasData = args.data !== undefined;
  const hasCreate = args.create !== undefined;
  const hasUpdate = args.update !== undefined;
  // Resolve the payload shape ONCE: `both` gates the distinct-branch form, `anyBranch` the
  // "which payload" guards. Keeping them as named booleans avoids unreachable short-circuit arms.
  const both = hasCreate && hasUpdate;
  const anyBranch = hasCreate || hasUpdate;
  if (!hasData && !both)
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" (one payload for both branches) OR "create" + "update".`,
      { operation, table: meta.name },
    );
  if (hasData && anyBranch)
    throw compileError(
      "ValidationError",
      `${operation}: pass "data" OR "create" + "update" — not both.`,
      { operation, table: meta.name },
    );
  if (onMissing === "throw" && anyBranch)
    throw compileError(
      "ValidationError",
      `${operation}: onMissing "throw" (the default) is a strict UPDATE — it never creates, so pass "data" (applied by the update) or onMissing: "create" for distinct "create"/"update" branches.`,
      { operation, table: meta.name },
    );
  const mode = updateMode(args.mode, operation, "merge");
  if (mode === "patch")
    throw compileError(
      "ValidationError",
      `${operation}: mode "patch" is not part of upsertDelta — use patch() or update({ mode: "patch" }).`,
      { operation, table: meta.name },
    );
  const target = resolveUpsertTarget(meta, args, operation);
  const tail = deltaTail(args.timeout, operation);

  if (target === undefined) {
    assertTargetlessCreate(meta, operation, {
      explicit,
      anyBranch,
      mode: args.mode,
    });
    const encoded = encodeData(meta, args.data, "create", operation);
    return {
      statements: [
        `CREATE ${createTarget(meta, args.data, false, operation)} CONTENT ${payload(encoded, binds)}${tail}`,
      ],
      transactional: false,
      resultIndexes: [0],
      result: "delta",
    };
  }

  if (onMissing === "throw") {
    // Strict update: never a create branch. `UPDATE ONLY t:id` misses as NONE; the unique-field
    // form misses as [] — the runtime treats "no envelope" as the miss either way. `strictMiss`
    // keeps the "it never creates" message honest for that miss.
    const encoded = encodeData(
      meta,
      args.data,
      mode === "content" || mode === "replace" ? "create" : "update",
      operation,
    );
    const body = encodedBody(mode, encoded, binds);
    if (target.kind === "id")
      return {
        statements: [
          `UPDATE ONLY ${recordTarget(meta, target.id, operation)} ${body}${scopeWhere(args.scope, binds, meta)}${tail}`,
        ],
        transactional: false,
        resultIndexes: [0],
        result: "delta",
        mayMiss: true,
        strictMiss: true,
      };
    return {
      statements: [
        `UPDATE ${escapeIdent(meta.name)} ${body} WHERE ${upsertWhere(meta, target, binds, args.scope)}${tail}`,
      ],
      transactional: false,
      resultIndexes: [0],
      result: "delta",
      mayMiss: true,
      strictMiss: true,
    };
  }

  if (hasData) {
    const encoded = encodeData(
      meta,
      args.data,
      mode === "content" || mode === "replace" ? "create" : "update",
      operation,
    );
    const hasExpressions = Object.values(
      encoded as Record<string, unknown>,
    ).some(hasRefDeep);
    if (!hasExpressions) {
      if (target.kind === "id") {
        const body = encodedBody(mode, encoded, binds);
        return {
          statements: [
            `UPSERT ${recordTarget(meta, target.id, operation)} ${body}${scopeWhere(args.scope, binds, meta)}${tail}`,
          ],
          transactional: false,
          resultIndexes: [0],
          result: "delta",
        };
      }
      // Unique-field target, no expressions: a payload `id` wins (the plain-table form carries it
      // in the payload), so only an id-less payload switches to the generated target — the subquery
      // resolves the existing record, `??` falls back to `type::record(<table>, <fn>())` on a miss.
      const generated =
        createId(meta, args.data) === undefined
          ? generatedTarget(meta)
          : undefined;
      if (generated !== undefined) {
        const where = upsertWhere(meta, target, binds, args.scope);
        const body = encodedBody(mode, encoded, binds);
        return {
          statements: [
            `UPSERT ((SELECT VALUE id FROM ${escapeIdent(meta.name)} WHERE ${where} LIMIT 1)[0] ?? ${generated}) ${body}${tail}`,
          ],
          transactional: false,
          resultIndexes: [0],
          result: "delta",
        };
      }
      const body = encodedBody(mode, encoded, binds);
      return {
        statements: [
          `UPSERT ${escapeIdent(meta.name)} ${body} WHERE ${upsertWhere(meta, target, binds, args.scope)}${tail}`,
        ],
        transactional: false,
        resultIndexes: [0],
        result: "delta",
      };
    }
    // Expressions can reference the existing row — branch first, then write (envelope per branch).
    return compileIfElse(
      meta,
      upsertWhere(meta, target, binds, args.scope),
      args.data,
      args.data,
      mode,
      binds,
      operation,
      tail,
      tail,
      "delta",
    );
  }

  // Distinct `create` + `update` payloads: always the LET/IF form (per-branch envelope + TIMEOUT,
  // scope support), never `INSERT … ON DUPLICATE` — see `docs/orm-syntax-map.md` §2.3/2.4.
  assertDeltaCreateId(meta, target, args.create, operation);
  return compileIfElse(
    meta,
    upsertWhere(meta, target, binds, args.scope),
    args.create,
    args.update,
    mode,
    binds,
    operation,
    tail,
    tail,
    "delta",
  );
}

/** Validate `onMissing`; `undefined` passes through — each caller applies its own default
 *  (`upsert`/`upsertDelta` are STRICT on a targeted call; a target-less call is a plain create,
 *  which only an explicit `"throw"` forbids). */
function readOnMissing(
  value: unknown,
  operation: string,
): "create" | "throw" | undefined {
  if (value === undefined) return undefined;
  if (value !== "create" && value !== "throw")
    throw compileError(
      "ValidationError",
      `${operation}: onMissing must be "create" or "throw" (got ${describeValue(value)}).`,
      { operation },
    );
  return value;
}

/**
 * The target shared by `upsert` and `upsertDelta`: an explicit `where` wins; otherwise a
 * single-payload `data.id` infers an id target; neither means a plain create. A `where.id` that
 * disagrees with `data.id` is rejected (they name the same record).
 */
function resolveUpsertTarget(
  meta: ModelMeta,
  args: { where?: unknown; data?: unknown },
  operation: string,
): UniqueTarget | undefined {
  if (args.where !== undefined) {
    const target = uniqueTarget(meta, args.where, operation);
    if (
      target.kind === "id" &&
      isPlainObject(args.data) &&
      args.data.id !== undefined &&
      recordIdText(args.data.id) !== target.id
    )
      throw compileError(
        "ValidationError",
        `${operation}: "data.id" (${String(args.data.id)}) must match where.id (${String((args.where as { id?: unknown }).id)}) — they name the same record.`,
        { operation, table: meta.name, field: "id" },
      );
    return target;
  }
  if (isPlainObject(args.data) && args.data.id !== undefined)
    return uniqueTarget(meta, { id: args.data.id }, operation);
  return undefined;
}

/**
 * The guards a TARGET-LESS upsert shares (`upsert` and `upsertDelta`): with no `where` and no
 * inferable `data.id` the call is a plain create, so an explicit `"throw"`, distinct payload
 * branches or a `mode` have no branch to act on. Same wording in both ops so the teaching text
 * never drifts.
 */
function assertTargetlessCreate(
  meta: ModelMeta,
  operation: string,
  args: {
    readonly explicit: "create" | "throw" | undefined;
    readonly anyBranch: boolean;
    readonly mode: unknown;
  },
): void {
  if (args.explicit === "throw")
    throw compileError(
      "ValidationError",
      `${operation}: onMissing "throw" needs a target — pass "where" (or let "data.id" infer it).`,
      { operation, table: meta.name },
    );
  if (args.anyBranch)
    throw compileError(
      "ValidationError",
      `${operation}: distinct "create"/"update" payloads need a target — pass "where" (or "data" with an "id").`,
      { operation, table: meta.name },
    );
  if (args.mode !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "mode" only applies to the update branch — a target-less call is a plain create.`,
      { operation, table: meta.name },
    );
}

/** Validate the distinct `create` branch against an id target (parity with `upsert`). */
function assertDeltaCreateId(
  meta: ModelMeta,
  target: UniqueTarget,
  create: unknown,
  operation: string,
): void {
  if (target.kind !== "id") return;
  const createId = isPlainObject(create) ? create.id : undefined;
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
    if (args.scope !== undefined)
      throw compileError(
        "UnsupportedCapability",
        `${operation}: a plugin scope can't be applied to the all-ids INSERT … ON DUPLICATE KEY UPDATE path — provide rows without ids plus "conflict", or use $withoutPlugins().`,
        { operation, table: meta.name },
      );
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
  // Reaching this path means NO item carries an id (`withIds` is 0, else the all-ids form ran or
  // the mixed guard threw), so the generated target is the same for every item.
  const generated = generatedTarget(meta);
  const scope = scopePredicate(args.scope, binds, meta);
  const statements: string[] = [];
  const resultIndexes: number[] = [];
  encoded.forEach((item, i) => {
    const itemBind = binds.add(item);
    const baseWhere = `${renderPath(conflict)} = ${itemBind}.${renderPath(conflict)}`;
    const where = scope ? `${baseWhere} AND ${scope}` : baseWhere;
    if (updatePayload === undefined) {
      statements.push(
        generated !== undefined
          ? `UPSERT ((SELECT VALUE id FROM ${table} WHERE ${where} LIMIT 1)[0] ?? ${generated}) MERGE ${itemBind}${mutationTail(ret, undefined, operation)};`
          : `UPSERT ${table} MERGE ${itemBind} WHERE ${where}${mutationTail(ret, undefined, operation)};`,
      );
    } else {
      // Expressions must read the existing row → LET/IF (`ON DUPLICATE` evaluates them on create).
      statements.push(
        `LET $__e${i} = (SELECT VALUE id FROM ${table} WHERE ${where} LIMIT 1);`,
        `IF array::len($__e${i}) = 0 THEN CREATE ${createTarget(meta, item, false, operation)} CONTENT ${itemBind}${ret === "none" || ret === "before" ? " RETURN NONE" : ""} ELSE UPDATE $__e${i}[0] MERGE ${updatePayload}${ret === "before" ? " RETURN BEFORE" : ret === "none" ? " RETURN NONE" : ""} END;`,
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
  options: { readonly index?: SchemaIndex } = {},
): WritePlan {
  const ret = readReturn(args.return, operation, ["before", "none"], "before");
  const target = uniqueTarget(meta, args.where, operation);
  const sql =
    target.kind === "id"
      ? `DELETE ${recordTarget(meta, target.id, operation)}${scopeWhere(args.scope, binds, meta, options.index)}`
      : `DELETE FROM ${escapeIdent(meta.name)}${whereSql(mergeScope(args.where, args.scope), binds, meta, options.index)}`;
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
  options: { readonly index?: SchemaIndex } = {},
): WritePlan {
  const ret = readReturn(args.return, operation, ["before", "none"], "before");
  const where = whereSql(
    mergeScope(args.where, args.scope),
    binds,
    meta,
    options.index,
  );
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
  const scope = scopePredicate(args.scope, binds, meta);
  const statements = rows.map((row) => {
    const target = `${renderPath(by)} = ${binds.add(row.by)}${scope ? ` AND ${scope}` : ""}`;
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
