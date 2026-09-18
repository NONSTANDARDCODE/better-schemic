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
import { escapeIdent } from "surrealdb";
import type { ModelMeta } from "../meta";
import { relateStatement, relateSugar } from "./relate";
import {
  type Binds,
  compileError,
  describeValue,
  isPlainObject,
  isTableMeta,
  renderPath,
  renderValue,
} from "./shared";
import {
  type CreateManyRuntimeArgs,
  type CreateRuntimeArgs,
  encodeData,
  type InsertRuntimeArgs,
  mutationTail,
  payload,
  readReturn,
  recordTarget,
  requireArray,
  resultOf,
  updatableFields,
  type WritePlan,
  type WriteRet,
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

  if (relate.length === 0)
    return {
      statements: [
        `CREATE ${target} CONTENT ${payload(encoded, binds)}${mutationTail(ret, undefined, operation)}`,
      ],
      transactional: false,
      resultIndexes: [0],
      result: resultOf(ret, "row"),
    };

  if (ret === "diff")
    throw compileError(
      "ReturnNotSupported",
      `${operation}: RETURN DIFF is not supported with "relate" — the sugar runs several statements. Use after/before/none, or relate separately.`,
      { operation, table: meta.name },
    );
  const statements = [
    `LET $__created = (CREATE ONLY ${escapeIdent(meta.name)} CONTENT ${payload(encoded, binds)});`,
    ...relate.map((entry) => relateStatement(entry, binds, operation)),
    ret === "after" ? "RETURN $__created;" : "RETURN NONE;",
  ];
  return {
    statements,
    transactional: true,
    resultIndexes: [statements.length - 1],
    result: ret === "after" ? "row" : "none",
  };
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
  const data = requireArray(args.data, "data", operation);
  if (args.skipDuplicates === true)
    return compileSkipDuplicates(meta, data, ret, binds, operation);

  const statements = data.map(
    (item) =>
      `CREATE ${createTarget(meta, item, false, operation)} CONTENT ${payload(encodeData(meta, item, "create", operation), binds)}${mutationTail(ret, undefined, operation)}`,
  );
  return {
    statements,
    transactional: statements.length > 1,
    result: resultOf(ret, "many"),
  };
}

/** `skipDuplicates` — one `INSERT IGNORE` per row (returns only inserted rows). */
function compileSkipDuplicates(
  meta: ModelMeta,
  data: readonly unknown[],
  ret: WriteRet,
  binds: Binds,
  operation: string,
): WritePlan {
  data.forEach((item, i) => {
    if (!isPlainObject(item) || item.id === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: "skipDuplicates" needs an explicit "id" on every item (item ${i} has none) — id-less rows can't conflict; use insertMany({ onDuplicate: "ignore" }).`,
        { operation, table: meta.name },
      );
  });
  const statements = data.map((item) =>
    insertStatement(meta, item, "ignore", ret, binds, operation),
  );
  return {
    statements,
    transactional: statements.length > 1,
    result: resultOf(ret, "many"),
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
  return {
    statements: [
      insertStatement(meta, args.data, args.onDuplicate, ret, binds, operation),
    ],
    transactional: false,
    resultIndexes: [0],
    result: resultOf(ret, "row"),
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
  return {
    statements: [
      insertStatement(meta, data, args.onDuplicate, ret, binds, operation),
    ],
    transactional: false,
    result: resultOf(ret, "many"),
  };
}

/** `INSERT [IGNORE] INTO t $p [ON DUPLICATE KEY UPDATE …] [RETURN …]`. */
function insertStatement(
  meta: ModelMeta,
  data: unknown,
  onDuplicate: unknown,
  ret: WriteRet,
  binds: Binds,
  operation: string,
): string {
  const table = escapeIdent(meta.name);
  const encoded = Array.isArray(data)
    ? data.map((item) => encodeData(meta, item, "create", operation))
    : encodeData(meta, data, "create", operation);
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

  return `${sql}${mutationTail(ret, undefined, operation)}`;
}

/** `ONLY t:id` / `t:id` / `t` / `t:<singleton>` target for CREATE. */
function createTarget(
  meta: ModelMeta,
  data: unknown,
  only: boolean,
  operation: string,
): string {
  const id = createId(meta, data);
  const target =
    id !== undefined
      ? recordTarget(meta, id, operation)
      : escapeIdent(meta.name);
  return `${only ? "ONLY " : ""}${target}`;
}

/** The explicit `id` of a payload, or a singleton delegate's fixed id. */
function createId(meta: ModelMeta, data: unknown): unknown {
  if (isPlainObject(data) && data.id !== undefined) return data.id;
  const singleton = isTableMeta(meta) ? meta.singletonId : undefined;
  if (singleton !== undefined) return `${meta.name}:${singleton}`;
  return undefined;
}
