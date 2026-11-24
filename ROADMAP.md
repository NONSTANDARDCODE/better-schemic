# Better-schemic — roadmap

The **typed-query/ORM arc**: replacing the old fluent builder with the repository-style `/orm` layer.
This file carries the milestone plan (M0–M7) and their status; the live-verified SurrealQL ground
truth the compiler emits against is `packages/better-schemic/docs/orm-syntax-map.md`, and the exhaustive
runtime surface is `packages/better-schemic/docs/ORM-COVERAGE.md`.

Packages release **in lockstep**; see `CHANGELOG.md` for what's shipped vs accumulating.

Legend: ✅ done · 🚧 in progress · 🟡 partial · ⏳ not started

---

## M0 — foundation + legacy replacement ✅ *(complete)*

- ✅ **M0.1** syntax map (`docs/orm-syntax-map.md`, 89 probes) —
  every statement the ORM emits, verified against server 3.2.x, with the prototype divergences recorded.
- ✅ **M0.2** `defineSchema` + `SchemaIndex` (columns/families, record links, graph adjacency,
  singletons, functions, schemaless entries; fail-fast `SchemaInvalid`).
- ✅ **M0.3** result wrappers (`ThrowingResult`/`BatchResult`/`StatementResult`) + `BetterSchemicError`
  catalog, SDK-error normalization and predicates.
- ✅ **M0.4** executor: one `conn.query` round-trip for N statements, per-statement status via
  `responses()`, atomic `BEGIN/COMMIT` batches, unique-binds guardrail.
- ✅ **M0.5** `/orm` bootstrap (`betterSchemic`/`createBetterSchemic`, delegates, `repository`,
  `tables`, `extends`, `forkSession`, BYO-managed lifecycle) + **the legacy surface removed** (fluent
  builder, `/client`, `better-schemic/core/query`; `/query` keeps `block()`).

## M1 — reads ✅ *(complete)*

The object-based compiler (`where`/`select`/`aggregate`/`pagination`) and the full read surface:
`findMany`/`findFirst`/`findOne`/`findUnique`/`count`/`exists`/`aggregate`/`paginate`/`cursor` —
lazy thenables with `.throw()`/`.explain()` (`explain: true` returns the plan), typed from the args
literal, always one round-trip.

- ✅ **M1.1** `compiler/shared.ts` + `compiler/where.ts` + `types/where.ts` (golden args→SQL,
  injection-proof identifiers/binds, family-aware operators, paths/logical/fragments).
- ✅ **M1.2** `compiler/projection.ts` (SQL text + decode spec in ONE pass) + `findMany` (all clause
  forms) + `decode.ts` (full/omit/projection/value/split).
- ✅ **M1.3** `findFirst`/`findOne`/`findUnique` (+ `compiler/unique.ts`) + `.throw()`/`NotFoundInfo`.
- ✅ **M1.4/M1.5** `count`/`exists` + `aggregate` (`_count`, `math::*` — `avg`→`math::mean`,
  `collect`/`distinct`, `HavingUnsupported`).
- ✅ **M1.6** `paginate` (offset + count in one round-trip; `count:false` probes n+1) + `cursor`
  (id/tuple keyset, tiebreaker guard, `before` reversal).
- ✅ **M1.7** `.explain()`/`explain: true` (EXPLAIN per statement, never executes; `ExplainResult`).
- ✅ **M1.8** `test/types/orm-reads.{assert,bench}.ts` (assertions + measured instantiation budgets).

Structure after the pre-M2 thermo-nuclear pass: `delegate.ts` (public surface) / `reads.ts` (read
runtime) / `compiler/{shared,projection,where,select,aggregate,pagination,unique}.ts`; no name-based
dispatch, one canonical helper per rule, paginate's count composed from the read/count compilers.

## M2 — writes ✅ *(complete)*

The full write surface, one round-trip per operation, typed from the args literal:
`create`/`createMany` (+ `relate` sugar, `skipDuplicates`), `insert`/`insertMany` (`onDuplicate`),
`update`/`updateMany` (modes `merge|set|content|replace|patch`, `unset`, `surql` expressions),
`patch`, `upsert`/`upsertMany` (id / single-field UNIQUE / `conflict`), `delete`/`deleteMany`
(`RETURN BEFORE|NONE`, `all: true` guard), `updateEach` (per-item, `skipped`/`onEmpty`) and the
edge operations `relate`/`relateMany`/`unrelate`/`unrelateMany` on the relation delegate.

- ✅ **M2.1** `create`/`createMany` — codec fail-fast, `only`, `relate` sugar in one batch,
  `skipDuplicates` (per-row `INSERT IGNORE`), implicit transactions, `RecordAlreadyExists`.
- ✅ **M2.2** `insert`/`insertMany` — `onDuplicate: 'ignore' | 'update' | map`, `$input`
  expressions, `RETURN` (incl. the live-verified `before`).
- ✅ **M2.3** `update`/`updateMany` — five modes, `unset` (+ second statement with `data`),
  expression fields, `only`/`timeout`, "never creates" (`[]` → `null`/`.throw()`).
- ✅ **M2.4** `patch` — JSON Patch with op validation.
- ✅ **M2.5** `upsert`/`upsertMany` — `UPSERT` by id/unique, `INSERT … ON DUPLICATE` for literal
  branches and `LET`/`IF` when expressions must read the existing row.
- ✅ **M2.6** `delete`/`deleteMany` — `RETURN BEFORE|NONE` (`after`/`diff` rejected), `all: true`
  for whole-table, server-side cascades documented.
- ✅ **M2.7** `updateEach` — per-item statements, distinct `by` guard, `skipped`, `onEmpty: 'throw'`.
- ✅ **M2.8** `relate`/`relateMany`/`unrelate`/`unrelateMany` — edge-delegate object args, typed
  endpoints validated against the `RelationDef`, named edge ids, edge data; `RelationDelegate`.
- ✅ **M2.9** `idStrategy` — per-table create-id generation (`ulid` default / `uuid` v7 / `rand`),
  applied to every create path (`create`/`createMany`/`create.relate`, `insert`/`insertMany`,
  `upsert`/`upsertMany`, `skipDuplicates`); explicit ids and singletons always win, `id: s.uuid()`/
  `s.ulid()` infers the strategy with a conflict fail-fast at `defineSchema` (a pinned uuid v4/v6 id
  field resolves to `"none"` — explicit ids only, a generated create fails at compile time), and no
  DDL is emitted (migrations never diff).

Also in this arc: record-string coercion in `where` (`"user:aeon"` → `RecordId`), `BatchResult.count`
optional on `return: 'none'`, `return: 'diff'` as the flat combined patch list, `insert`/`upsert`
`before` typed `App | null`, `skipDuplicates` generating ids for id-less rows and
`upsertMany.conflict` UNIQUE, `updateEach.select` compiled before the write, `unrelate` timeout, and
the new live map entries (`FOR` returns `NONE`, `SET $obj` parse error, ON DUPLICATE branch
evaluation, generated-id forms).

## M3 — relations and graphs ✅ *(complete)*

`include` (`FETCH`/traversal/`edge`/`target`/`_count`), relational `where`
(`is`/`isNot`/`some`/`every`/`none`) and traversal/recursion through `surql` fragments — all in the
SAME single round-trip, with client-side hydration.

- ✅ **M3.0** live probes + `orm-syntax-map.md` §5.1–5.3: target records need a subquery, `out.*`
  stops at the edge, incoming flips both arrows, `every` is count-equality, `count(field)` is
  NONE-safe, FETCH needs the link selected, subquery `ORDER BY` needs the order idiom, `direction
  "both"` (`<->edge<->target`, `<->edge`) works but `?.*` is a parse error, wildcard edge filters
  use `->(? WHERE …)`.
- ✅ **M3.1** link `include` — `true`/`{ "*": true }` → `FETCH` (last clause, link added to the
  selection); `{ select }` flattens (`author.id AS author_id`) and remounts with the target codec;
  `{ include }` nests (`FETCH author.profile`); array links hydrate element-wise.
- ✅ **M3.2** graph `include` — `(SELECT … FROM ->edge->target)`, `edge: true` records,
  `{ edge, target }` remount (edge fields + `out.*`/`in.*`), per-parent `where` split edge/target,
  `orderBy`/`limit`/`start`, `direction: "out"|"in"|"both"` (auto by endpoints) and `wildcard`.
- ✅ **M3.3** `_count` — correlated `count(->edge)`, `count(<-edge)`, `count(->(edge WHERE)->(target
  WHERE))` and `count(field[WHERE …])` for record arrays; remounted as one `_count` object.
- ✅ **M3.4** relational `where` — `is`/`isNot` (target filter behind the link path; `isNot` true on
  `NONE`), `some`/`none`/`every` over edges and array links (counts, NONE-safe).
- ✅ **M3.5** traversal/recursion documented as `surql` recipes (`@.{1..10}->edge->node`,
  `->edge->target.field`, `count(->edge)`) — no new surface, live-verified.

Typed end to end: `S` flows through `Delegate`/`ReadArgs`/`Where`/`ResultOf` (including the write
batches), with `types/{include,relations}.ts` deriving links, edges, targets and `_count` from the
authored schema. New modules: `orm/compiler/include/*` + `orm/compiler/relations.ts`,
`orm/types/{include,relations}.ts`; hydration in `orm/decode.ts`. Live:
the new syntax probes (78 total).

Hardening in the same milestone: relational `where` also lowers on `updateMany`/`deleteMany`/
`unrelateMany` (the schema index flows into the write compilers); a projected link without `id`
projects a hidden presence leaf so an absent link decodes to `null`; nested `select` objects remount
at the right path; `direction "both"` + `edge`+`target`, empty nested `include`, target filters on
edge-only includes and `_count` option typos all fail fast. The relational lowering lives in ONE
place (`relations.ts` arrow/traversal/refs + `where.ts` `compileRelationFilter`), shared by
`include`, `_count` and `where`.

## M4 — transactions ✅ *(complete)*

- ✅ **M4.1** `client.transaction(fn, options?)` — SDK managed transaction, `tx` = full client, `tx.rollback(reason)` → `TransactionRollback`, nested calls share one tx, `afterCommit`/`afterRollback`, opt-in retries and client-side timeout. Only `mode: "sdk"` is supported — SQL `BEGIN/COMMIT` does not hold across RPCs.

## M5 — escape hatches, admin and context ✅ *(complete)*

- ✅ **M5.1** `$raw`/`$query`/`$unsafe` — `$raw<T>` tagged template (each `${…}` becomes `$p<n>` via
  `renderValue`, so a `surql` fragment composes), `$raw(string|BoundQuery, options)`, and the
  **curried** `$raw({ meta })\`…\`` (carries the options to the template — without it `raw.requireComment` was
  unsatisfiable on the recommended path); `$query` N statements with `throwOnError: false` →
  `StatementResult[]`; `$unsafe` requires `raw.unsafe: true` (`UnsafeDisabled`);
  `raw.requireComment` requires `meta.comment` on a write script; `raw.timeoutMs` applies `TIMEOUT` only to a single statement with
  a compatible verb (SELECT/UPDATE/CREATE/DELETE/INSERT/UPSERT/RELATE).
- ✅ **M5.2** `fn`/`api`/`auth`/admin — `client.fn.call<R>(name, args)` compiles `RETURN fn::x($p…)`
  (name validated, never spliced) + typed shortcut via `defineFunction` (NAMED args → positional);
  `client.api.get/post/put/patch/delete` unwraps `body` and throws `DatabaseError` with `status` +
  `details` on `>= 400`; `client.auth.signin/signup/authenticate/invalidate/record`;
  `info(level, table?)`/`version()`/`ping()`/`export()`/`import(dump)`.
- ✅ **M5.3** `$withContext` — synchronous clone with prefixed NS/DB (`USE NS … DB …;`) in the SAME
  operation, without touching the session (multi-tenant with no global state); per-call override
  (`findMany({ context: { database } })`); `$withContext({ auth })` (async overload) forks the
  session and authenticates; session-bound operations (`api`/`auth`/`export`/`live`) fail fast with
  `UnsupportedCapability` on a prefix clone; `extends` re-applied on clones/transaction.

Typed end to end: `RawOptions`/`RawSource`/`RawStatements`/`RawTag`, `OperationContext`/`ContextScope`/
`ResolvedContext`/`CallContext`, `FnSurface`/`FnArgs`/`FnReturn`, `ApiOperations`, `AuthOperations`,
`AdminOperations` (+ `RootInfo`/`NsInfo`/`DbInfo`/`TableInfo`). New modules: `orm/raw.ts`,
`orm/context.ts`, `orm/fn.ts`, `orm/api.ts`, `orm/auth.ts`, `orm/admin.ts`,
`orm/types/{raw,context,fn,api,auth,admin,client}.ts` (the typed `Client`/`BetterSchemicOptions` facade
left the runtime). Types: `orm-m5.assert.ts` + the budget
`Client<S>` (75,476 instantiations).

**Quality pass (post-M5):** the executor gained the `runScript` primitive (`USE` prefix,
transport-error normalization, control offset) reused by `execute`, `$raw`/`$query` and `import` — the
latter now **propagates** the first statement with an error (it previously ignored `ERR` and "imported" silently);
`transaction({ context })` became `transaction({ meta })` (the NS/DB `context` no longer collides);
`TransactionClient` omits `export`/`import`/`version`/`$withContext` (impossible on a `SurrealTransaction`);
`client.ts` dropped from 744 → 515 lines with the facade moved to `orm/types/client.ts` and the list of
reserved names removed (the constructor order now covers the surfaces); duplicated helpers
consolidated (`contextOption`, `contextPrefix`, `terminate`, `parseDurationMs`, `killedChange`);
`caught`/live harness centralized in the tests.

Divergences recorded in the map (`docs/orm-syntax-map.md` §1/§10): `USE` scopes without leaking the session;
`fn.call` via query instead of `db.run` (session-bound); `import` via `query(dump)` (the SDK's `import()`
breaks over WS); `ping()` via `RETURN true` (`health()` does not exist on WS); `api.*` inspects the
`status` (the SDK does not reject on 4xx/5xx).

Deferred to M6 (owner of hooks/plugins): `beforeRaw`/`afterRaw`/`onRawError` and
`$state`/`$withState`/`$withoutPlugins` — DELIVERED in M6 (see above); context `meta` is
consumed by the hooks.

## M6 — plugins and hooks ✅ *(complete)*

Observation hooks (log/tracing/metrics) + `definePlugin` (transform, `operationArgs`, hooks,
`extendClient`/`extendModel`, per-delegate state) and the official F1 plugins (`rules`, `zod`) and
F2 (`timestamps`, `soft-delete`).

- ✅ **M6.1 hooks** — `hooks` at bootstrap (`betterSchemic(conn, { schema, hooks })`); families
  `before/afterQuery|Create|Update|Delete|Relate`, `before/afterRaw`+`onRawError`,
  `beforeTransaction`/`afterTransactionCommit`/`afterTransactionRollback`+`onTransactionError`,
  `onError`. Payload with `table`/`operation`/`surql`/`vars`/`data`/`where`/`result`/`durationMs`/
  `count`/`meta` (the per-call `meta` wins over `$withContext`'s); `before*` can abort, `after*`
  routes the failure to `onError`; `.explain()` does NOT fire hooks; no pipeline = fast path.
- ✅ **M6.2 `definePlugin`** — `definePlugin({ id, name?, config?, operationArgs?, setup?,
  transform?, hooks?, extendClient?, extendModel? })`; `transform` mutates `where`/`data`/`kind`
  (re-dispatch; `false` skips the op) and is SYNCHRONOUS (compilation stays eager); `operationArgs`
  typed per operation (optional) flow into `Delegate`/`Client<S,C,P>`; `setup` runs once at bootstrap
  (fail-fast `PluginError`); `$model` gained `dbName`/`relations`; `$state`/`$withState`/
  `$withoutPlugins` per delegate.
- ✅ **M6.3 F1** — `plugins/rules` (`noRawUnsafe`, `destructiveWriteWithoutWhere`, `requireLimit`,
  `requireOrderByForCursor`, `maxLimit`, `strict` → `UnknownField`; presets `safe`/`recommended`/
  `strict`) and `plugins/zod` (validates `data` of create/insert/update/upsert per table → `ValidationError`
  with the path). Subpaths `better-schemic/plugins/{rules,zod}`.
- ✅ **M6.4 F2** — `plugins/timestamps` (`app` mode stamps `time::now()` on create/update/upsert;
  `database` mode only strips the managed columns) and `plugins/soft-delete` (`delete`→`update`/
  `updateMany` with the stamped column, read filter `deleted: "with" | "without" | "only"`
  (except `findUnique`, whose `where` is the target), `deletedBy` from `meta.actor`, `restore`/
  `restoreById` via `extendModel`). Subpaths `better-schemic/plugins/{timestamps,soft-delete}`.

Typed end to end: `HookPayload`/`AfterHookPayload`/`ErrorHookPayload` (raw/transaction-specific),
`Plugin`/`PluginSpec`/`PluginContext`/`PluginState`/`Operation`, `PluginArgs`/`PluginClientExtras`/
`PluginModelExtras`. New modules: `orm/hooks.ts`, `orm/plugins.ts`, `orm/types/{hooks,plugins}.ts`,
plugins/{rules,zod,timestamps,soft-delete}.ts`. Tests: `test/unit/orm-{hooks,plugins,plugins-rules,
plugins-zod,plugins-timestamps,plugins-soft-delete}.test.ts`, `test/types/orm-m6.assert.ts` + budgets,
`orm-syntax-map.md` **unchanged**:
M6 emits no new SurrealQL.

Known DX debt carried: `soft-delete` does not filter `findUnique` (the `where` is the target — documented);
`transform` is synchronous (async belongs in a hook) — recorded in the PLAN.

## M7 — hardening, docs and release ✅ *(complete)*

Exhaustive `docs/ORM-COVERAGE.md` (runtime surface, separate from the schema `COVERAGE.md`), an ORM
reference cookbook (`examples/orm/*` + `examples-manifest-orm.json` + `test/examples/orm-reference.test.ts`),
driver README/examples, docs sweep (superseded banners), the
release entry. Landing accumulates — publishing is a separate explicit decision.

---

## Parallel track — driver schema coverage

SurrealDB DDL completeness, tracked in `packages/better-schemic/docs/COVERAGE.md`.
- ✅ **surrealdb:** full `DEFINE ANALYZER` coverage + fluent `defineAnalyzer`.
- ✅ **surrealdb:** `s.range()` (`TYPE range`), `ASYNC [RETRY] [MAXDEPTH]` events, and
  `DEFINE SEQUENCE` (`defineSequence`) now round-trip.
- ⏳ ongoing gaps: `DEFINE USER`/`CONFIG`/`API`/`BUCKET`/`MODEL`; `regex` (no encodable JS value),
  `future`/`range<T>` (the grammar doesn't parse on 3.x).

## M9 — query logger & observability ✅ *(complete)*

A built-in, zero-dependency query logger enabled with one flag (`logger: true` / a preset / a
`LoggerOptions` object / `BETTER_SCHEMIC_LOG`), observing the executor so it sees every round-trip.

- ✅ **M9.1 pretty renderer** — framed box (box-drawing + emoji), SurrealQL syntax highlighting
  (keywords/strings/records/`$binds`/`fn::`/durations/comments) with clause-aligned wrapping,
  typed/truncated/circular-safe binds, row counts (incl. the `count` scalar), colour-coded duration
  and a `🐌 SLOW` badge; `compact` and `json` formats; level gating (`debug`/`info`/`warn`/`silent`);
  `NO_COLOR`/`FORCE_COLOR`/TTY detection; `verbose` row preview.
- ✅ **M9.2 executor seam** — `runScript` emits one event per round-trip (operation/table/phase/
  statements/results/duration/context/error); threaded through `ClientRuntime`/`DelegateContext`
  (clones, `$withContext`, transactions and forks inherit it). Absent logger = zero overhead.
- ✅ **M9.3 EXPLAIN rendering** — `.explain()`/`explain: true` plans (which fire no hooks) render as
  an operator tree; the renderer accepts the structured object (`EXPLAIN FORMAT JSON` /
  `SELECT … EXPLAIN [FULL]`), the indented string (`EXPLAIN <stmt>`) and the legacy array, with
  `TableScan ⚠ full scan` / `IndexScan ✓` badges; `explain: "slow" | "all" | "analyze"` auto-explain.
- ✅ **M9.4 surface + docs** — subpath `better-schemic/logger`
  (`createQueryLogger`/`resolveLogger`); `logger` option on `betterSchemic`/`createBetterSchemic`;
  README, `docs/ORM-COVERAGE.md` §9 and `docs/orm-syntax-map.md` §11 (live-probed `EXPLAIN` shapes +
  Tests: `test/unit/orm-logger{,-highlight,-plan}.test.ts`, `test/types/orm-logger.assert.ts`.

## M10 — multi-tenancy (preset `tenant()` + runtime `tenantRls()`) ✅ *(complete)*

Row-level isolation per tenant as an official plugin — schema preset + fail-closed runtime for
privileged sessions, with zero-diff for anyone who already wrote the recipe by hand.

- ✅ **M10.1 preset `tenant(principal, options?)`** — typed column `record<principal>`
  (`DEFAULT $auth.id` / `ASSERT $value != NONE` / `READONLY`), permissions per op
  (`<col> = $auth.id`; soft delete with the `$before` clause; `createOnly` → `update NONE`), guard
  event `{table}_protect_<col>`, indexes `{table}_<col>_idx` / `{table}_<deleted>_idx` and
  `meta.tenant`; options `column`/`softDelete`/`createOnly`/`protect`/`indexes`/`names`.
- ✅ **M10.2 runtime `tenantRls(options?)`** — `TenantRequired` fail-closed before compiling,
  scope injection on create/upsert (and on `update` with `mode: "replace"`, whose `READONLY` field
  must be present), `Operation.scope` ANDed into EVERY read (including the id/unique targets of
  `findUnique`) and write (including singular targets by id/unique), `$forTenant(...)` via
  `extendModel` (state namespaced by the plugin id), `TenantViolation` for divergent
  payload/where/patch, bootstrap validation (record-link column + tombstone) and fail-closed refusal of
  the `INSERT … ON DUPLICATE` paths (no `WHERE`).
- ✅ **M10.3 small, backward-compatible extensions** — `{table}` placeholders in preset
  event/index names, `TablePreset.meta` → `TableConfig.meta` (opaque; emit/snapshot/diff ignore it),
  `surql.ident(name)` (escaped identifier) and the codes `TenantRequired`/`TenantViolation`
  (403) + `isTenantViolation`.
- ✅ **M10.4 tests + docs** — unit (preset/runtime/compiler/`surql.ident`), types (`@ark/attest`),
  `README`,
  `docs/orm-syntax-map.md` §2, `docs/ORM-COVERAGE.md` §7/§8, `docs/COVERAGE.md`, CHANGELOG.

Out of scope (documented): `relate*`/`live`/raw and `$withoutPlugins()` (the boundary is the database
permission / the explicit escape). `findUnique` is scoped like any read (id target and unique
field), and `insert({ onDuplicate })`/`upsertMany` by ids are fail-closed refused (the
`INSERT … ON DUPLICATE` lowering has no `WHERE`).

## M11 — `upsertDelta` (create-or-update with decoded delta) ✅ *(complete)*

An **additive** write: `delegate.upsertDelta(args)` creates-or-updates in ONE round-trip and returns the
resulting row, the previous row and the field-by-field delta of **decoded** values —
`RETURN VALUE { before: $before, after: $after }` in the SAME statement (no read-then-write race).

- ✅ **M11.1 API + types** — `UpsertDeltaArgs` (`where?` id/UNIQUE, `data` XOR `create`+`update`,
  `mode` without `patch`, `onMissing: "create" | "throw"`, `timeout`) and `UpsertDeltaResult<TD>`
  discriminated by `created` (`before`/`delta` narrow on their own; `changed` typed as
  `DeltaKey<App<TD>>[]`); `FieldDelta`/`DeltaKey` exported from `/orm`.
- ✅ **M11.2 lowering + probes** — target by `where`, inferred from `data.id` or a target-less create
  (`CREATE`, id per `idStrategy`); envelope in EVERY lowering; `onMissing:"throw"` compiles
  `UPDATE ONLY t:id`/`UPDATE t … WHERE uniq` and a result without an envelope becomes `ResultNotFound`;
  distinct expressions and branches via LET/IF with envelope+TIMEOUT PER BRANCH; live-probed facts
  (3.2.0) in `docs/orm-syntax-map.md` §2.3.1 + `UPSERT DELTA` probes (117 in total).
- ✅ **M11.3 runtime** — `delta.ts` (`equalAppValue`/`computeFieldDelta`: `Date`, SDK values'
  `.equals()`, `Uint8Array`, recursive arrays/objects; never `JSON.stringify`); decode of the
  envelope in `writes.ts` (each side decoded by the table's codec; absent `before` = create).
- ✅ **M11.4 integration** — hooks (update family, write payload), `tenantRls` (injection/scope +
  strict cross-tenant → `ResultNotFound`), `timestamps` (updatedAt in the delta), `zod`, logger;
  `upsert` untouched (SQL, types and behavior).
- ✅ **M11.5 tests + docs** — unit (lowering/guards/decode), live (contract, codecs, strict,
  concurrency, transaction), types (`@ark/attest`), syntax probes; README, `ORM-COVERAGE.md`,
  syntax map, CHANGELOG, cookbook (`examples/orm/writes.ts` + regenerated manifest).

## M12 — alpha.7 frictions: strict upsert by default + create-optional `$value` + `computes` ✅ *(complete)*

A DX pass over the four frictions found in alpha.7's `apps/core` — dangerous
defaults become explicit, the `upsert` contract stops lying and `$value` stops requiring
flags in the common case.

- ✅ **M12.1 create-optional `$value` + guard** — `$value(expr)` becomes create-optional by default
  (mirrors the runtime `.create` schema, which already marked every `VALUE` as optional); an expression
  that READS `$value` must declare `{ optional: false }` (a transform that requires input) or
  `{ optional: true }` (the DB can compute without input) — with no explicit choice and no
  `$default`/Zod-optional, authoring throws a teaching error (the TYPE does not read the expression text).
  `{ optional: false }` also tightens the `.create` schema. `sc pull` emits `{ optional: true }`
  when the pulled `VALUE` reads `$value`; `readsClientValue` shares the detection.
- ✅ **M12.2 `computes`** — `$value(…, { computes: […] })` marks the nested keys that the
  parent expression fills as create-optional PER ITEM (`Create<>`/`CreateData`/`create()` +
  schema `.create`), typed against the element (typos/scalar fields fail at authoring). The flags
  `computes:<key>` travel in a type-only brand (`~szFlags`) read by property — immune to
  structural inference; no DDL and no `sc pull`.
- ✅ **M12.3 strict upsert + honest contract** — `onMissing: "create" | "throw"` (default
  `"throw"`) on both upserts: a non-existent or filtered target (permission/scope) rejects
  `ResultNotFound` instead of silently creating or resolving `null`; `UPDATE ONLY t:id` /
  `UPDATE t … WHERE uniq`; `create`+`update` requires `onMissing: "create"`; strict `return: "none"`
  compiles row-returning (observable miss) and `return: "diff"` is refused; `return: "after"` in create
  mode that writes no row also rejects. `upsertMany` is unchanged (insert-style).
- ✅ **M12.4 tests + docs** — unit (lowering/guards/decode/miss), live (strict by default,
  real miss, cross-tenant, idStrategy, concurrency, transaction), types (`@ark/attest`), syntax
  probes (`UPDATE ONLY` miss → NONE, `UPDATE … WHERE` miss → []), README, `ORM-COVERAGE.md`,
  `orm-syntax-map.md` §2.3/§12, `COVERAGE.md`, CHANGELOG, cookbooks + regenerated manifests.

## M13 — alpha.8 frictions: optional `upsert` target (parity with `upsertDelta`) ✅ *(complete)*

A DX pass over the `apps/core` friction: both upsert APIs now resolve the target the
same way, so save routes swap `upsertDelta({ data })` for `upsert({ data })` — one
call, no branch and no cast, without the cost of the delta envelope.

- ✅ **M13.1 shared target** — optional `where` in `UpsertArgs`; `resolveUpsertTarget` (extracted
  from the delta) resolves `where` > `data.id` > no target; `where.id` differing from `data.id` is a
  `ValidationError`; non-unique `where`/`{ id: undefined }` remains `UniqueTargetRequired`.
- ✅ **M13.2 target-less lowering** — `compileUpsert` gains the `target === undefined` branch: `CREATE`
  (target per `idStrategy`, `only`/`return`/`timeout` from `create`); with `return:"after"`, a create
  filtered by permission/scope → `ResultNotFound`; guards shared
  (`assertTargetlessCreate`) with the delta: explicit `"throw"`, distinct branches and a target-less `mode`.
- ✅ **M13.3 honest miss** — `WritePlan.strictMiss` (set only by the strict lowerings) decides the
  `upsertMiss`/`deltaMiss` message; a filtered target-less create no longer claims
  `onMissing:"throw"`.
- ✅ **M13.4 tests + docs** — unit (lowering/guards/decode/miss/idStrategy/tenant), live
  (target-less create, strict `data.id`, miss, create-or-update, MERGE with equal id), types
  (`@ark/attest`), syntax probe (`UPDATE ONLY t:id MERGE { id: t:id }`), README,
  `ORM-COVERAGE.md`, `orm-syntax-map.md` §2.3/§12, CHANGELOG, cookbook + regenerated manifest.

## M14 — create-only (append-only) tables: preset `createOnly()` + runtime `createOnlyGuard()` ✅ *(complete)*

Append-only tables declared in the schema: `update` blocked in the database (`FOR update NONE`), fail-fast
client-side guard for privileged sessions and `updatedAt` suppressed by `timestamps()`.

- ✅ **M14.1 preset `createOnly({ hard? })`** — permissions `FOR update NONE` (AND-narrowed with the
  table's), opaque marker `meta.createOnly`, opt-in hard event `{table}_create_only`
  (`WHEN $event = 'UPDATE' THEN { THROW … }`) that runs WITHOUT permission checks (blocks root/raw/
  `$withoutPlugins()`); the `tenant(…, { createOnly: true })` preset now stamps the same marker.
- ✅ **M14.2 runtime `createOnlyGuard({ tables? })`** — the entire update family + `insert` with
  `onDuplicate: "update" | map` rejected BEFORE compiling (`CreateOnlyViolation`, 403,
  `isCreateOnlyViolation`) with a teaching hint aware of the hard event; `tables` fallback for schemas
  without a preset (pulled/schemaless); tags cached by `SchemaIndex` (WeakMap, hot path = 1 `Map.get`).
- ✅ **M14.3 `timestamps()` interop** — a create-only table never gets `updatedAt` (create or
  bypassed update), regardless of plugin registration order (marker read in the transform).
- ✅ **M14.4 tests + docs + parity fix** — unit (preset golden/AND-narrowing/runtime/interop/
  errors), types (`@ark/attest`), (event round-trip; INFO's `what` normalized from `Table` → string, fixing a phantom-diff
  pre-existing in ANY table with an event); README, `ORM-COVERAGE.md` §7/§8, `COVERAGE.md`,
  `orm-syntax-map.md` §2.5, CHANGELOG.

## M15 — string ids: the ORM surface speaks bare strings (RecordId only on the wire) ✅ *(complete)*

The `apps/core` friction: `extractId`/`toBareRecordId`/local codecs at every call site. String-id
mode lets the APP read/write bare strings (`01M…`), keeping `RecordId` only on the wire/DB —
**DDL unchanged** (zero migration).

- ✅ **M15.1 per-field mode (`RecordIdField.stringIds()`)** — the schema becomes a codec
  (wire `string | RecordId`, app `BareId<T>` phantom-branded with the target table); decode normalizes
  `table:id`/`table:⟨id⟩`/`RecordId` with `splitRecordId` + unescape (fixing the latent
  double-escape of escaped ids in `recordTarget`/RELATE), encode always `RecordId(table, bare)`;
  `targets` and `valueType` validation retained; `.type()`/`rebuild` preserve the mode.
- ✅ **M15.2 per-table sugar (`TableDef.stringIds()`)** — flips the id + every record field in the
  shape (nested objects/arrays, wrappers, unions with record), keeping the DDL byte-identical;
  multi-target (`s.recordId([A,B])`) and open target throw a teaching error (a bare string cannot name the
  table on encode); `.default()`/`.catch()` (which carry a fallback value) are authored AFTER
  `.stringIds()`; `TableDef.record()` inherits the mode (and the `tenant()` preset with it);
  `RelationDef.stringIds()` flips edge + in/out + id, and `.from(User)`/`.to(Post)` inherit a single
  string-id endpoint; RELATE accepts a bare endpoint when the direction declares ONE table.
- ✅ **M15.3 ORM runtime** — `where` binds (equals/in/contains/not/any/all and plugin scope)
  coerce string→`RecordId` by the column's target; writes (create/update/upsert/upsertDelta/
  updateEach/relate) normalize nested data via codec + target fallback; cursor coerces by keyset
  column (`record` → `RecordId`, `datetime` → `DateTime`) and returns `nextCursor`/`previousCursor`
  in the app representation (bare id in string mode; raw `DateTime` keeps ns); includes/FETCH decode
  bare refs; `ColumnMeta.record.stringIds` exposes the mode to the runtime.
- ✅ **M15.4 types** — `BareId<T>`/`RecordIdTable<T>` phantom (a plain string remains assignable),
  `RecordIdName` resolves the target table in the brand (`is`/`some`/`every`/`none` relations preserved),
  `CreateData`/`UpdateData` accept `string | RecordId` (nested), `CursorInput` likewise,
  `TenantField` follows the principal's mode.
- ✅ **M15.5 tests + docs** — unit (codec/DDL identity/deep map/relations/tenant; where/write/cursor
  goldens), live (create/where/cursor/tuple/upsertDelta/include/RELATE + probes in
  `orm-syntax.test.ts`), types (`orm-string-ids.assert.ts`), cookbook `examples/orm/string-ids.ts` +
  manifests, README, `ORM-COVERAGE.md` §11, `COVERAGE.md`, `orm-syntax-map.md` §12, CHANGELOG.
  Documented: raw `db.query()`, `live` and `changes` still return `RecordId`; `sc pull` does not
  recover the mode (like `idStrategy`).

## M17 — closing the ORM completeness gaps ✅ *(complete)*

Eleven surface gaps mapped against the real server (3.3.4) and closed — each with a
live probe, because three of them were **silently wrong answers** (the most expensive thing in
a reporting API).

- ✅ **M17.1 `aggregate` accepts its own alias** — `groupBy` validates the output key **or** the projected
  path (the server accepts both spellings, live 3.3.4); `select: { customerName: "customer.name" }`
  + `groupBy: ["customerName"]` is no longer rejected by an error telling you to add
  `customerName: "customerName"`.
- ✅ **M17.2 aggregate operand validated against the schema** — `math::*` is **number-only** and the
  server responds `0` (sum/avg), `{}` (median) or `null` (min/max) for string/link/array/
  nonexistent **without any error**; `aggregate` rejects with the alternative that works
  (`array::min(array::group(…))`, `split`, or `{ collect }`). A report with a wrong
  `{ sum: "x.y" }` stopped showing R$ 0,00 and became a compile error.
- ✅ **M17.3 `aggregate({ split })` — UNWIND + GROUP** — the split goes into an inner subquery
  (the server evaluates `SPLIT` before `GROUP`, and `SELECT *` does not expose the element's fields), with
 grouping on the outside; each `select` entry is re-mapped to the reserved column the subquery
  projected. `where` filters the **parent** (per-element filtering remains a `surql` recipe with
  `array::flatten` — `SPLIT <expr>` is evaluated per element, live 3.3.4).
- ✅ **M17.4 automatic `SPLIT` idiom** — the split field becomes a reserved column
  (`_split_<field>`) when `select` does not include it; an **alias** satisfies the server's idiom
  (live 3.3.4), so `findMany({ select: { … }, split })` works without projecting the field by hand.
- ✅ **M17.5 array markers in `data`** — `{ append }` (`+=`, append **without dedup**), `{ remove }`
  (`-=`, remove **all** occurrences), `{ union }` (`array::union`, the only form that
  deduplicates) and `{ at: { index, value } }` (`f[n] =`), each ONE server-side write — which
  keeps the array's UNIQUE index correct. Target validated (family `array`/`set`, never `id`).
- ✅ **M17.6 composite UNIQUE target** — a `where` covering **all** fields of a composite UNIQUE
  index is a valid target (`findUnique`/`upsert`/`upsertDelta`); a partial `where` remains
  refused (it matches multiple rows) and the message names the group — the multi-tenant
  near-miss (`email` unique *within* the tenant).
- ✅ **M17.7 `plugins/hard-delete`** — `delete` stays a physical DELETE, with the destructive
  intent explicit in the operation (`meta.hardDelete`), `tables`/`reason` optional; `soft-delete` gained
  `tables` so the two compose in a mixed schema.
- ✅ **M17.8 `fn.expr` + `search::rrf`** — the **fragment form** of the `defineFunction` catalog
  (`fn::jw($p0, …)` as a `Surql`, binds fused into the composing statement) enters a typed
  `where`/`select`/`orderBy` without `$query`; `search::rrf` (the RRF half of a hybrid
  search, whose other half is already `matchesFullText`) joined the `fn.ts` catalog with a live probe.
- ✅ **M17.9 `$raw` does not swallow statements** — an N-statement script is rejected with an error
  pointing to `$query` (which returns the tuple), instead of resolving the first result and discarding
  the rest silently (a leading `LET` used to become `null` with no error).
- ✅ **M17.10 `cursor` tiebreaker in the TYPE** — `.index(name, [field], { unique: true })` registers the
  field in `TableDef`'s third parameter, and `CursorArgs.orderBy` only accepts orderings whose
  last field ∈ `id ∪ uniques` (a composite index does not count: the fields are unique only together).
  The runtime guard (`CursorTiebreakerRequired`) remains a safety net for indexes coming from `config`.
- ✅ **M17.11 tests + docs** — unit (goldens in `orm-reads`/`orm-writes-projection`/`orm-raw`/
  `orm-fn`/`orm-plugins-hard-delete`), types (`@ark/attest`: array markers and tiebreaker),
  live (split idiom, UNWIND+GROUP, array markers, composite target, `fn.expr`, `search::rrf`),
  `orm-syntax-map.md` §2.4.2/§2.4.3/§3.1/§9, `ORM-COVERAGE.md`, README, cookbook
  `examples/orm/{reads,writes}.ts` + manifest (55 entries), CHANGELOG.
- ✅ **M17.12 `when`/`else`/`coalesce` adjustment modifiers** — the `when` guard (a `surql`
  evaluated on the server) turns the marker into `SET f = IF <g> THEN <effect> ELSE <else> END`,
  still ONE server-side write; `else` is the fallback branch (`"keep"`, `"throw"` which aborts the
  whole statement — `updateMany` included — or a value/`Surql`) and `coalesce` seeds an array that is
  `NONE` (`array::union(f ?? $c, $p)` / `(f ?? $c) + $p`), only on `union`/`append`. `when` is
  rejected on `{ at }` and `else` without `when` is a `ValidationError`; the six `AdjustmentLowering`
  operators are unchanged. Unit (goldens + decision table), types, live probes §2.4.2,
  README/cookbook, CHANGELOG.

## M16 — write projections (`select`/`omit`) + numeric adjustments (`{ increment }`/`{ decrement }`) ✅ *(complete)*

A DX/performance pass on the RETURN of writes: every row-returning operation accepts the SAME
projection as reads, and counters adjust via a server-side read-modify-write (no lost update).

- ✅ **M16.1 surface** — `select`/`omit` on `create`/`createMany`/`insert`/`insertMany`/`update`/
  `updateMany`/`patch`/`upsert`/`upsertDelta`/`upsertMany`/`delete`/`updateEach`/`relate`/
  `relateMany` (`WriteProjection`); `select`+`return:"diff"` → `ReturnNotSupported`.
- ✅ **M16.2 lowering** — the server carries the projection in its own `RETURN <proj>` (nested paths,
  aliases, expressions, `*`; `RETURN … OMIT` is a parse error — omit goes client-side); BEFORE/`delete`/
  `upsertDelta`/`create.relate` decode the whole row and project client-side (expression
  entries → `ReturnNotSupported`); `updateEach.select` now also uses the server's RETURN.
- ✅ **M16.3 `increment`/`decrement`** — `data: { balance: { decrement: 10 } }` → `SET balance -= $p`
  (one round-trip); merge flattens nested objects into leaves (`SET address.city = $p`) to preserve
  deep-merge semantics; `set` keeps top-level assignments; operands number/bigint/`Decimal`/expression;
  target validated (known numeric field, never `id`); create payloads (create/insert/relate/
  `onDuplicate`/`upsertMany.update`/create branch) → teaching `ValidationError`; the `zod` plugin
  validates the OPERAND (substitutes the wrapper).
- ✅ **M16.4 types** — results driven by the args literal as in reads
  (`ResultOf`/`WriteResultOf` in `CreatedResult`/`WrittenResult`/`UpdatedResult`/`DeletedResult`/
  `BatchWriteResult`/`UpsertDeltaResult`, including `record`/`before`/`delta`/`changed`);
  `UpdateWriteData` accepts `Increment`/`Decrement` only on numeric fields; `CreateData` remains without
  markers.
- ✅ **M16.5 tests + docs** — unit (`test/unit/orm-writes-projection.test.ts`), live (probes
  `WRITE PROJECTIONS`), types (`orm-writes.assert.ts`); README,
  `ORM-COVERAGE.md` §2, `orm-syntax-map.md` §2.4.1/§2.4.2 (125 probes), CHANGELOG, cookbook
  `examples/orm/writes.ts` + regenerated manifest.

## M18 — a single package (`better-schemic`) ✅ *(complete)*

The monorepo had 5 packages (`core` + `cli` + `surrealdb` + the `better-schemic` alias + the
scaffolder). Because the project is **SurrealDB-only**, the driver/CLI/engine decoupling cost
a real price (5 manifests, `workspace:*` pins, 5-package lockstep release, a 20-line alias) without
buying anything: the driver was never pluggable.

- ✅ **M18.1 single runtime** — `packages/better-schemic` now contains the engine (`src/core`), the CLI
  (`src/cli`) and the SurrealDB driver (`src/surreal`); the bundle boundaries become the `exports`
  entries (`/connection`, `/orm`, `/query`, `/config`, `/plugins/*`, `/driver`, `/core`), and the
  authoring entry (`better-schemic`) stays **side-effect-free** (emit/diff does not enter the app
  bundle).
- ✅ **M18.2 static CLI** — the driver is built in (imported once by the CLI entry): no
  dynamic loading by name, no resolution of another package's compiled entry. `init`/`diff`
  lost the `--driver` flag (the build is SurrealDB-only) and `init` stopped bootstrapping via
  `create-better-schemic` (the driver is already installed).
- ✅ **M18.3 internal dependencies** — `zod` and the `surrealdb` SDK became **dependencies** of the
  package (not peers): the app installs `better-schemic` and that's it — `s.*` extends Zod's builders, and a
  second copy would break `instanceof`. Raw Zod comes from the same package (`import { z } from
  "better-schemic"`), guaranteeing a single copy.
- ✅ **M18.4 scaffolder** — `create-better-schemic` dropped `--driver` (only SurrealDB exists) and
  resolves the installed package's bin from its own `package.json` (no hardcoded path).
- ✅ **M18.5 release + tooling** — 2-package lockstep release (`release.ts` with no `core` pin),
  `land.ts` pointing at the new layout, and the old packages
  (`@better-schemic/core`, `@better-schemic/cli`, `@better-schemic/surrealdb`) deprecated
  on npm, pointing to `better-schemic`.
- ✅ **M18.6 docs** — `AGENTS.md`, root README, package README, `docs/engine/*` (the driver
  onboarding docs became historical) and the `docs/MIGRATION-one-package.md` guide mapping the old
  → new layout.

## M19 — typed graph traversal on the ORM 🚧 *(in progress)*

Initial slice delivered: `delegate.from(anchor).graph(g => g.out(E).in(E).both(E)…)` compiles to a single
`SELECT [DISTINCT] VALUE <path> FROM ONLY <anchor>` and decodes the resulting node array.

- ✅ **M19.0** anchor + builder skeleton + runtime compilation (`src/surreal/orm/graph.ts`, `src/surreal/orm/compiler/graph.ts`).
- ✅ **M19.1** `.out`/`.in`/`.both` chaining with schema-checked direction (runtime resolve via `resolveEdge` + edge config targets).
- ✅ **M19.2** `.select` (object + callback via `FieldRef`/`fragOf`) + `.distinct()`.
- ✅ **M19.3** per-hop `where` (edge/target split via `classifyWhereByOwner`) + final `.where` (object or callback `Expr`).
- ✅ **M19.4** tagged-template `.traverse\`…\`` (runtime-parsed path).
- ✅ **M19.5** recursion (`.repeat` + collect/paths/shortest), edge steps (`.outEdges/.inEdges/.bothEdges` + `.node()`), `.match` (where + select), polymorphic-union targets (via target list).

### ORM gaps for agents/AI — delivered ✅

The full mapping is in `packages/better-schemic/docs/ORM-COVERAGE.md` §§12–13 and in the package
README. None of these items is "AI-native" in itself — they are the pieces that make the ORM work well for
agents. There is no claim of an LLM-facing query API, MCP/GraphQL or OTel metrics.

- ✅ **`describeSchema()` / agent-readable descriptor** — `orm/describe.ts` derives from the `SchemaIndex` + defs a JSON-safe object (columns, types, asserts/default/computed, indexes, events, permissions, relation endpoints, functions and plugin `meta` tags). No DDL and no DB. Test: `orm-describe-schema.test.ts`.
- ✅ **Server-free SQL preview (`.toSQL()`) + write dry-run** — `execute.ts::sqlPreview`/`statementParts` share the logic with the executor; `.toSQL()` on reads and `delegate.$sql.<op>(args)` on writes (compile-only, plugin transform applied). `.explain()` remains server-backed and separate. The migrations "shadow/dry-run verify" gate remains open in `docs/RELEASE-MATURITY.md`. Test: `orm-sql-preview.test.ts`.
- ✅ **Declarative policy DSL on the ORM** — `better-schemic/plugins/policy` (`definePolicy`) with `deny`/`scope`/`require` effects, table names typed from the schema and `PolicyDenied`/`PolicyRequired` (403). The authorization boundary remains the database permission (or `$withoutPlugins()`). Test: `orm-plugins-policy.test.ts`.
- ✅ **Semantic layer** — `defineMetric`/`defineGlossary`/`lineage()` in `orm/semantic.ts`: metrics typed against the table, lineage validated by declared fields (no SQL parsing), JSON-safe glossary; compiled via the existing `aggregate`, with no new DDL. GraphQL and AI integrations remain out of scope in `docs/engine/SURREALDB-FEATURE-MAP.md`. Test: `orm-semantic.test.ts`.

## M20 — Bun AOT DX 🚧 *(in progress)*

Authoring and ORM surface tuned so `bun build --compile --aot` generates a fixed layout on hot
paths, with no workarounds in the consuming app (baseline `--explain=json`: 49,143 slow-path causes,
cause #1 in the generic table helper).

- ✅ **M20.1 fluent table builder** — `table(name, shape).extend(meta).extendIf(cond, meta).use(preset).index(...).stringIds().build()`. `TableBuilder` is an alias of `TableDef` (zero breakage); the generic spread leaves the app and happens inside the library, compiled once. Concrete-literal guards retained. Tests: `aot-builder.{assert,test}.ts`.
- ✅ **M20.2 idempotent presets** — `.use()` accepts identical columns already present (runtime + type); `CheckPresetIdempotent`, `MergePresetShape`, `ApplyPreset`, `useUnchecked`, `useAs`. Type toolkit exported from the root entry (`AnyTableDef`, `AnyTableRef`, `WithSmartId`, `RejectNoDdl`, `RejectBadId`, `CheckPreset`, `PresetCols`, `Fields`, `ZShape`, `PresetColumns`). Tests: `aot-presets.assert.ts`, `table-preset.test.ts`.
- ✅ **M20.3 static ORM surface** — typed `OrmSurface<S,C,P>` and `sc generate:orm`, which generates **static** getters in source (what AOT requires) with `satisfies OrmSurface`. `ClientRuntime` now declares + assigns each member explicitly (previously `Object.assign`). Tests: `aot-orm-surface.test.ts`.
- ✅ **M20.4 cache and late binding** — `createOrmClientFactory({cache:'weak'})` with `peek`/`dispose` (replaces the app's `WeakMap`), lazy `orm(() => conn, …)`, `setClientResolver`/`clientRef`. Tests: `aot-orm-surface.test.ts`.
- ✅ **M20.5 write inference** — `NoInfer` + stable overload on `upsertDelta`, public helpers `UpsertDeltaFor`/`InferWriteResult`/`RowOf`, `Record<string, unknown>` floor when the def is shape-erased. Test: `aot-upsert-delta.assert.ts`.
- ✅ **M20.6 `unknown` boundary** — `TypedBoundQuery<B,R>`/`surqlWith` (typed binds + result, overload on `$query`), `selectQuery(from, allowlist)` (rows with fixed keys from a projection), `s.json<T>()`, `s.regex(string, flags?)` with `RegExp` compiled once in the library. Tests: `aot-raw-json.assert.ts`, `aot-regex-json.test.ts`.
- ✅ **M20.7 zod-compiler — AOT validators for `s.*`** — `sc compile` generates a synthetic module with the `field.schema`s, runs `zod-compiler generate` and writes `.better-schemic/schema.aot.ts`. Compilation preserves identity (zod-compiler mutates the original object): DDL, `.shape`, `instanceof`, `z.toJSONSchema()` and the ORM are intact; only validation gets the fast path. Subpaths `better-schemic/aot` (bridge) and `better-schemic/plugin` (`betterSchemic()`, `zod-compiler/bun` adapter for `Bun.build`). Test: `aot-compile.test.ts`.
- ✅ **M20.9 declarative generators + `sc generate`** — `defineConfig({ resolve, generators, generated })`; one command runs all generators (`--only`, `--watch`, `--config`), resolves paths against the root, applies `resolve.alias` in the CLI's jiti (no symlink), emits the directives in generated files and installs the bootstrap via `installVia: 'orm'`/`importIn`. `sc generate:orm`/`sc compile` become single-generator aliases; the hidden `generate` alias of `gen` was removed. Tests: `generate-config.test.ts`, `cli-smoke.test.ts`.
- ✅ **M20.10 library-controlled Zod specifiers** — subpaths `better-schemic/zod` and `better-schemic/zod/core`; `sc compile` rewrites the zod-compiler header (`from "zod"`, `from "zod/v4/core"`) to them, eliminating the app's direct `zod` dependency and guaranteeing a single copy. `generated.zodSpecifier` allows opt-out. Test: `zod-specifier.test.ts`.
- ✅ **M20.11 generated-artifact conventions** — centralized, idempotent `@ts-nocheck`/`eslint-disable` directives; `generated.knip`/`knipAutoWrite` merge ignores into `knip.json`, `tsconfig.json`, `bunfig.toml` and `.gitignore`. Test: `generated-directives.test.ts`.
- ✅ **M20.12 `s.json<T>()` semantics** — `s.jsonValue<T>()` really parses to `T` on decode and stringifies on encode, with identical DDL; `s.json<T>()` keeps the legacy behavior (JSON string) now documented. Tests: `json-value.test.ts`, `json-value.assert.ts`.
- ✅ **M20.13 consumer lint rules in the library** — `bunfig.toml` at the root with the consumer's ruleset, plugins and 9 overrides; `bun lint`/`bun run lint` green. 43 rules previously `off` were enabled (explicit typing, `unbound-method`, `only-throw-error`, `prefer-nullish-coalescing`, etc.); only the 12 the ruleset itself recommends leaving disabled for ORM remain `off`. ~43k violations fixed in src, tests and scripts (Prettier, type/import sort, regex `u`, comments, `any`/unsafe, `curly`, magic numbers), with justified inline disables only where refactoring would change behavior. `bun test` + `bun check` remain the behavior gate.
- ⏳ **M20.8 in-app validation** — measure `build:aot:explain-json`, `bun check` and `test:changed` in the consuming app after bumping the version; apply the migration to the new API (now without `scripts/generate.ts`, the `@` symlink, manual directives or direct `zod`).

## Removed (deliberate decision)

In a slimming pass to free the ORM for large changes, the following were removed entirely:

- **Live queries / changefeeds** — runtime (`live.ts`, `changes.ts`, compilers, types), API on the client/delegate, `DEFINE TABLE … CHANGEFEED`, tests, examples and docs. The ORM keeps reads/writes/relations/transactions/raw/plugins.
- **Heavy verification gates** — coverage (`scripts/coverage/*`, `coverage.config.json`), MC/DC (`scripts/mcdc/*`, configs, manifest), mutation (`scripts/mutation/*`, Stryker), type-bench (`scripts/type-bench.ts`, budgets), the corresponding CI jobs and parity/e2e/live suites. What remains: `bun test` (unit + PBT + fuzz), `bun check`, `bun build` in the single gate.

Intention: revisit the robustness of these tests in the future, after the ORM changes.
