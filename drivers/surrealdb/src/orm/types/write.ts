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
import type { Decimal, Duration, Geometry, RecordId } from "surrealdb";
import type { Surql } from "../../frag";
import type { App, BareId, Create, Update } from "../../pure";
import type { BatchResult, ThrowingResult } from "../results";
import type { CallContext } from "./context";
import type { AnyRelationDef, AnyTableDef, SchemaInput } from "./schema";
import type { ResultOf, SelectArg } from "./select";
import type { WhereInput } from "./where";

/** A value position in a write: the app value or a `surql` expression fragment. */
export type WriteValue<T> = T | Surql<[T]> | Surql;

/** An id value a write accepts at the call site (the compiler coerces strings/numbers). */
export type RecordIdInput = RecordId | string | number;

/**
 * Add the `RecordId` form wherever the app value is a string-id `BareId<N>` (nested objects/arrays
 * included) — the string-id codec's wire side accepts `string | RecordId`, so writes do too.
 * Class values (Date/Decimal/…) are left untouched.
 */
export type RecordIdInputs<T> =
  T extends BareId<infer N>
    ? T | RecordId<N>
    : T extends readonly (infer E)[]
      ? readonly RecordIdInputs<E>[]
      : T extends Date | Uint8Array | Decimal | Duration | Geometry | RecordId
        ? T
        : T extends object
          ? { [K in keyof T]: RecordIdInputs<T[K]> }
          : T;

/**
 * A write payload: every provided field keeps its app type (plus its `RecordId` form in string-id
 * mode) OR accepts a fragment. Deep nested expressions inside one field are rendered too (the field
 * bypasses the codec and the server enforces it); literal fields are codec-validated fail-fast.
 * `id` additionally accepts the string/number forms the compiler coerces to a `RecordId`.
 */
export type WriteData<T> = {
  [K in keyof T]: K extends "id"
    ? RecordIdInput
    : WriteValue<RecordIdInputs<T[K]>>;
};

/** The numeric part of a field's app type — the only values an adjustment can carry. */
type NumericOf<T> = Extract<T, number | bigint | Decimal>;

/** `unknown`/`any` fields (schemaless models) accept any numeric adjustment. */
type IsWide<T> = unknown extends T ? true : false;

/** The adjustment markers a field accepts (numeric fields only). */
type AdjustmentFor<T> = [NumericOf<T>] extends [never]
  ? IsWide<T> extends true
    ? ArithmeticAdjustment<number | bigint | Decimal>
    : never
  : ArithmeticAdjustment<NumericOf<T>>;

/**
 * The update payload: like {@link WriteData}, plus server-side adjustments on numeric fields
 * (`{ increment: 10 }` → `SET balance += $p`, `{ decrement: 10 }` → `SET balance -= $p`) — one
 * read-modify-write server-side, so concurrent writers can't lose an update.
 */
export type UpdateWriteData<T> = {
  [K in keyof T]: K extends "id"
    ? RecordIdInput
    : WriteValue<RecordIdInputs<T[K]>> | AdjustmentFor<T[K]>;
};

/** The create payload (`DB-filled` / optional fields optional, `id` allowed). */
export type CreateData<TD extends AnyTableDef> = WriteData<Create<TD>>;

/** The update payload (partial; `id`/readonly excluded by the codec shape). */
export type UpdateData<TD extends AnyTableDef> = UpdateWriteData<Update<TD>>;

// --- arithmetic adjustments ----------------------------------------------------------------------

/** The operand an adjustment accepts: a number/bigint/Decimal, or an expression fragment. */
export type ArithmeticValue<T> = T | Surql<[T]> | Surql;

/** `balance: { increment: 10 }` — `SET balance += $p`. */
export interface Increment<T = number> {
  readonly increment: ArithmeticValue<T>;
}

/** `balance: { decrement: 10 }` — `SET balance -= $p`. */
export interface Decrement<T = number> {
  readonly decrement: ArithmeticValue<T>;
}

/**
 * A server-side adjustment of a numeric field. The wrapper shape is reserved in write payloads:
 * an object with exactly one `increment`/`decrement` key is always an adjustment (wrap a literal
 * object with that shape in a `surql` fragment). Adjustments need an EXISTING value — they are
 * accepted by `update`/`updateMany`/`updateEach` and by the update branch of a strict `upsert`,
 * never by a create/insert.
 */
export type ArithmeticAdjustment<T = number> = Increment<T> | Decrement<T>;

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
  /** Per-call namespace/database override (`context: { database: "analytics" }`). */
  readonly context?: CallContext;
}

// --- results -------------------------------------------------------------------------------------

/** The `return` a write resolved to (`after` when absent). */
type ReturnOf<A> = A extends { return: infer R } ? R : "after";

/**
 * The row type a write resolves to — the args literal drives it exactly like reads: `select` →
 * the projected shape, `omit` → the row minus keys, neither → the whole `App<TD>`. The server
 * projects when it can (`RETURN <projection>`); the BEFORE state, `delete`, `upsertDelta`, OMIT
 * and the `create.relate` sugar are projected client-side after decoding.
 */
export type WriteResultOf<
  TD extends AnyTableDef,
  A,
  S = SchemaInput,
> = ResultOf<TD, A, S>;

/** What `create` resolves to (the record did not exist before — `before` is always `null`). */
export type CreatedResult<TD extends AnyTableDef, A, S = SchemaInput> =
  ReturnOf<A> extends "none" | "before"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : Promise<WriteResultOf<TD, A, S>>;

/**
 * What `insert`/`upsert` resolve to. `RETURN BEFORE` exposes the PREVIOUS row on a conflict
 * (live-verified on 3.2.4) and `null` when the target was newly created. A STRICT `upsert` (its
 * default) rejects `ResultNotFound` when the target matches nothing — it never resolves the
 * contract-breaking `null`; a target-less `upsert` is a plain create, and a create filtered by a
 * permission/scope rejects the same way.
 */
export type WrittenResult<TD extends AnyTableDef, A, S = SchemaInput> =
  ReturnOf<A> extends "none"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : ReturnOf<A> extends "before"
        ? Promise<WriteResultOf<TD, A, S> | null>
        : Promise<WriteResultOf<TD, A, S>>;

/** What `update`/`patch` resolve to (the target may not exist). */
export type UpdatedResult<TD extends AnyTableDef, A, S = SchemaInput> =
  ReturnOf<A> extends "none"
    ? Promise<null>
    : ReturnOf<A> extends "diff"
      ? Promise<unknown[]>
      : ThrowingResult<WriteResultOf<TD, A, S>>;

/** What `delete` resolves to (`return` is `before` | `none`). */
export type DeletedResult<TD extends AnyTableDef, A, S = SchemaInput> =
  ReturnOf<A> extends "none"
    ? Promise<null>
    : ThrowingResult<WriteResultOf<TD, A, S>>;

/** What a batch write resolves to — a patch list for `diff`, the envelope otherwise. */
export type BatchWriteResult<
  TD extends AnyTableDef,
  A = unknown,
  S = SchemaInput,
> =
  ReturnOf<A> extends "diff"
    ? Promise<unknown[]>
    : Promise<BatchResult<WriteResultOf<TD, A, S>>>;

// --- projections on the returned rows ------------------------------------------------------------

/**
 * The `select`/`omit` a write accepts for its returned rows — the SAME projection surface as reads
 * (`select: { id: true, name: true, city: "address.city" }`, expressions, `*`, `omit`). The server
 * carries it in the `RETURN` clause when possible; the BEFORE state, `delete`, `upsertDelta`, OMIT
 * and `create.relate` are decoded whole and projected client-side (expression entries are rejected
 * there — only the server can compute them).
 */
export interface WriteProjection<TD extends AnyTableDef> {
  /** Project the returned record(s) (`select` parity with reads). */
  readonly select?: SelectArg<TD>;
  /** Remove top-level fields from the returned record(s) (client-side; `RETURN … OMIT` is a parse error). */
  readonly omit?: readonly (keyof App<TD> & string)[];
}

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
export interface CreatePlainArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
  data: CreateData<TD>;
  /** `CREATE ONLY t` — one object back instead of an array. */
  readonly only?: boolean;
  readonly return?: WriteReturn;
  readonly relate?: undefined;
}

/** A `create` payload with `relate` sugar — the batch can't express `RETURN DIFF`. */
export interface CreateRelateArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
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
export interface CreateManyArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
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
export interface InsertArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
  data: CreateData<TD>;
  /** `ignore` → `INSERT IGNORE`; `update` → `ON DUPLICATE KEY UPDATE` from the payload; a map for explicit expressions. */
  readonly onDuplicate?: OnDuplicate<TD>;
  readonly return?: WriteReturn;
}

/** `insertMany` — an array payload in a SINGLE statement (implicit transaction not needed). */
export interface InsertManyArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
  data: readonly CreateData<TD>[];
  readonly onDuplicate?: OnDuplicate<TD>;
  readonly return?: WriteReturn;
}

// --- update --------------------------------------------------------------------------------------

/** The clauses shared by every update-shaped op. */
export interface UpdateClauses<TD extends AnyTableDef = AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
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
  extends UpdateClauses<TD> {
  where: WhereInput<TD, S>;
  data?: UpdateData<TD>;
  /** `UPDATE ONLY t:id …` — one object back (id targets only). */
  readonly only?: boolean;
}

/** `updateMany` — every matching row (no `where` = the whole table; `rules` guards land in M6). */
export interface UpdateManyArgs<TD extends AnyTableDef, S = SchemaInput>
  extends UpdateClauses<TD> {
  where?: WhereInput<TD, S>;
  data?: UpdateData<TD>;
}

/** `patch` — JSON Patch by unique target. */
export interface PatchArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta,
    WriteProjection<TD> {
  where: WhereInput<TD, S>;
  patches: readonly PatchOp[];
  readonly return?: WriteReturn;
  readonly only?: boolean;
  readonly timeout?: number | string;
}

// --- upsert --------------------------------------------------------------------------------------

/** `upsert` — by default a STRICT update by id, a single-field UNIQUE index or an inferred
 *  `data.id`; `onMissing: "create"` restores create-or-update. With NO target at all the call is
 *  a plain `CREATE` (mirroring `create()`). */
export interface UpsertArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta,
    WriteProjection<TD> {
  /**
   * The target: `{ id }` or a single-field UNIQUE index (same rules as `upsertDelta`). Omit it to
   * infer the target from `data.id`, or to CREATE when neither is present (a generated id per the
   * table's `idStrategy`).
   */
  where?: WhereInput<TD, S>;
  /**
   * One payload for both branches (`UPSERT t:id MERGE $p` / `UPSERT t MERGE $p WHERE uniq = $v`) —
   * or the record to CREATE when the call is target-less. Partial patches are allowed (the merge
   * path); the codec enforces required fields when the create branch runs.
   */
  data?: CreateData<TD> | UpdateData<TD>;
  /** The create branch (with `update`; distinct payloads compile `INSERT … ON DUPLICATE …`).
   *  Requires `onMissing: "create"`. */
  create?: CreateData<TD>;
  /** The update branch (with `create`). Requires `onMissing: "create"`. */
  update?: UpdateData<TD>;
  /**
   * What to do when the target matches nothing:
   * - `"throw"` (default) — STRICT update: reject with `ResultNotFound`, never create. Requires
   *   an inferable target (`where`, or `data.id`); explicit `"throw"` on a target-less call is
   *   rejected (there is nothing to miss).
   * - `"create"` — true upsert semantics (create the record when the target is absent).
   */
  readonly onMissing?: "create" | "throw";
  /** How the update branch rewrites (`merge` default). A target-less call is a plain create, so
   *  an explicit `mode` there is rejected (it would have nothing to rewrite). */
  readonly mode?: Exclude<UpdateMode, "patch">;
  /** `UPSERT ONLY t:id …`, or `CREATE ONLY …` on a target-less call. */
  readonly only?: boolean;
  readonly return?: WriteReturn;
  readonly timeout?: number | string;
}

// --- upsertDelta ---------------------------------------------------------------------------------

/** One changed field of a row: the delta `upsertDelta` hands back. Keys are CHANGED fields only. */
export interface FieldDelta<T> {
  /** The previous values of the changed fields. */
  readonly old: Partial<T>;
  /** The resulting values of the changed fields (`undefined` = the field was removed). */
  readonly new: Partial<T>;
}

/** A changed field name, typed against the model (`keyof App<TD> & string`). */
export type DeltaKey<T> = keyof T & string;

/**
 * `upsertDelta` — by default a STRICT update by id or a single-field UNIQUE index in ONE
 * round-trip, returning the resulting row, the previous row and the field-level delta of DECODED
 * app values. A targeted miss rejects `ResultNotFound`; `onMissing: "create"` restores
 * create-or-update (a target-less call is always a plain create).
 *
 * ```ts
 * const { record, created, before, delta, changed } = await client.users.upsertDelta({
 *   where: { id: "user:42" },
 *   data: { name: "Aeon" },
 * });
 * ```
 */
export interface UpsertDeltaArgs<TD extends AnyTableDef, S = SchemaInput>
  extends WriteMeta,
    WriteProjection<TD> {
  /**
   * The target: `{ id }` or a single-field UNIQUE index (same rules as `upsert`). Omit it to get
   * a plain create (a generated id per the table's `idStrategy`), or let `data.id` infer it.
   */
  where?: WhereInput<TD, S>;
  /** One payload for both branches; combine with `create` + `update` for distinct payloads. */
  data?: CreateData<TD> | UpdateData<TD>;
  /** The create branch (with `update`; distinct payloads compile the LET/IF lowering). */
  create?: CreateData<TD>;
  /** The update branch (with `create`). */
  update?: UpdateData<TD>;
  /** How the update branch rewrites (`merge` default). `patch` is not supported. */
  readonly mode?: Exclude<UpdateMode, "patch">;
  /**
   * What to do when the target matches nothing:
   * - `"throw"` (default) — strict update: reject with `ResultNotFound`, never create.
   *   Requires an inferable target (`where`, or `data.id`).
   * - `"create"` — true upsert semantics (create the record).
   */
  readonly onMissing?: "create" | "throw";
  readonly timeout?: number | string;
}

/**
 * What `upsertDelta` resolves to. `created` discriminates the branches, so `before`/`delta` narrow
 * automatically: a create has no previous state (`before: null`, `delta: null`, `changed: []`).
 * A `select`/`omit` shapes `record`/`before` (and therefore `delta`/`changed`, which only cover the
 * projected fields).
 */
export type UpsertDeltaResult<
  TD extends AnyTableDef,
  A = unknown,
  S = SchemaInput,
> =
  | {
      /** The row AFTER the write, codec-decoded (same shape every other write returns). */
      readonly record: WriteResultOf<TD, A, S>;
      /** `true` when the target did not exist and the create branch ran. */
      readonly created: true;
      /** Always `null` on create — there was no previous state. */
      readonly before: null;
      /** Always `null` on create. */
      readonly delta: null;
      /** Always empty on create. */
      readonly changed: readonly [];
    }
  | {
      readonly record: WriteResultOf<TD, A, S>;
      readonly created: false;
      /** The row BEFORE the update, codec-decoded. */
      readonly before: WriteResultOf<TD, A, S>;
      /** `null` when the update changed nothing. Keys are exactly `changed`. */
      readonly delta: FieldDelta<WriteResultOf<TD, A, S>> | null;
      /** Names of the changed fields, in stable order; `[]` when nothing changed. */
      readonly changed: readonly DeltaKey<WriteResultOf<TD, A, S>>[];
    };

/** `upsertMany` — with ids, one `INSERT … ON DUPLICATE`; without, `conflict` resolves each row. */
export interface UpsertManyArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
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
  extends WriteMeta,
    WriteProjection<TD> {
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
  readonly [K in By]-?: K extends "id"
    ? RecordIdInput
    : RecordIdInputs<App<TD>[K]>;
};

/** `updateEach` — one `UPDATE … WHERE by = $item.by` statement per item (ONE round-trip). */
export interface UpdateEachArgs<
  TD extends AnyTableDef,
  By extends keyof App<TD> & string = "id",
> extends WriteMeta,
    WriteProjection<TD> {
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
export interface RelateArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
  from: EndpointInput;
  to: EndpointInput;
  /** A named edge id (`RELATE a->edge:named->b`). */
  readonly id?: string;
  /** Edge payload (`SET f = $p, …`). */
  readonly data?: UpdateData<TD>;
  readonly return?: WriteReturn;
}

/** `relateMany` — one `RELATE` per item in ONE round-trip (implicit transaction). */
export interface RelateManyArgs<TD extends AnyTableDef>
  extends WriteMeta,
    WriteProjection<TD> {
  /** Every statement returns its created edge — per-item `return`/`select` are not part of the surface. */
  data: readonly Omit<RelateArgs<TD>, "return" | "select" | "omit">[];
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
