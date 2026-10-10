/**
 * The create/insert lowering — `create`/`createMany` (with the `relate` sugar and `skipDuplicates`
 * per-row `INSERT IGNORE`) and `insert`/`insertMany` (`onDuplicate: ignore | update | map`).
 * Mutations live in `./mutate`, edges in `./relate`, the shared primitives/arg shapes in
 * `./write-shared`.
 *
 * - VALUES bind (`$p0`, `$p1`, …); NAMES escape; a `data` field carrying a `surql` expression
 *   bypasses the codec and is spliced (the server enforces it); literal fields are validated.
 * - Batches (`createMany`) set `transactional: true` and roll back together on failure.
 */
import { escapeIdentSafe as escapeIdent } from "../../ident";
import type { ModelMeta } from "../meta";
import { relateStatement, relateSugar } from "./relate";
import {
  type Binds,
  compileError,
  describeValue,
  isPlainObject,
  renderPath,
  renderValue,
} from "./shared";
import {
  type CreateManyRuntimeArgs,
  type CreateRuntimeArgs,
  compileWriteProjection,
  createTarget,
  encodeData,
  type InsertRuntimeArgs,
  mutationTail,
  payload,
  readReturn,
  requireArray,
  resultOf,
  selectMode,
  updatableFields,
  type WritePlan,
  type WriteRet,
  withGeneratedId,
} from "./write-shared";

// --- create --------------------------------------------------------------------------------------

/** Compile `create` — `CREATE [ONLY] t[:id] CONTENT $p`, optional `relate` sugar in the same batch. */
export function compileCreate(
  meta: ModelMeta,
  args: CreateRuntimeArgs,
  binds: Binds,
  operation = "create",
  resolveEdge?: (name: string) => ModelMeta | undefined,
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  if (args.data === undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "data" is required — pass the record's fields (DB-filled ones optional).`,
      { operation, table: meta.name },
    );
  const encoded = encodeData(meta, args.data, "create", operation);
  const target = createTarget(meta, args.data, args.only === true, operation);
  const relate = relateSugar(args.relate, operation, meta, resolveEdge);
  const proj = compileWriteProjection(meta, args, binds, operation);
  assertCreateProjectable(proj, ret, operation, meta);

  if (relate.length === 0) {
    const sel = selectMode(proj, ret, operation, meta);
    return {
      statements: [
        `CREATE ${target} CONTENT ${payload(encoded, binds)}${mutationTail(ret, undefined, operation, sel?.mode === "server" ? sel.proj.text : undefined)}`,
      ],
      transactional: false,
      resultIndexes: [0],
      result: resultOf(ret, "row"),
      ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
    };
  }

  if (ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF is not supported with "relate" — the sugar runs several statements. Use after/before/none, or relate separately.`,
      { operation, table: meta.name },
    );
  // The sugar ends with `RETURN $__created` — the server can't project a bound value, so a
  // projection here is always client-applied.
  const sel = selectMode(proj, ret, operation, meta, { clientOnly: true });
  const statements = [
    `LET $__created = (CREATE ${createTarget(meta, args.data, true, operation)} CONTENT ${payload(encoded, binds)});`,
    ...relate.map((entry) => relateStatement(entry, binds, operation)),
    ret === "after" ? "RETURN $__created;" : "RETURN NONE;",
  ];
  return {
    statements,
    transactional: true,
    resultIndexes: [statements.length - 1],
    result: ret === "after" ? "row" : "none",
    ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
  };
}

/** `RETURN DIFF` has no rows to project. */
function assertCreateProjectable(
  proj: ReturnType<typeof compileWriteProjection>,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
): void {
  if (proj && ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF returns a JSON Patch list, not rows — drop select/omit, or use return: "after"/"before".`,
      { operation, table: meta.name },
    );
}

/** Compile `createMany` — N `CREATE`s (or one `FOR` with `skipDuplicates`) in ONE round-trip. */
export function compileCreateMany(
  meta: ModelMeta,
  args: CreateManyRuntimeArgs,
  binds: Binds,
  operation = "createMany",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  const proj = compileWriteProjection(meta, args, binds, operation);
  if (proj && ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF returns a JSON Patch list, not rows — drop select/omit, or use return: "after"/"before".`,
      { operation, table: meta.name },
    );
  const sel = selectMode(proj, ret, operation, meta);
  const data = requireArray(args.data, "data", operation);
  if (args.skipDuplicates === true)
    return compileSkipDuplicates(meta, data, ret, binds, operation, sel);
  const projText = sel?.mode === "server" ? sel.proj.text : undefined;

  const statements = data.map(
    (item) =>
      `CREATE ${createTarget(meta, item, false, operation)} CONTENT ${payload(encodeData(meta, item, "create", operation), binds)}${mutationTail(ret, undefined, operation, projText)}`,
  );
  return {
    statements,
    transactional: statements.length > 1,
    result: resultOf(ret, "many"),
    ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
  };
}

/** `skipDuplicates` — one `INSERT IGNORE` per row (returns only inserted rows). */
function compileSkipDuplicates(
  meta: ModelMeta,
  data: readonly unknown[],
  ret: WriteRet,
  binds: Binds,
  operation: string,
  sel: ReturnType<typeof selectMode>,
): WritePlan {
  const projText = sel?.mode === "server" ? sel.proj.text : undefined;
  const statements = data.map((item) =>
    insertStatement(meta, item, "ignore", ret, binds, operation, projText),
  );
  return {
    statements,
    transactional: statements.length > 1,
    result: resultOf(ret, "many"),
    ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
  };
}

// --- insert --------------------------------------------------------------------------------------

/** Compile `insert` — one payload row, ids preserved (`INSERT [IGNORE] … [ON DUPLICATE]`). */
export function compileInsert(
  meta: ModelMeta,
  args: InsertRuntimeArgs,
  binds: Binds,
  operation = "insert",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  if (Array.isArray(args.data))
    throw compileError(
      "ValidationError",
      `${operation}: "data" is a single object — use insertMany for arrays (same statement, batch envelope).`,
      { operation, table: meta.name },
    );
  if (args.data === undefined)
    throw compileError("ValidationError", `${operation}: "data" is required.`, {
      operation,
      table: meta.name,
    });
  const proj = compileWriteProjection(meta, args, binds, operation);
  assertInsertProjectable(proj, ret, operation, meta);
  const sel = selectMode(proj, ret, operation, meta);
  return {
    statements: [
      insertStatement(
        meta,
        args.data,
        args.onDuplicate,
        ret,
        binds,
        operation,
        sel?.mode === "server" ? sel.proj.text : undefined,
      ),
    ],
    transactional: false,
    resultIndexes: [0],
    result: resultOf(ret, "row"),
    ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
  };
}

/** Compile `insertMany` — one `INSERT` with the array payload. */
export function compileInsertMany(
  meta: ModelMeta,
  args: InsertRuntimeArgs,
  binds: Binds,
  operation = "insertMany",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  if (args.data !== undefined && !Array.isArray(args.data))
    throw compileError(
      "ValidationError",
      `${operation}: "data" must be an array — use insert for a single object.`,
      { operation, table: meta.name },
    );
  const data = requireArray(args.data, "data", operation);
  const proj = compileWriteProjection(meta, args, binds, operation);
  assertInsertProjectable(proj, ret, operation, meta);
  const sel = selectMode(proj, ret, operation, meta);
  return {
    statements: [
      insertStatement(
        meta,
        data,
        args.onDuplicate,
        ret,
        binds,
        operation,
        sel?.mode === "server" ? sel.proj.text : undefined,
      ),
    ],
    transactional: false,
    result: resultOf(ret, "many"),
    ...(sel ? { select: sel.proj.spec, selectMode: sel.mode } : {}),
  };
}

/** `INSERT` RETURN DIFF is a paged/nested diff — projecting it makes no sense. */
function assertInsertProjectable(
  proj: ReturnType<typeof compileWriteProjection>,
  ret: WriteRet,
  operation: string,
  meta: ModelMeta,
): void {
  if (proj && ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF returns a JSON Patch list, not rows — drop select/omit, or use return: "after"/"before".`,
      { operation, table: meta.name },
    );
}

/** `INSERT [IGNORE] INTO t $p [ON DUPLICATE KEY UPDATE …] [RETURN …]`. */
function insertStatement(
  meta: ModelMeta,
  data: unknown,
  onDuplicate: unknown,
  ret: WriteRet,
  binds: Binds,
  operation: string,
  projText?: string,
): string {
  const table = escapeIdent(meta.name);
  const encoded = Array.isArray(data)
    ? data.map((item) =>
        withGeneratedId(meta, encodeData(meta, item, "create", operation)),
      )
    : withGeneratedId(meta, encodeData(meta, data, "create", operation));
  const payloadText = payload(encoded, binds);
  let sql = `INSERT INTO ${table} ${payloadText}`;

  if (onDuplicate === "ignore")
    sql = `INSERT IGNORE INTO ${table} ${payloadText}`;
  else if (onDuplicate === "update") {
    const fields = updatableFields(encoded);
    if (fields.length === 0)
      throw compileError(
        "ValidationError",
        `${operation}: onDuplicate "update" needs at least one updatable field in the payload (id/in/out are never updated).`,
        { operation, table: meta.name },
      );
    sql += ` ON DUPLICATE KEY UPDATE ${fields
      .map((field) => `${renderPath(field)} = $input.${renderPath(field)}`)
      .join(", ")}`;
  } else if (isPlainObject(onDuplicate)) {
    const entries = Object.entries(onDuplicate).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0)
      throw compileError(
        "ValidationError",
        `${operation}: the onDuplicate map is empty — pass "ignore", "update" or the fields to set.`,
        { operation, table: meta.name },
      );
    sql += ` ON DUPLICATE KEY UPDATE ${entries
      .map(
        ([field, value]) =>
          `${renderPath(field)} = ${renderValue(value, binds, binds.ctx())}`,
      )
      .join(", ")}`;
  } else if (onDuplicate !== undefined)
    throw compileError(
      "ValidationError",
      `${operation}: onDuplicate must be "ignore", "update" or a map of expressions, got ${describeValue(onDuplicate)}.`,
      { operation, table: meta.name },
    );

  return `${sql}${mutationTail(ret, undefined, operation, projText)}`;
}
