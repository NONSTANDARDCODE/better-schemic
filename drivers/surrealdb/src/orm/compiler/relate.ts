/**
 * The RELATE lowering — `relate`/`relateMany`/`unrelate`/`unrelateMany` for edge delegates,
 * plus the `create.relate` sugar statement builder. Endpoints are record ids/expressions
 * validated against the relation's declared FROM/TO tables; edge data is codec-validated with
 * expression splice (`SET f = $p` per field).
 */
import { escapeIdent } from "surrealdb";
import { hasRefDeep } from "../../pure";
import type { ModelMeta } from "../meta";
import {
  type Binds,
  compileError,
  describeValue,
  escapeRecordIdPart,
  isPlainObject,
  isTableMeta,
  renderValue,
  splitRecordId,
} from "./shared";
import {
  type DeleteManyRuntimeArgs,
  encodeData,
  mutationTail,
  readReturn,
  requireArray,
  resultOf,
  setAssignments,
  type WritePlan,
  type WriteRet,
  whereSql,
} from "./write-shared";

// --- relate / unrelate ---------------------------------------------------------------------------

export interface RelateRuntimeArgs {
  from?: unknown;
  to?: unknown;
  id?: unknown;
  data?: unknown;
  return?: unknown;
  timeout?: unknown;
  meta?: unknown;
}

/** One compiled RELATE clause (shared by `relate` and `create.relate` sugar). */
export interface RelateEntry {
  readonly from: unknown;
  readonly edge: string;
  readonly to: unknown;
  readonly data?: unknown;
  readonly ret: WriteRet;
  /** The edge's metadata when resolvable (codec-validates `data`, checks endpoints). */
  readonly meta?: ModelMeta;
}

/** Compile `relate` — `RELATE from->edge[:id]->to [SET …] [RETURN …]`. */
export function compileRelate(
  meta: ModelMeta,
  args: RelateRuntimeArgs,
  binds: Binds,
  operation = "relate",
): WritePlan {
  const ret = readReturn(
    args.return,
    operation,
    ["after", "before", "diff", "none"],
    "after",
  );
  requireRelation(meta, operation);
  if (args.from === undefined || args.to === undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "from" and "to" are required endpoints (record ids or expressions).`,
      { operation, table: meta.name },
    );
  const entry: RelateEntry = {
    from: args.from,
    edge: relateEdgeName(meta, args.id, operation),
    to: args.to,
    ...(args.data !== undefined ? { data: args.data } : {}),
    ret,
    meta,
  };
  return {
    statements: [relateStatement(entry, binds, operation)],
    transactional: false,
    resultIndexes: [0],
    result: resultOf(ret, "row"),
  };
}

/** Compile `relateMany` — one `RELATE` per item in ONE transactional round-trip. */
export function compileRelateMany(
  meta: ModelMeta,
  args: { data?: unknown; meta?: unknown },
  binds: Binds,
  operation = "relateMany",
): WritePlan {
  requireRelation(meta, operation);
  const items = requireArray(args.data, "data", operation);
  const entries = items.map((item) => {
    if (!isPlainObject(item))
      throw compileError(
        "ValidationError",
        `${operation}: every item must be { from, to, data?, id? }, got ${describeValue(item)}.`,
        { operation, table: meta.name },
      );
    if (item.from === undefined || item.to === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: every item needs "from" and "to".`,
        { operation, table: meta.name },
      );
    if (item.return !== undefined && item.return !== "after")
      throw compileError(
        "ValidationError",
        `${operation}: every statement returns its created edge — per-item "return" is not supported (got ${describeValue(item.return)}).`,
        { operation, table: meta.name },
      );
    return {
      from: item.from,
      edge: relateEdgeName(meta, item.id, operation),
      to: item.to,
      ...(item.data !== undefined ? { data: item.data } : {}),
      ret: "after",
      meta,
    } satisfies RelateEntry;
  });
  return {
    statements: entries.map((entry) =>
      relateStatement(entry, binds, operation),
    ),
    transactional: entries.length > 1,
    result: resultOf("after", "many"),
  };
}

/** `RELATE from->edge[:id]->to [SET …] [RETURN …]`. */
export function relateStatement(
  entry: RelateEntry,
  binds: Binds,
  operation: string,
): string {
  const from = endpointText(entry.from, binds, operation, entry.meta, "from");
  const to =
    entry.to === "$self"
      ? "$__created"
      : endpointText(entry.to, binds, operation, entry.meta, "to");
  let sql = `RELATE ${from}->${entry.edge}->${to}`;
  if (entry.data !== undefined) {
    const encoded = entry.meta
      ? encodeData(entry.meta, entry.data, "update", operation)
      : entry.data;
    sql += ` SET ${setAssignments(encoded, binds)}`;
  }
  return `${sql}${mutationTail(entry.ret, undefined, operation)}`;
}

/** Compile `unrelate` — `DELETE edge WHERE in = $a AND out = $b RETURN BEFORE`. */
export function compileUnrelate(
  meta: ModelMeta,
  args: RelateRuntimeArgs,
  binds: Binds,
  operation = "unrelate",
): WritePlan {
  requireRelation(meta, operation);
  if (args.from === undefined || args.to === undefined)
    throw compileError(
      "ValidationError",
      `${operation}: "from" and "to" are required.`,
      { operation, table: meta.name },
    );
  const from = endpointText(args.from, binds, operation, meta, "from");
  const to = endpointText(args.to, binds, operation, meta, "to");
  const sql = `DELETE ${escapeIdent(meta.name)} WHERE in = ${from} AND out = ${to}${mutationTail("before", args.timeout, operation)}`;
  return {
    statements: [sql],
    transactional: false,
    resultIndexes: [0],
    result: "many",
  };
}

/** Compile `unrelateMany` — delete edges by filter (`all: true` without `where`). */
export function compileUnrelateMany(
  meta: ModelMeta,
  args: DeleteManyRuntimeArgs,
  binds: Binds,
  operation = "unrelateMany",
): WritePlan {
  requireRelation(meta, operation);
  const where = whereSql(args.where, binds, meta);
  if (!where && args.all !== true)
    throw compileError(
      "UnsafeMutation",
      `${operation}: no "where" deletes EVERY edge of "${meta.name}". Confirm with all: true (or add a where).`,
      { operation, table: meta.name },
    );
  const sql = where
    ? `DELETE ${escapeIdent(meta.name)}${where}`
    : `DELETE ${escapeIdent(meta.name)}`;
  return {
    statements: [`${sql}${mutationTail("before", args.timeout, operation)}`],
    transactional: false,
    result: "many",
  };
}

function requireRelation(meta: ModelMeta, operation: string): void {
  if (isTableMeta(meta) && meta.kind === "relation") return;
  throw compileError(
    "ValidationError",
    `${operation}: "${meta.name}" is not a relation — call it on the edge delegate whose schema entry is a defineRelation(...).`,
    { operation, table: meta.name },
  );
}

/** A RELATE endpoint lowered to its record id (validated against the declared endpoints) or expr. */
function endpointText(
  value: unknown,
  binds: Binds,
  operation: string,
  meta: ModelMeta | undefined,
  direction: "from" | "to",
): string {
  if (value === null || value === undefined)
    throw compileError(
      "ValidationError",
      `${operation}: an endpoint can't be ${describeValue(value)} — pass a record id or a surql expression.`,
      { operation },
    );
  if (hasRefDeep(value)) return renderValue(value, binds, binds.ctx());
  const text = String(value);
  const parts = splitRecordId(text);
  if (!parts)
    throw compileError(
      "ValidationError",
      `${operation}: endpoint "${text}" is not a record id — pass "table:id" (or a surql expression).`,
      { operation },
    );
  const declared =
    meta !== undefined && isTableMeta(meta)
      ? (meta.endpoints?.[direction] ?? [])
      : [];
  if (declared.length > 0 && !declared.includes(parts.table))
    throw compileError(
      "ValidationError",
      `${operation}: "${parts.table}" is not a declared ${direction === "from" ? "FROM" : "TO"} endpoint of "${meta?.name}" (declared: ${declared.join(", ")}).`,
      { operation, table: meta?.name, field: direction },
    );
  return `${escapeIdent(parts.table)}:${escapeRecordIdPart(parts.id)}`;
}

/** `edge` / `edge:<id>` (the edge table is the delegate itself). */
function relateEdgeName(
  meta: ModelMeta,
  id: unknown,
  operation: string,
): string {
  const table = escapeIdent(meta.name);
  if (id === undefined) return table;
  if (typeof id !== "string" || !id)
    throw compileError(
      "ValidationError",
      `${operation}: "id" must be a non-empty string (got ${describeValue(id)}).`,
      { operation, table: meta.name },
    );
  const suffix = splitRecordId(id)?.id ?? id;
  return `${table}:${escapeRecordIdPart(suffix)}`;
}

/**
 * Validate the `create.relate` sugar array into RELATE entries. `resolveEdge` maps the edge name to
 * its schema meta, so the edge `data` is codec-validated (a schemaless edge stays raw) and an
 * unknown/non-relation edge fails at the call site.
 */
export function relateSugar(
  value: unknown,
  operation: string,
  meta: ModelMeta,
  resolveEdge?: (name: string) => ModelMeta | undefined,
): readonly RelateEntry[] {
  if (value === undefined) return [];
  const entries = requireArray(value, "relate", operation);
  return entries.map((entry) => {
    if (!isPlainObject(entry))
      throw compileError(
        "ValidationError",
        `${operation}: every relate entry is { from, edge, to } (got ${describeValue(entry)}).`,
        { operation, table: meta.name },
      );
    if (
      entry.from === undefined ||
      entry.edge === undefined ||
      entry.to === undefined
    )
      throw compileError(
        "ValidationError",
        `${operation}: a relate entry needs { from, edge, to } — "to" may be "$self" for the created record.`,
        { operation, table: meta.name },
      );
    const edgeName =
      typeof entry.edge === "string"
        ? entry.edge
        : isPlainObject(entry.edge) && typeof entry.edge.name === "string"
          ? entry.edge.name
          : undefined;
    if (typeof edgeName !== "string" || !edgeName)
      throw compileError(
        "ValidationError",
        `${operation}: relate.edge must be the edge table name (or its defineRelation def).`,
        { operation, table: meta.name },
      );
    const edgeMeta = resolveEdge?.(edgeName);
    if (resolveEdge && edgeMeta === undefined)
      throw compileError(
        "ValidationError",
        `${operation}: relate.edge "${edgeName}" is not part of the schema — use a defineSchema key, the physical table name, or the RelationDef.`,
        { operation, table: meta.name },
      );
    if (
      edgeMeta !== undefined &&
      isTableMeta(edgeMeta) &&
      edgeMeta.kind !== "relation"
    )
      throw compileError(
        "ValidationError",
        `${operation}: relate.edge "${edgeName}" is a table, not a relation — edges need a defineRelation(...) entry.`,
        { operation, table: meta.name },
      );
    return {
      from: entry.from,
      edge: escapeIdent(edgeName),
      to: entry.to,
      ...(entry.data !== undefined ? { data: entry.data } : {}),
      ret: "after" as WriteRet,
      ...(edgeMeta !== undefined ? { meta: edgeMeta } : {}),
    };
  });
}
