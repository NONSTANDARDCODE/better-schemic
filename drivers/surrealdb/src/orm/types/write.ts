/**
 * The type-level write surface: the args every write op accepts and the envelopes they resolve to.
 * Result shapes dispatch on the `return` literal (mirroring how reads dispatch on `select`), and
 * `data` accepts `surql` expression fragments wherever a value fits — the codec validates the
 * literal fields, the server enforces what an expression produces.
 *
 * Cardinality honesty: singular ops (`update`/`patch`/`delete`) return `ThrowingResult` (the row may
 * not exist); `create`/`insert`/`upsert` always produce a row (or nothing with `return:'none'`);
 * every batch returns a `BatchResult` whose `count` is `undefined` when `return:'none'` hides it,
 * and a flat JSON Patch list with `return:'diff'`.
 */
import type { RecordId } from "surrealdb";
import type { Surql } from "../../frag";
import type { App, Create, Update } from "../../pure";
import type { BatchResult, ThrowingResult } from "../results";
import type { AnyRelationDef, AnyTableDef, SchemaInput } from "./schema";
import type { ResultOf, SelectArg } from "./select";
import type { WhereInput } from "./where";

/** A value position in a write: the app value or a `surql` expression fragment. */
export type WriteValue<T> = T | Surql<[T]> | Surql;

/** An id value a write accepts at the call site (the compiler coerces strings/numbers). */
export type RecordIdInput = RecordId | string | number;

/**
 * A write payload: every provided field keeps its app type OR accepts a fragment. Deep nested
 * expressions inside one field are rendered too (the field bypasses the codec and the server
 * enforces it); literal fields are codec-validated fail-fast. `id` additionally accepts the
 * string/number forms the compiler coerces to a `RecordId`.
 */
export type WriteData<T> = {
  [K in keyof T]: K extends "id" ? RecordIdInput : WriteValue<T[K]>;
};

/** The create payload (`DB-filled` / optional fields optional, `id` allowed). */
export type CreateData<TD extends AnyTableDef> = WriteData<Create<TD>>;

/** The update payload (partial; `id`/readonly excluded by the codec shape). */
export type UpdateData<TD extends AnyTableDef> = WriteData<Update<TD>>;

/** How a write hands its result back. `after` is the default where the server supports it. */
export type WriteReturn = "after" | "before" | "diff" | "none";

/** How `update` rewrites the record. */
export type UpdateMode = "merge" | "set" | "content" | "replace" | "patch";

/** One JSON Patch operation (`UPDATE … PATCH $ops`). */
export interface PatchOp {
  readonly op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  readonly path: string;
  /** The value for `add`/`replace`/`test`. */
  readonly value?: unknown;
  /** The source path for `move`/`copy`. */
  readonly from?: string;
}

/** Metadata every write carries for hooks/plugins (consumed in M6). */
export interface WriteMeta {
  /** Hook/plugin metadata (consumed in M6). */
  readonly meta?: Record<string, unknown>;
}

// --- results -------------------------------------------------------------------------------------

/** The `return` a write resolved to (`after` when absent). */
type ReturnOf<A> = A extends { return: infer R } ? R : "after";

/** What `create` resolves to (the record did not exist before — `before` is always `null`). */
export type CreatedResult<TD extends AnyTableDef, A> =
  ReturnOf<A> extends "none" | "before"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : Promise<App<TD>>;

/**
 * What `insert`/`upsert` resolve to. `RETURN BEFORE` exposes the PREVIOUS row on a conflict
 * (live-verified on 3.2.4) and `null` when the target was newly created.
 */
export type WrittenResult<TD extends AnyTableDef, A> =
  ReturnOf<A> extends "none"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : ReturnOf<A> extends "before"
        ? Promise<App<TD> | null>
        : Promise<App<TD>>;

/** What `update`/`patch` resolve to (the target may not exist). */
export type UpdatedResult<TD extends AnyTableDef, A> =
  ReturnOf<A> extends "none"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : ThrowingResult<App<TD>>;

/** What `delete` resolves to (`return` is `before` | `none`). */
export type DeletedResult<TD extends AnyTableDef, A> =
  ReturnOf<A> extends "none" ? Promise<null> : ThrowingResult<App<TD>>;

/** The row type a batch resolves to (honoring `updateEach`'s `select` projection). */
type BatchRow<TD extends AnyTableDef, A, S = SchemaInput> = A extends {
  select: infer Sel;
}
  ? ResultOf<TD, { select: Sel }, S>
  : App<TD>;

/** What a batch write resolves to — a patch list for `diff`, the envelope otherwise. */
export type BatchWriteResult<
  TD extends AnyTableDef,
  A = unknown,
  S = SchemaInput,
> =
  ReturnOf<A> extends "diff"
    ? Promise<unknown[]>
    : Promise<BatchResult<BatchRow<TD, A, S>>>;

// --- create --------------------------------------------------------------------------------------

/** `create.relate` — extra edges created in the same round-trip as the row (`to: "$self"`). */
export interface CreateRelateArg<TD extends AnyTableDef = AnyTableDef> {
  readonly from: EndpointInput;
  /** The edge table key, physical name, or the `RelationDef` itself. */
  readonly edge: string | AnyRelationDef;
  /** The target endpoint, or `"$self"` for the record just created. */
  readonly to: EndpointInput | "$self";
  /** Edge payload (`SET f = $p, …`), codec-validated against the edge's schema when resolvable. */
  readonly data?: UpdateData<TD>;
}

/** A `create` payload without `relate` — every `return` the server supports. */
export interface CreatePlainArgs<TD extends AnyTableDef> extends WriteMeta {
  data: CreateData<TD>;
  /** `CREATE ONLY t` — one object back instead of an array. */
  readonly only?: boolean;
  readonly return?: WriteReturn;
  readonly relate?: undefined;
}

/** A `create` payload with `relate` sugar — the batch can't express `RETURN DIFF`. */
export interface CreateRelateArgs<TD extends AnyTableDef> extends WriteMeta {
  data: CreateData<TD>;
  /** `CREATE ONLY t` — one object back instead of an array. */
  readonly only?: boolean;
  readonly return?: "after" | "before" | "none";
  /** Edges to create in the same round-trip (`LET $created = (CREATE ONLY …); RELATE …`). */
  readonly relate: readonly CreateRelateArg[];
}

/** A `create` payload: the data, plus optional `relate` sugar and RETURN control. */
export type CreateArgs<TD extends AnyTableDef> =
  | CreatePlainArgs<TD>
  | CreateRelateArgs<TD>;

/** `createMany` — one `CREATE` per row in ONE round-trip (implicit transaction). */
export interface CreateManyArgs<TD extends AnyTableDef> extends WriteMeta {
  data: readonly CreateData<TD>[];
  /**
   * Skip rows whose explicit `id` already exists (one `INSERT IGNORE` per row). Every item must
   * carry an `id` — for id-less rows use `insertMany({ onDuplicate: 'ignore' })` instead.
   */
  readonly skipDuplicates?: boolean;
  readonly return?: WriteReturn;
}

/** What `onDuplicate` accepts in `insert`/`insertMany`. */
export type OnDuplicate<TD extends AnyTableDef> =
  | "ignore"
  | "update"
  | UpdateData<TD>;

// --- insert --------------------------------------------------------------------------------------

/** `insert` — one row, keeping the payload's ids. */
export interface InsertArgs<TD extends AnyTableDef> extends WriteMeta {
  data: CreateData<TD>;
  /** `ignore` → `INSERT IGNORE`; `update` → `ON DUPLICATE KEY UPDATE` from the payload; a map for explicit expressions. */
  readonly onDuplicate?: OnDuplicate<TD>;
  readonly return?: WriteReturn;
}

/** `insertMany` — an array payload in a SINGLE statement (implicit transaction not needed). */
export interface InsertManyArgs<TD extends AnyTableDef> extends WriteMeta {
  data: readonly CreateData<TD>[];
  readonly onDuplicate?: OnDuplicate<TD>;
  readonly return?: WriteReturn;
}

// --- update --------------------------------------------------------------------------------------

/** The clauses shared by every update-shaped op. */
export interface UpdateClauses extends WriteMeta {
  /** `merge` (default) | `set` | `content` | `replace` | `patch`. */
  readonly mode?: UpdateMode;
  /** JSON Patch ops (required when `mode: 'patch'`, and `patch()` needs them directly). */
  readonly patches?: readonly PatchOp[];
  /** Fields to remove (`UNSET a, b`); with `data` it becomes a second statement in the same round-trip. */
  readonly unset?: readonly string[];
  readonly return?: WriteReturn;
  /** Number = milliseconds; string = a SurrealQL duration (`'10s'`, `'500ms'`). */
  readonly timeout?: number | string;
}

/** `update` — targets the id or a single-field UNIQUE index (a miss resolves `null`). */
export interface UpdateArgs<TD extends AnyTableDef, S = SchemaInput>
  extends UpdateClauses {
  where: WhereInput<TD, S>;
  data?: UpdateData<TD>;
  /** `UPDATE ONLY t:id …` — one object back (id targets only). */
  readonly only?: boolean;
}

/** `updateMany` — every matching row (no `where` = the whole table; `rules` guards land in M6). */
export interface UpdateManyArgs<TD extends AnyTableDef, S = SchemaInput>
  extends UpdateClauses {
  where?: WhereInput<TD, S>;
  data?: UpdateData<TD>;
}

/** `patch` — JSON Patch by unique target. */
export interface PatchArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta {
  where: WhereInput<TD, S>;
  patches: readonly PatchOp[];
  readonly return?: WriteReturn;
  readonly only?: boolean;
  readonly timeout?: number | string;
}

// --- upsert --------------------------------------------------------------------------------------

/** `upsert` — create-or-update by id or a single-field UNIQUE index. */
export interface UpsertArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta {
  where: WhereInput<TD, S>;
  /**
   * One payload for both branches (`UPSERT t:id MERGE $p` / `UPSERT t MERGE $p WHERE uniq = $v`).
   * Partial patches are allowed (the merge path); the server enforces required fields when the
   * create branch runs.
   */
  data?: CreateData<TD> | UpdateData<TD>;
  /** The create branch (with `update`; distinct payloads compile `INSERT … ON DUPLICATE …`). */
  create?: CreateData<TD>;
  /** The update branch (with `create`). */
  update?: UpdateData<TD>;
  /** How the update branch rewrites (`merge` default). */
  readonly mode?: Exclude<UpdateMode, "patch">;
  /** `UPSERT ONLY t:id …`. */
  readonly only?: boolean;
  readonly return?: WriteReturn;
  readonly timeout?: number | string;
}

/** `upsertMany` — with ids, one `INSERT … ON DUPLICATE`; without, `conflict` resolves each row. */
export interface UpsertManyArgs<TD extends AnyTableDef> extends WriteMeta {
  data: readonly CreateData<TD>[];
  /** `all` (default) updates every payload field; a map updates explicit fields/expressions. */
  readonly update?: "all" | UpdateData<TD>;
  /**
   * The single-field UNIQUE index that resolves rows without an `id` (required then) — validated
   * against the schema (`UniqueTargetRequired`), never a plain column.
   */
  readonly conflict?: keyof App<TD> & string;
  readonly return?: WriteReturn;
}

// --- delete --------------------------------------------------------------------------------------

/** `delete` — id or single-field UNIQUE target; `before` (default) or `none`. */
export interface DeleteArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta {
  where: WhereInput<TD, S>;
  readonly return?: "before" | "none";
  readonly timeout?: number | string;
}

/** `deleteMany` — every matching row; without `where`, `all: true` is required. */
export interface DeleteManyArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta {
  where?: WhereInput<TD, S>;
  /** Confirm a whole-table delete (no `where`). */
  readonly all?: boolean;
  readonly return?: "before" | "none";
  readonly timeout?: number | string;
}

// --- updateEach ----------------------------------------------------------------------------------

/** One `updateEach` item: the matching key (`by`, required by type) plus the fields to apply. */
export type UpdateEachItem<
  TD extends AnyTableDef,
  By extends keyof App<TD> & string = "id",
> = UpdateData<TD> & {
  readonly [K in By]-?: K extends "id" ? RecordIdInput : App<TD>[K];
};

/** `updateEach` — one `UPDATE … WHERE by = $item.by` statement per item (ONE round-trip). */
export interface UpdateEachArgs<
  TD extends AnyTableDef,
  By extends keyof App<TD> & string = "id",
> extends WriteMeta {
  data: readonly UpdateEachItem<TD, By>[];
  /** The matching field (default `id`). Every item must carry it; duplicates are rejected. */
  readonly by?: By;
  /** `merge` (default) | `set` | `content` | `patch`. */
  readonly mode?: Exclude<UpdateMode, "replace">;
  /** Per-item JSON Patch ops (required when `mode: 'patch'`). */
  readonly patches?: readonly (readonly PatchOp[])[];
  /** `return` (default) puts misses in `skipped`; `throw` raises `ResultNotFound`. */
  readonly onEmpty?: "return" | "throw";
  readonly return?: "after" | "none";
  /** Project the returned rows (decoded client-side; compiled before the write runs). */
  readonly select?: SelectArg<TD>;
  readonly timeout?: number | string;
}

// --- relate --------------------------------------------------------------------------------------

/** A RELATE endpoint: a record id string / `RecordId`, or a `surql` expression. */
export type EndpointInput =
  | string
  | { toString(): string }
  | Surql<[unknown]>
  | Surql;

/** `relate` on an edge delegate — `RELATE from->edge->to`. */
export interface RelateArgs<TD extends AnyTableDef> extends WriteMeta {
  from: EndpointInput;
  to: EndpointInput;
  /** A named edge id (`RELATE a->edge:named->b`). */
  readonly id?: string;
  /** Edge payload (`SET f = $p, …`). */
  readonly data?: UpdateData<TD>;
  readonly return?: WriteReturn;
}

/** `relateMany` — one `RELATE` per item in ONE round-trip (implicit transaction). */
export interface RelateManyArgs<TD extends AnyTableDef> extends WriteMeta {
  /** Every statement returns its created edge — per-item `return` is not part of the surface. */
  data: readonly Omit<RelateArgs<TD>, "return">[];
}

/** `unrelate` — delete the edges between two endpoints. */
export interface UnrelateArgs<_TD extends AnyTableDef = AnyTableDef>
  extends WriteMeta {
  from: EndpointInput;
  to: EndpointInput;
  readonly timeout?: number | string;
}

/** `unrelateMany` — delete edges by filter (no `where` requires `all: true`). */
export interface UnrelateManyArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta {
  where?: WhereInput<TD, S>;
  readonly all?: boolean;
  readonly timeout?: number | string;
}
