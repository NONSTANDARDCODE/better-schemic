# Changelog — better-schemic

All notable changes to the better-schemic packages (`@better-schemic/core`, `@better-schemic/cli`,
`@better-schemic/surrealdb`, `create-better-schemic`, `better-schemic`) are recorded here. The packages release
**in lockstep** (one version across all five), so this is a single changelog.

> **Fork notice.** better-schemic is a **SurrealDB-only** fork of
> [Schemic](https://github.com/NONSTANDARDCODE/better-schemic), forked from schemic commit
> [`720ada2`](https://github.com/NONSTANDARDCODE/better-schemic/commit/720ada27d3995ac96bd2000289bacb895bd9c06e).
> The pre-fork history is preserved frozen in [`CHANGELOG_OLD.md`](./CHANGELOG_OLD.md) for
> reference — no new entries go there. The fork restarts version numbering at `0.1.0-alpha.1`.
> That section carries over everything that was unreleased in the OLD changelog at the fork
> commit, plus the fork's own changes.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Changes **accumulate** under
**Unreleased** and are stamped into a version section on release cut. Entries are tagged by package
(**core** / **cli** / **surrealdb** / **setup**).

## [Unreleased]

### Added
- **surrealdb:** built-in query logger (M9) — enable it with one flag
  (`betterSchemic(conn, { schema, logger: true })` / `"pretty" | "compact" | "json" | "silent"` /
  a `LoggerOptions` object, or the `BETTER_SCHEMIC_LOG` env var). It observes the executor (every
  round-trip: delegate reads/writes, `$raw`/`$query`/`$unsafe`, `fn`, admin, changes, live and
  `.explain()` — which fires no hooks), rendering a framed, syntax-highlighted box with binds, row
  counts, colour-coded timing and a slow-query badge (`compact`/`json` for log shippers). `.explain()`/
  `explain: true` plans render as an operator tree with `TableScan ⚠ full scan` / `IndexScan ✓`
  badges, and `explain: "slow" | "all" | "analyze"` auto-`EXPLAIN`s reads (`EXPLAIN [ANALYZE] FORMAT
  JSON`). New subpath `@better-schemic/surrealdb/logger` (`createQueryLogger`/`resolveLogger`); the
  `logger` option on `betterSchemic`/`createBetterSchemic`. Zero-dependency, side-effect-free when
  absent. Tests: `test/unit/orm-logger{,-highlight,-plan}.test.ts`, `test/live/orm-logger.test.ts`,
  `test/types/orm-logger.assert.ts`; docs in `README.md`/`docs/ORM-COVERAGE.md` and the live-verified
  `EXPLAIN` shapes in `docs/orm-syntax-map.md` §11.
- **repo:** MC/DC reliability tooling (M8) — `bun run test:coverage` instruments
  `drivers/surrealdb/src` + `packages/core/src` with `oxc-coverage-instrument`
  (`reportLogic` → per-operand truthiness), aggregates the e2e CLI subprocesses' coverage, and gates
  statements/branches/functions/lines **and logical conditions** per file with a ratchet
  (`coverage.config.json`). `bun run test:coverage:gaps` prints the exact uncovered lines/conditions.
  A shared ephemeral SurrealDB preload un-skips the live/parity suites. See
  `drivers/surrealdb/docs/TESTING.md` and `ROADMAP.md` §M8.
- **repo:** mutation gate (M8.4) — `bun run test:mutation` runs StrykerJS over the scoped pure
  compilers through a local **Bun `TestRunner`** plugin (`scripts/mutation/bun-runner.ts`) that shells
  `bun test` per mutant offline (a server-less bunfig, per-mutant test selection), parallelizes it
  across a dynamic pool of test-runner workers (`scripts/mutation/run.ts`), and gates the per-file mutation
  score with a ratchet (`mutation.config.json`, recorded with `bun run test:mutation:update`). Also
  wires the previously-undocumented `bun run test:coverage:gaps`. See `drivers/surrealdb/docs/TESTING.md`.
- **repo:** property-based tests (M8.5) — fast-check suites for the pure compilers/parsers
  (`drivers/surrealdb/test/property/compilers.pbt.test.ts`, `packages/core/test/property/filter.pbt.test.ts`)
  asserting injection safety, bind totality, purity and round-trips over generated/adversarial inputs.
  Budget via `PBT_RUNS`/`PBT_SEED`; the mutation gate pins both so a mutant's kill is deterministic.
  26 properties; found three real type-bridge bugs (below).
- **surrealdb:** type-bridge round-trip fixes (found by PBT) — `parseSurqlType` and the CLI
  `normalizeType` tested the greedy `option<…>` wrapper BEFORE the top-level union, so a valid union
  like `option<int> | string` was swallowed as one option (`option<int> | string` now canonicalizes
  correctly); `emitSurqlType` emitted `option<none>` for `option<never>` (now `none`, a true inverse,
  so `array<none>` round-trips); and a nullable union emitted `null` last instead of as a flat sorted
  member (`array<int> | null | set<string>`). Regression cases added to `test/unit/surql-type.test.ts`.
- **repo:** MC/DC decision inventory (M8.3b) — `scripts/mcdc/{inventory,reconcile}.ts` enumerate every
  MC/DC-relevant decision in-scope with the TypeScript compiler API and classify each `auto`
  (Tier-1) / `table` (a `describeMcdc` label in `mcdc-manifest.json`) / `unknown`, ratcheted per file
  (`mcdc.config.json`, `bun run test:coverage:mcdc[:update]`). Wired into `scripts/coverage/run.ts`, so
  the coverage job enforces it. First closing batch took `driver/surql-type.ts` branch+condition
  coverage to 100%, `surql-type-expr.ts` conditions to 100% and `unique.ts` conditions to 100%.
- **repo:** parser fuzzing (M8.7) — `test/fuzz/parsers.fuzz.test.ts` + `packages/core/test/fuzz/filter.fuzz.test.ts`
  hammer the hand-written scanners (`splitTopUnion`/`topLevelSplitOnce`, the `SurqlType` bridge,
  `formatForAssert`, `stripOuterParens`/`toFragment`, `hasTopLevelSemi`, `parseFilter`) with arbitrary
  bytes, deep nesting, huge unions and a seed corpus — asserting never-throw, never-hang and the
  idempotence/round-trips. `hasTopLevelSemi` is now exported for it. Budget `FUZZ_RUNS`; runs in the
  normal `bun test` gate.
- **repo:** CI hardening (M8.6) — `.github/workflows/ci.yml` now runs the heavy gates as separate jobs
  (the existing `gate`/`coverage`/`type-perf` plus a new offline `mutation` job), so a reliability
  regression fails the specific job with per-file detail while the hot landing gate stays fast. Method
  and tooling are documented in `drivers/surrealdb/docs/TESTING.md`.
- **core:** `@better-schemic/core/testing` — `analyzeMcdc`/`describeMcdc`: a pure, driver-agnostic
  **unique-cause MC/DC** engine. For a decision it finds, per condition, the independence pair (two
  assignments differing only in that condition that flip the outcome) over the full truth table or
  the explicit `cases` a suite exercises, and fails a named `bun:test` block on a redundant/masked
  operand. Applied to `isNotFound`/`isValidationError`/`isUnsupportedCapability` and core `inCat`.
- **surrealdb:** `ClientRuntime.query<T>(sql, vars?)` — the neutral `ctx.connections.<name>.query`
  handle (core `ResolvedConnectionHandle`) now exists on the ORM client (first statement's rows).
  Previously a chained resolver calling `ctx.connections.main.query(...)` failed with
  `db.query is not a function` — a latent bug exposed by running the live chained-config suite.
- **surrealdb:** `@better-schemic/surrealdb/orm` — the repository-style ORM surface (M0 skeleton):
  `defineSchema({ users: User, likes: Likes, greet, audit: "audit_log" })` + `betterSchemic(conn, { schema })`
  / `createBetterSchemic({ url, namespace, database, auth, schema })`; one delegate per schema key,
  `repository(name)` (schema key OR physical name), `client.tables`, `client.$sdk`, `client.$index`,
  `forkSession()`, `extends()` (fail-fast on collisions), `BetterSchemicError` + catalog +
  normalization/predicates, result wrappers (`ThrowingResult`/`BatchResult`/`StatementResult`) and the
  multi-statement executor (one round-trip via `responses()`, per-statement status, atomic
  `BEGIN/COMMIT` batches, unique-binds guardrail). Reads/writes/relations/… land in the following
  milestones — see [`ROADMAP.md`](./ROADMAP.md).
- **surrealdb:** `docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts` — the live-verified SurrealQL
  syntax map the ORM compiler must emit against (78 probes on server 3.2.x), with the prototype
  divergences recorded.
- **surrealdb:** the `/orm` **read surface (M1)** — object-based compiler + typed reads, one round-trip:
  `findMany` (where/select/omit/orderBy/limit/start/range/split/groupBy/groupAll/only/value/with/timeout/
  version), `findFirst`/`findOne`/`findUnique` (id or single-field UNIQUE index) with `.throw()`/
  `NotFoundInfo`, `count`/`exists`, `aggregate` (`_count`, `math::*` — `avg` emits `math::mean` —
  `collect`/`distinct`), `paginate` (offset + count in one round-trip; `count:false` probes n+1) and
  `cursor` (id/tuple keyset with tiebreaker), plus lazy thenables with `.explain()` / `explain: true`
  (`ExplainResult`, never executes the query). Read result types are inferred from the args literal
  (`select`/`omit`/`value`/`only`/`split`/`explain`); failures are teaching `BetterSchemicError`s
  (`UniqueTargetRequired`, `ClauseNotSupported`, `HavingUnsupported`, `CursorDirectionConflict`,
  `CursorTiebreakerRequired`). New modules: `orm/compiler/{shared,projection,where,select,aggregate,
  pagination,unique}.ts`, `orm/reads.ts`, `orm/decode.ts`, `orm/types/{where,select}.ts`.
- **surrealdb:** the `/orm` **write surface (M2)** — every mutation compiles eagerly, runs in ONE
  round-trip, and decodes its rows through the table codec: `create`/`createMany` (+ `only`, `relate`
  sugar in the same batch, `skipDuplicates`), `insert`/`insertMany` (`onDuplicate: "ignore" |
  "update" | map` with `$input` expressions), `update`/`updateMany` (modes `merge`/`set`/`content`/
  `replace`/`patch`, `unset`, `surql` expressions, `only`/`timeout`; targets a record id or a
  single-field UNIQUE index and NEVER creates — a miss resolves `null`/`.throw()`), `patch` (JSON
  Patch ops validated), `upsert`/`upsertMany` (`UPSERT`/`INSERT … ON DUPLICATE`; falls back to
  `LET`/`IF` when expressions must read the existing row; items without ids need `conflict`),
  `delete`/`deleteMany` (`RETURN BEFORE|NONE`, `all: true` for whole-table) and `updateEach`
  (one statement per item, `skipped`, `onEmpty: "throw"`, eager `select` projection). Relation
  delegates (`defineRelation`) gain `relate`/`relateMany`/`unrelate`/`unrelateMany` with endpoints
  validated against the declared `RelationDef` and `create.relate` edge `data` codec-validated
  against the edge schema. Batches return the `BatchResult` envelope (`count`/`data`/`skipped`/
  `statements`) or — with `return: 'diff'` — the flat JSON Patch ops combined across the batch's
  statements; `insert`/`upsert` with `return: 'before'` resolve the previous row (or `null` when
  created); `skipDuplicates` needs an explicit `id` per item and `upsertMany.conflict` must be a
  single-field UNIQUE index (fail-fast `UniqueTargetRequired`). `data` accepts `surql` expressions
  per field (literal fields stay codec-validated); `id` strings become `RecordId`s. New modules:
  `orm/compiler/{write,write-shared,mutate,relate}.ts`, `orm/writes.ts`, `orm/types/write.ts`.
- **surrealdb:** live-verified write semantics in `docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`
  (70 probes on server 3.2.x) and the end-to-end write suite `test/live/orm-writes.test.ts`.
- **surrealdb:** the `/orm` **relations & graph surface (M3)** — `include` hydrates relations in the
  SAME round-trip as the read: links (`true` → `FETCH` as the last clause, `{ select }` flattens to
  `<link>_<field>` aliases and remounts client-side, `{ include }` nests `FETCH a.b`), graph edges
  (`true`/`select` → per-parent `(SELECT … FROM ->edge->target)`, `edge: true` edge records,
  `{ edge, target }` remounting `{ edge, target }` per row, `direction: "out" | "in" | "both"` with
  endpoint inference, `wildcard: true` for `->?`, `where` split automatically into edge
  (`->(edge WHERE …)`) and target predicates, `orderBy`/`limit`/`start` inside the subquery) and
  `_count` (correlated `count(->edge[WHERE …])` / `count(field[WHERE …])`, NONE-safe, remounted as
  one `_count` object). The relational `where` vocabulary is typed and compiled: `is`/`isNot` for
  single links (target filter behind the link path; `isNot` true on `NONE`), `some`/`every`/`none`
  for edges and array links (`every` as a NONE-safe count-equality), with `direction` override.
  Relation typing derives from the authored schema — `S` now flows through `Delegate`/`ReadArgs`/
  `Where`/`ResultOf` (including the write batches), and `include`/`where` results are inferred from
  the args literal (links → target rows, edges → target rows, `{ edge, target }` → the remount,
  `_count` → numbers). New modules: `orm/compiler/include/*`, `orm/types/{include,relations}.ts`;
  hydration in `orm/decode.ts`. Live: `test/live/orm-relations.test.ts` (13 e2e).
- **surrealdb:** relation/graph hardening (same unreleased M3):
  - **`where` relacional em writes** — `updateMany`/`deleteMany`/`unrelateMany` compile the same
    relational lowering as reads (the schema index now flows into the write compilers); before, the
    type accepted it and the runtime rejected with `ValidationError`.
  - **link projetado sem `id`** — the compiler always projects a hidden presence leaf (`<link>.id`),
    so an absent link decodes to `null` (the declared contract) instead of `{ id: undefined, … }`;
    nested `select` objects/aliases now remount at the correct path (they were duplicated).
  - **fail-fast guards** — `direction: "both"` + `edge`+`target` (`?.*` is a parse error) and an
    empty nested `include` (used to silently emit no `FETCH`) are rejected; an edge-only include
    rejects a target-owned filter (used to drop it silently); `_count` rejects unknown options and
    `direction` on array links.
  - The relational lowering now lives in ONE place: `orm/compiler/relations.ts` (arrow/traversal/
    refs) + `where.ts` (`compileRelationFilter`), shared by `include`, `_count` and `where`.
- **surrealdb:** live-verified relation/graph semantics in `docs/orm-syntax-map.md` §5.1–5.3 +
  `test/live/orm-syntax.test.ts` (78 probes on server 3.2.x) — target records only via subquery,
  `out.*` stops at the edge (silent `{}` past `->target`), incoming flips both arrows, `NOT` inside
  a traversal filter needs parentheses, `array::len` errors on `NONE` (`count(field)` is NONE-safe),
  `FETCH` needs the link selected, subquery `ORDER BY` needs the order idiom projected, direction
  `both` (`<->edge<->target`, `<->edge`) works but `?.*` is a parse error, wildcard edge filters use
  `->(? WHERE …)`.
- **surrealdb:** the `/orm` **transactions surface (M4.1)** — `client.transaction(fn, options?)` over
  the SDK's **managed** transaction: `tx` is a full client bound to it (batches inside the tx skip
  their implicit `BEGIN`), success commits, any exception cancels and propagates; `tx.rollback(reason)`
  surfaces `TransactionRollback` (with `details.reason`; the state is the safety net even if user code
  swallows the signal); nested `tx.transaction(...)` runs in the SAME transaction and re-entry from the
  root client fails with `TransactionAlreadyActive`; `afterCommit`/`afterRollback` (the root client
  reaches the current scope; outside a transaction → `ValidationError`). Opt-in `retries`
  (`writeConflict`/`serializationFailure`/`connectionError`, backoff + jitter), a client-side `timeout`
  deadline (cancels the transaction and fails with `DatabaseError`/`details.timedOut`), `context` and
  the `isolation` policy (`onUnsupported: "warn" | "throw" | "ignore"`). `mode: "sql"` is intentionally
  NOT part of the surface (on 3.2.x `BEGIN`/`COMMIT` does not hold across separate RPC calls — see the
  syntax map) and fails fast. `errors.isSerializationFailure` joins the predicates; `BetterSchemicOptions`
  gains `transaction` defaults.
- **surrealdb:** the `/orm` **live surface (M4.2)** — `client.users.live(args?, handler?)`,
  `client.live(table, …)`, `client.liveOf(uuid, …)` and `client.kill(uuid)`: the statement is compiled
  by the ORM (`LIVE SELECT [DIFF] <projeção> FROM t [WHERE …] [FETCH …]` — binds preserved, `fetch`
  reuses the link-fetch lowering so fetched links decode through the target codec) and notifications
  come from the SDK's `liveOf(uuid)` stream, decoded with a discriminated `action` union
  (`CREATE`/`UPDATE`/`DELETE`/`KILLED` + the client-side `RECONNECTED`), fanned out to the handler and
  every async iterator with `sub.onError`, idempotent `kill()`, and automatic re-run + re-subscribe on
  the SDK's `connected` event (`live: { reconnect: false }` opts out). Live-invalid clauses
  (`only`/`value`/`orderBy`/`limit`/`group`/`split`/`include`, and `diff` + `select`) fail with
  `ClauseNotSupportedInLive`; live inside a transaction with `LiveInTransaction`; HTTP connections with
  `LiveQueryUnsupported`. `BetterSchemicOptions` gains `live` defaults.
- **surrealdb:** the `/orm` **changefeeds surface (M4.3)** — `client.changes({ table?, since?, limit? })`:
  `SHOW CHANGES FOR TABLE|DATABASE SINCE <literal>` (`since` as versionstamp/`Date`/ISO), normalized
  `ChangeSet`/`ChangeEntry` (`UPDATE` with `value`/`diff`, `DELETE` with `before`, `DEFINE`; CREATE and
  UPDATE both arrive as `UPDATE` without `INCLUDE ORIGINAL`), rows decoded through their own table
  codec (database-level reads included) and versionstamp pagination documented (`SINCE` is inclusive →
  advance `versionstamp + 1`).
- **surrealdb:** live-verified M4 semantics in `docs/orm-syntax-map.md` §7/§1 +
  `test/live/orm-syntax.test.ts` (**84 probes** on server 3.2.x, up from 78): `DIFF` placement and its
  projection ban, unsupported live clauses/`FROM ONLY`/record targets, `VALUE` emits nothing, records
  leaving the `WHERE` filter emit nothing, `KILL` forms, changefeed shapes + inclusive `SINCE` (literal
  only), managed-transaction-only behavior and the HTTP feature gaps (`Transactions`/`LiveQueries`).
  New live suites: `test/live/orm-transactions.test.ts` (7 e2e, including a REAL write conflict + retry),
  `orm-live.test.ts` (7 e2e) and `orm-changes.test.ts` (5 e2e); unit suites
  `orm-{transaction,live,changes}.test.ts`; type suites `orm-{transactions,live,changes}.assert.ts`
  plus the `TransactionClient` instantiation budget.
- **surrealdb:** the `/orm` **raw escape hatches (M5.1)** — `client.$raw<T>` (tagged template: every
  `${…}` lowers through the shared compiler primitives, so a `surql` fragment composes and a plain
  value binds as `$p<n>`; also accepts a SurrealQL string or a `BoundQuery`, with `{ timeout, meta }`),
  `client.$query` (several statements in one round-trip; `{ throwOnError: false }` returns every
  `StatementResult`) and `client.$unsafe(sql, params?, options?)` (gated by `raw: { unsafe: true }`,
  else `UnsafeDisabled`). `raw.requireComment` demands `meta.comment` on a write script and
  `raw.timeoutMs` applies `TIMEOUT` only to a single statement whose verb supports it.
- **surrealdb:** the `/orm` **database functions, APIs, auth and admin (M5.2)** —
  `client.fn.call<R>(name, args?)` compiles `RETURN fn::name($p…)` (the name is validated, never
  spliced; a bare name resolves under `fn::`) plus one TYPED shortcut per `defineFunction` entry
  (`client.fn.customerTier({ total })` — named args, lowered to the positional call). `client.api`
  (`get`/`post`/`put`/`patch`/`delete` with `query`/`headers`/`body`) unwraps the response `body` and
  throws `DatabaseError` with the HTTP `status` and the body in `details` on `>= 400`. `client.auth`
  (`signin`/`signup`/`authenticate`/`invalidate`/`record`) passes through the SDK session
  (`record()` without a record session → `NotAuthenticated`). `client.info(level, table?)` compiles
  `INFO FOR ROOT|NS|DB|TABLE`, `version()`, `ping()` (`RETURN true`), `export()` and
  `import(dump)` (replayed through `query()` — the SDK's `import()` breaks over WebSocket).
- **surrealdb:** the `/orm` **context scoping (M5.3)** — `client.$withContext({ namespace, database,
  meta? })` returns a clone that prefixes `USE NS … DB …;` on EVERY compiled operation in the same
  round-trip, so multi-tenant routing needs no global `db.use()` and never leaks the session; a
  per-call `context: { namespace?, database?, meta? }` (on every read/write arg) overrides the clone
  and the missing side is inherited from the session. Operations bound to the connection session
  (`api`/`auth`/`export`/`live`) fail fast with a teaching `UnsupportedCapability` on a prefix clone;
  `client.$withContext({ …, auth })` (Promise overload) forks a session, selects the scope and
  authenticates it. `extends` helpers are now re-applied on every clone (`$withContext`/`forkSession`)
  and on the transaction client. New `BetterSchemicOptions.raw` defaults.
- **surrealdb:** live-verified M5 semantics in `docs/orm-syntax-map.md` §1/§10 +
  `test/live/orm-syntax.test.ts` (**89 probes** on server 3.2.x, up from 84): `USE NS … DB …` scoping
  without a session leak (`USE NS` alone keeps the database; escaped identifiers accepted), `INFO FOR`
  shapes, `TIMEOUT` per verb, `RETURN fn::x($p…)`, the `ApiResponse` envelope and `health()`
  unsupported over WebSocket. New live suite `test/live/orm-raw.test.ts` (10 e2e: multi-tenant NS/DB,
  parameterized raw, `fn.call`, `DEFINE API`, admin dump/restore, forked session); unit suites
  `orm-{raw,context,fn,admin}.test.ts`; type suite `orm-m5.assert.ts` plus the `Client<S>`
  instantiation budget. New modules: `orm/{raw,context,fn,api,auth,admin}.ts` +
  `orm/types/{raw,context,fn,api,auth,admin}.ts`.
- **surrealdb:** the `/orm` **observation hooks (M6.1)** — `betterSchemic(conn, { schema, hooks })`
  registers `before/afterQuery`, `before/afterCreate`, `before/afterUpdate`, `before/afterDelete`,
  `before/afterRelate`, `before/afterRaw` + `onRawError`, `beforeTransaction` +
  `afterTransactionCommit`/`afterTransactionRollback` + `onTransactionError`, and `onError`. Hooks may
  be async; a throw in a `before*` aborts the operation, while a throw in an `after*` is routed to
  `onError` without undoing the work. Payloads carry `table`/`operation`/`surql`/`vars`/`data`/
  `where`/`result`/`durationMs`/`count`/`meta` (the per-call `meta` wins over `$withContext.meta`);
  `.explain()` never fires hooks; registering no hook keeps the zero-overhead fast path.
- **surrealdb:** the `/orm` **plugin system (M6.2)** — `definePlugin({ id, name?, version?, config?,
  operationArgs?, setup?, transform?, hooks?, extendClient?, extendModel? })`. `transform` runs before
  compilation and may mutate `where`/`data`/`args`, change `op.kind` (re-dispatching, e.g.
  delete → update) or return `false` to skip the operation (it resolves `undefined`); it is
  synchronous on purpose (a bad arg still throws at the call site). `operationArgs` adds TYPED,
  OPTIONAL args per operation to every delegate (`client.users.findMany({ deleted: "with" })`),
  `extendClient`/`extendModel` graft methods onto the client/each delegate (a name collision fails
  fast with `PluginError`), `setup` runs once at bootstrap. Delegates gain `$state`/`$withState`/
  `$withoutPlugins`; `$model` gains `dbName` and `relations`. `BetterSchemicOptions` gains `hooks`
  and `plugins`, and `Client<S, C, P>`/`TransactionClient<S, P>` fold the plugin tuple.
- **surrealdb:** the official **F1 plugins (M6.3)** — `@better-schemic/surrealdb/plugins/rules`
  (`rules`/`safe`/`recommended`/`strict`: `noRawUnsafe`, `destructiveWriteWithoutWhere`,
  `requireLimit`, `requireOrderByForCursor`, `maxLimit`, and `strict` → `UnknownField`; guardrails
  fail fast BEFORE sending, with `UnsafeMutation`) and `@better-schemic/surrealdb/plugins/zod`
  (`zod({ schemas })` validates every write `data` (batch items included) against a per-table Zod
  schema and raises a `ValidationError` carrying the issue path). New unit suites
  `orm-{hooks,plugins,plugins-rules,plugins-zod}.test.ts`, type suite `orm-m6.assert.ts` and the live
  soft-delete e2e (`test/live/orm-plugins.test.ts`). `docs/orm-syntax-map.md` is unchanged: M6 emits
  no new SurrealQL.
- **surrealdb:** the official **F2 plugins (M6.4)** — `@better-schemic/surrealdb/plugins/timestamps`
  (`timestamps({ createdAt, updatedAt, mode })`: `"app"` (default) stamps `time::now()` on
  create/insert (both columns) and update/upsert (updated-at only); `"database"` strips the
  schema-managed columns from writes) and `@better-schemic/surrealdb/plugins/soft-delete`
  (`softDelete({ column, deletedBy, actorMeta })`: `delete`/`deleteMany` compile as
  `UPDATE`/`UPDATE … WHERE` stamping the column, reads hide soft-deleted rows unless
  `deleted: "with" | "only"` is passed (`findUnique` is exempt — its `where` is the target), an
  optional `deletedBy` actor comes from `meta.actor`, and `restore`/`restoreById` clear the column via
  `extendModel`). The factories preserve their concrete type, so `deleted` and `restore`/
  `restoreById` are typed on the client. New unit suites `orm-plugins-{timestamps,soft-delete}.test.ts`,
  the F2 live e2e (soft-delete round-trip + restore, timestamps) and the `orm-m6.assert.ts` F2 block.
- **surrealdb:** `docs/ORM-COVERAGE.md` — an exhaustive map of the **runtime ORM surface** (reads,
  writes, relations/graph, live/changefeeds, raw/admin/auth/api/fn, context/multi-connection,
  hooks/plugins, types/errors), separate from the schema/DDL `docs/COVERAGE.md` and the
  `docs/orm-syntax-map.md`. Every `[x]` cites the unit/live/type tests that prove it; deliberate gaps
  (`parallel`, fuzzy, `having`, per-op `return` caps) are listed so they stay visible.
- **surrealdb:** the **ORM reference cookbook** `examples/orm/*` — a drift-proof catalog pairing a real
  delegate call with the exact runtime `{ sql, vars }` it emits (reads/writes/relations/raw-admin/
  live-changes), asserted offline by `test/examples/orm-reference.test.ts` (`capture(def) === { sql, vars }`)
  against a recording fake connection. This is a **separate** catalog from the schema cookbook
  (`examples/*`, authoring → DDL). New generated `examples-manifest-orm.json` via
  `bun run gen:examples:orm` (`scripts/gen-examples-manifest-orm.ts`), same
  `source.{commit,hash}` header for vendoring consumers.

### Changed
- **repo (tooling):** the mutation gate now runs **one** Stryker process whose worker pool schedules
  mutants dynamically across `concurrency` test-runner workers, replacing the static file sharding.
  The size-round-robin shards were imbalanced (heaviest ~1.9x the lightest, so the job waited on it)
  and paid the sandbox/dry-run/report cost once per shard; dynamic scheduling removes both with the
  same mutants, tests and per-file ratchet. Tune with `--concurrency <n>` (or `MUTATION_CONCURRENCY`);
  `--shards`/`MUTATION_SHARDS` are gone and `ratchet.ts` now reads the single `.mutation/mutation.json`.
- **repo (tooling):** the `type-perf` CI job no longer pays attest's TypeScript program cost once per
  file — it now runs **one program per package** (~11min → ~2-3min; both suites locally 1m51s).
  `scripts/type-perf.ts` passes `--experimental-test-isolation=none` to `node --test` (node ≥ 22.8;
  CI moves 20 → 24), the new `scripts/type-perf-bench.mts` imports every `.bench.ts` in one process,
  each package's `test/types/_setup.ts` memoizes attest's `setup()`, and
  `test/types/tsconfig.attest.json` narrows attest's project type-check to `test/types/` + `src/`
  (the driver's setup drops from ~100s to ~33s locally). The runner also passes `--conditions=bun`,
  so driver suites resolve `@better-schemic/core` from `src/` like the local bun run and the job no
  longer builds the workspace first. Assertions, budgets and baselines are unchanged — only the
  harness.
- **surrealdb:** plugin `setup`/`transform` are now typed **synchronous** (`transform` returns
  `void | false`, `setup` returns `void`), matching the runtime (compilation is eager, bootstrap is
  synchronous) — an `async transform` can no longer silently fail to skip an operation, nor an
  `async setup` escape the fail-fast `PluginError`. `Operation` now carries the schema `index`
  (plugins introspect fields via `op.index` instead of stashing it in a closure), and the delegate
  hook orchestration (`before`/`after`/`onError` + `count`) lives in ONE shared `runWithHooks` /
  `runWithRawHooks` helper.
- **surrealdb:** the unknown-`where`-operator teaching error now points to `docs/orm-syntax-map.md`
  (the live-verified vocabulary) instead of the internal planning document.
- **surrealdb:** the plugin brand (`PLUGIN_BRAND`) is now a literal key (`"__betterSchemicPlugin"`)
  instead of a `unique symbol`, so the emitted `.d.ts` for the `plugins/*` subpaths is nameable and the
  DTS build no longer fails with `TS4058`.

### Removed
- **repo (docs):** the design/execution plan `PLANO-QUERYS-TIPADAS.md` and the `prototipo-querys-tipadas/`
  design prototype were retired now that M0–M7 shipped — the milestone plan lives in `ROADMAP.md`, the
  runtime surface in `drivers/surrealdb/docs/ORM-COVERAGE.md`, and the live-verified syntax in
  `drivers/surrealdb/docs/orm-syntax-map.md`.
- **surrealdb:** the fluent query builder (`select`/`create`/`update`/`upsert`/`remove`/`relate`, graph
  traversal, the schemaless adapter) and the `@better-schemic/surrealdb/client` subpath (`connect`) —
  replaced by `/orm`. `/query` now ships only `block()` (fragments/procedural SurrealQL).
- **core:** `@better-schemic/core/query` (the `Row`/`Project`/`decodeProjection`/`callFunction` toolkit) —
  retired with the fluent builder; the neutral field-ref carrier moved into the driver (`src/surql/ref.ts`).

### Fixed
- **repo (tooling):** the CI `mutation` job's report artifact is uploaded again — the report lives in
  the dot-directory `.mutation/`, which `actions/upload-artifact` silently skips without
  `include-hidden-files: true`.
- **surrealdb:** `client.import(dump)` now surfaces the FIRST failing statement of the dump instead
  of resolving successfully — the dump replays through the shared executor, so a bad statement
  rejects with its normalized `BetterSchemicError` (it previously called `query().responses()` and
  ignored every per-statement `ERR`).
- **repo:** `test/live/orm-writes.test.ts` — the `create + relate return:'none'` case omitted the
  required `score` edge payload, so it failed against a real server (schemafull coercion); it now
  passes `data: { score: 0 }` like its sibling case.

### Changed
- **surrealdb:** `$raw`/`$query` gain a **curried options form** so the tagged-template path can
  carry `meta`/`timeout`: `client.$raw({ meta: { comment: "seed" } })\`CREATE …\`` (and
  `client.$query({ throwOnError: false })\`…\``). Previously `raw.requireComment` was unsatisfiable
  through the recommended template form.
- **surrealdb:** `transaction({ …, context })` is renamed to **`meta`** — `context` now means the
  namespace/database scope everywhere (`$withContext`, per-call `context`), so the hook metadata
  option no longer collides.
- **surrealdb (internal):** the executor's core is now the shared `runScript` primitive (prefix,
  transport-error normalization, response offset) reused by `execute`, the raw escape hatches and
  `import`; `client.ts` was decomposed (the typed `Client` facade + options moved to
  `orm/types/client.ts`, the reserved-name list dropped in favor of the surface-first constructor)
  and duplicated helpers were consolidated (`contextOption`, `contextPrefix`, `terminate`,
  `parseDurationMs`, `killedChange`). `TransactionClient` now omits the session-bound
  `export`/`import`/`version`/`$withContext` surfaces it cannot support. No behavior change beyond
  the items above.
- **repo (tooling):** `typecheck` now runs on the **TypeScript 7 native (Go) compiler** (`tsgo`, via
  `@typescript/native-preview`) — workspace-wide checks drop from ~4 min to ~1m20. The classic
  `typescript` devDep stays pinned at `5.9.3` because `tsup`'s bundled dts plugin and `@ark/attest`
  still consume the JS compiler API (a stable native API only lands in TS 7.1), so build/type-perf
  behavior is unchanged; `typecheck:legacy` keeps a classic `tsc --noEmit` parity escape hatch.
- **surrealdb:** `BatchResult.count` is now optional — `return: 'none'` makes the server return no
  rows, so the affected count is genuinely unknown (`undefined`) instead of a misleading `0`; with
  `return: 'diff'` the batch resolves the flat patch list instead of the envelope.
- **surrealdb:** `where` coerces string record values (`"user:aeon"`) to `RecordId` on record
  columns (including `id`) — previously they bound as strings and silently matched nothing.
- **surrealdb:** `block()` moved to `src/surql/` and its typed `LET`/`FOR` vars now support
  fragments/refs (the fluent `select(...)` integration is gone); comparison operators + stdlib
  families are unchanged.

## [0.1.0-alpha.1] - 2026-09-16

### Removed (fork)
- **repo:** the PostgreSQL driver (`drivers/postgres`, `@better-schemic/postgres`) — removed at the fork.
  better-schemic is SurrealDB-only: `drivers/surrealdb` is the single driver, `create-better-schemic` and
  `sc init` scaffold SurrealDB projects, and the release/land scripts cover the five remaining
  packages (`core`, `cli`, `surrealdb`, `create-better-schemic`, `better-schemic`).
- **repo:** the `@electric-sql/pglite` dev dependency (was the postgres test engine).

### Changed (fork)
- **repo:** package rename schemic → better-schemic — `@schemic/*` is now `@better-schemic/*`,
  `schemic` is `better-schemic` (bin `better-schemic` + `sc`), `create-schemic` is
  `create-better-schemic`, and the scaffolded config is `better-schemic.config.ts` exporting
  `betterSchemic` (`SchemicConfig` → `BetterSchemicConfig`, `SchemicProject` →
  `BetterSchemicProject`). BACKWARD COMPAT: the CLI still loads `schemic.config.ts` / `schemic.ts`
  and the named `schemic` export, still resolves the legacy `@schemic/<driver>` scope, and still
  honors `SCHEMIC_DEBUG` / `SCHEMIC_NO_BOOTSTRAP` / `SCHEMIC_*_TIMEOUT_MS` (the `BETTER_SCHEMIC_*`
  spellings win when both are set). The `sc` (CLI) and `s` (authoring) handles are unchanged.
- **repo:** project identity schemic → better-schemic (README, CLI docs, roadmap, `AGENTS.md`,
  release-maturity notes). The engine + CLI stay dialect-neutral; SurrealDB is the supported driver.
- **docs:** design docs that used the PostgreSQL driver as the worked second-driver example
  (`MULTI-DB-SPIKE.md`, `AUTHORING-SPLIT.md`, kind-registry docs, proposals) now use a generic
  SQL-driver sketch instead.


### Added
- **core:** `KindEngine.parent?(portable)` — the STRUCTURAL container a nested kind is addressed/grouped
  under (an index's/field's table), for the CLI's dotted `parent.child` addressing. DECOUPLED from
  `owner` (which is a display-only diff-clustering choice): a kind can be addressable-as-nested
  (`parent`) while declining per-parent diff clustering (`owner`), or vice versa. Addressing resolves
  `parent ?? owner` (so a kind that only sets `owner` still addresses dotted, unchanged).
- **cli:** READ-ONLY inspection commands — `sc <kind> ls` lists a kind's entities, `sc <kind> info
  <name>` dumps one entity's resolved DDL, and `sc ls` is a cross-kind overview (kinds + counts).
  BOTH grammars work: noun-first `sc <kind> ls`/`info` (so `access` is no longer special — it just
  also carries `rotate`/etc.) AND verb-first `sc ls <kind>` / `sc info <kind> <name>` (an unknown kind
  gives a teaching error). AUTO-GENERATED from the neutral kind registry so every driver gets them
  free. Source
  is what you DECLARED by default (the authored `define*` — always available even pre-`gen`, never
  stale, fully offline); `--snapshot` reads the metaDir baseline, `--live` introspects the DB (matching
  `diff --live`). Drift stays diff/check's lane. Table-scoped kinds address dotted (`sc index info
  user.email_idx`, via the neutral `parent`/`owner` hook). `--json` on all. Driver + inspect
  `sc <kind> <verb>` actions share one error formatter (clean `✗ <message>` + SCHEMIC_DEBUG stacks).
- **core / repo:** TYPE-PERF testing standard (`@ark/attest`) — shared type-level test suites across
  the workspace: type-completeness assertions (`attest<Expected, Actual>()`) and per-expression
  instantiation BUDGETS (`bench(...).types([N])`) that fail when a hot generic's inference cost
  regresses. Suites live in `test/types/*.assert.ts` + `*.bench.ts` and run under node/tsx via
  `scripts/type-perf.ts` (NOT bun — attest locates source files through node stack frames), as a
  SEPARATE CI job out of the hot land gate. Worked reference in `packages/core/test/types/`; the
  standard + adoption steps are in `docs/TYPE-PERF-TESTING.md` (drivers adopt).
- **core:** `@better-schemic/core/testing` gains a shared COVERAGE RECONCILE — `describeCoverageReconcile`
  (+ the pure `reconcileCoverage` and `KindCoverage`/`FeatureCoverage` types) reconciles a driver's
  declared coverage manifest against the LIVE facts: `registry.names()` must exactly equal the declared
  kinds (both directions, so the registered-kind side can't drift from code) and every `[x]` feature
  must name a real, non-skipped `test()` title. The enforcement lives in core (one shape across
  drivers, not three copies); a driver supplies only its `coverage-manifest.ts`. Convention documented
  in `docs/DRIVER-COVERAGE.md`.
- **cli / core:** debuggable errors — `SCHEMIC_DEBUG=1` (or `--stack`) prints the full stack + the
  `.cause` chain on any CLI failure (default output unchanged, now with a hint line), and a crashing
  schema module always reports the FAILING FILE path (original error as `cause`).
- **core:** typed cross-connection resolution — (A) a resolver's `ctx.connections.<name>` handle is
  now THENABLE to that sibling's FULL ORM client (`const main = await ctx.connections.main;
  main.select(...)`) while keeping direct `.query`; (B) the CHAINED config builder —
  `defineConfig().connection(name, driverFactory, staticConfig | (ctx, args) => config | config[])` —
  where the driver FACTORY itself is the marker and each resolver's `ctx.connections` is contextually
  typed with the ACCUMULATED prior connections (order = visibility = structural cycle prevention).
  The literal `defineConfig({ connections })` form is unchanged.
- **core / surrealdb:** table COMPOSITION + derived schemas (from
  real usage): `defineTable(name, s.object())`, a public native `s.object().fields` map (inverse of
  `.shape`), `TableDef.extend(shape | s.object())` typed cast-free column mixins, and derived
  Standard-Schema input schemas — `TableDef.create` (defaults/id optional, internal dropped) and
  `TableDef.update` (partial, id/readonly excluded) — composable via `.partial/.extend/.refine/.or`.
- **core:** ORM client P1 foundation — `OrmClientBase` (disposable bound-client contract: `close` +
  `[Symbol.asyncDispose]`, so `await using db = await connect()` auto-closes), the `asyncDisposable`
  mixin, and `resolveConnection(name?)` (managed path over the project config).
- **surrealdb:** the bound ORM client (P1 reads) at `@better-schemic/surrealdb/client` —
  `connect(name?)` MANAGED from the config / `connect(client)` BYO (close = no-op), `db.select(table)`
  pre-bound + awaitable (thenable builder; standalone `.run(db)` still works), AsyncDisposable
  + a disposable `forkSession()`.
- **core:** config-as-factory with PARAMETERIZED connections — `defineConfig` is generic and returns
  the config with a **typed `connect(name, args?)`**: connection names autocomplete (a typo is a
  compile error), `args` is the resolver's own declared 2nd param (`(ctx, args) => config | config[]`,
  typed per connection; absent for static connections), and each entry's own client type is inferred
  (heterogeneous-driver projects type per-connection). An ARRAY resolution is bulk-only (migrations
  enumerate it) — `connect` throws a teaching error; pass args selecting one. `key` is a display label
  (not an address); entries may add a dialect `label` hook for bulk reporting. Resolvers can query
  sibling connections via `ctx.connections` at runtime (lazy open through the entries' embedded client
  openers, cycle-detected, auto-closed). CLI: `--args <json>` + `--arg k=v` sugar feed resolver args.
- **core:** the config loader accepts a NAMED `schemic` export as well as a default — scaffolded form
  becomes `export const schemic = defineConfig(...)` in `schemic.config.ts` (deterministic
  `import { schemic }` -> `schemic.connect()` auto-import, no file rename); a bare `schemic.ts` is
  also discovered (shape-guarded).
- **surrealdb:** ORM P2 WRITES on the bound client — split builders
  (`db.create(T).content(data)`, `db.update(T, id).merge(...)` / `.content(...)` / `.set(...)`,
  `db.delete(T, id)`), decoding through the codec channel fail-fast and
  returning typed rows that CARRY their id.
- **surrealdb / sqlite:** query Phase 1 READS — richer WHERE operators under the shared
  op contract, pagination, and `one()` / `get()` / `count()` terminals on the select
  builder. RATIFIED op vocabulary (2026-07): `.includes(substr)` is the STRING substring-containment
  op (case-sensitive; a NULL/NONE column never matches; matches `z.string().includes()`), while
  `.contains` / `.containsAny` / `.containsAll` are ARRAY-membership ops (array columns only). Builder
  names are neutral; the driver lowers to its native operator (surreal `CONTAINS`,
  sqlite `instr()>0`). BREAKING (alpha — query P1 landed after `alpha.24`): surreal renamed its
  string `.contains` -> `.includes` (arrays keep `.contains*`).
- **surrealdb:** query WRITE model + GRAPH traversal — graph reads (`.out`/`.in` edge hops), faithful
  `ONLY` output modes, the full write surface (bulk writes, `upsert`, `relate`, `create(T, id)`,
  content-less create with a compile-time content gate), a `.kind` discriminant + `Any*`/`AnyStatement`
  types, and a schemaless (untyped `string | Table`) query surface. Writes now return an ARRAY by
  default with `.only()` for the single-row form (and `.all()` as the explicit bulk guard).
- **surrealdb:** table PRESETS — `defineTable.preset(...)` reusable table fragments applied
  via the chained single-arg `TableDef.use(a).use(b)` (columns + indexes).
- **surrealdb:** TYPED FRAGMENTS (phases 0–3) — the query builder and raw `surql` compose BOTH ways:
  eager marker resolution in the tag (`TableDef`/`FunctionDef`/`surql.$` paths splice as text, output
  is always a plain `BoundQuery`); builders interpolate as subquery fragments with namespaced binds;
  raw predicates drop into `.where(...)`; `` surql`…`.as<T>() `` retypes a fragment (the `[T]` rule);
  contextual TYPED callbacks on authoring slots (events `(e) =>` with `e.after`/`e.before` typed to
  the table shape, field clauses `(f) =>`, permissions `(p) =>` with `p.row`/`p.auth`, function bodies
  with args typed by name); typed `Operand<T>` — `$param` refs and fragments are legal builder
  operands (type mismatch = compile error); the `surql.fn` builtin catalog (live-verified vs 3.1.4) +
  kind-mapped ref stdlib (`u.name.length().gt(3)`); `block()` typed statement builder with OBJECT
  bindings (`.let({ n: v })`, `.for({ item: iter }, body)` — the var name is a real property, so
  rename/find-refs work); `$parent` correlated subqueries; `Def.call(args)` typed named-arg function
  calls that also accept refs + builders; `ParamRef.as<T>()` types an untyped `surql.$` param chain
  for typed operand/call/fn positions (type-only cast). FULL-TS function bodies (zero raw surql):
  `surql.fn` returns retypeable `Surql` (`.as<T>` everywhere) with `http.*<R>` response generics,
  plain object/array args SPLICE embedded refs (`{ to: [$email] }`) while pure data binds whole, ref
  PROPERTY PATHS (`sv.res.id` -> `$res.id`, `$parent`-aware), and `block().return` takes predicate
  Exprs. Plus lazy record refs `s.recordId(() => User)` (kills mutual-link import cycles) and
  auto-blocking of multi-statement event bodies.
- **surrealdb:** the authoring index re-exports the SDK VALUE surface (`Surreal`, `RecordId`, `Table`,
  `DateTime`, `Duration`, geometry types, …) so apps never import `surrealdb` directly —
  single-instance by construction (the SDK's `#private` classes are nominal; dual copies break
  `instanceof` and assignability).
- **surrealdb:** `defineSingleton(name, shape, { id? })` — one-record tables: emits the LITERAL id
  type (`DEFINE FIELD id … TYPE 'default'`, DB-enforced), id-optional client sugar (`db.get(Config)`;
  create/update/delete target THE record), and the literal id survives lower/normalize so it emits,
  diffs, and `pull` regenerates `defineSingleton`.
- **surrealdb:** `DEFINE PARAM` with the access-style secret split — an INLINE LITERAL value is fully
  managed (emit/diff/migrations/pull round-trip); an `env()`/`secret()` value is SECRET and excluded
  from snapshots/migrations (SurrealDB stores param values readably), deployed out-of-band via new
  `sc param push/check/list` (placeholder + binding — the value never appears in DDL text, and `pull`
  drops out-of-band params so values never reach generated source); a bare schema declares presence
  only. Typed `Def.$` deep param ref; the def splices `$name` in templates — and a `ParamDef` in ANY
  value position (operands, block values, fn/call args, spliced object values) splices `$name` typed
  by its `T` (other def kinds in value positions throw guidance instead of serializing to
  `[object Object]`). Expression values are rejected by design (the DB stores them EVALUATED — they
  can't round-trip).
- **surrealdb:** `formatSurql` — pretty-prints generated SurrealQL (INFO collapses bodies to one
  line; `pull` now writes statement-per-line with indented nested blocks and wrapped wide objects;
  idempotent, strings untouched). Wired into pull's function/event/access renders and exported from
  `/driver` for external display panes. Drift-safe by construction (normalize canonicalizes
  formatting — which now also strips trailing commas; hand-authored ones phantom-diffed before).
  Every display/output boundary pretty-prints (`sc diff`, gen, live diff, migration files with
  line-aware indent) while every COMPARISON stays canonical single-line — snapshots unchanged, no
  phantom churn on upgrade.
- **core:** `KindEngine.excludeFromMigrations` now accepts a PREDICATE (`(portable) => boolean`) in
  addition to `boolean` — a kind can decide PER OBJECT whether it is migration-managed (`snapshotKinds`/
  `buildKindDiff`/`emitKinds` feed the object). `KindRegistry.isExcludedFromMigrations(portable)` now
  REQUIRES the object (a predicate can't be answered without it — no silent "managed" fallback), and
  the new `skipsIntrospection(kind)` owns the static `true` case `introspectKinds` skips.
- **surrealdb:** key-free `DEFINE ACCESS` is now migration-managed via that predicate — `TYPE RECORD`
  (auto-generated session JWT), `TYPE JWT` via a JWKS `URL`, and `TYPE BEARER` (server-generated grant)
  enter snapshots/diffs/`gen`/`migrate`/`baseline`, still gated by the opt-in `--access` flag. A
  key-bearing `TYPE JWT` stays out-of-band (`sc access push/diff/rotate`): the canonical DDL omits the
  redacted `KEY`, so re-applying would rotate it.
- **surrealdb:** `$`-constraints now cover containers and wrapped fields — `$min`/`$max` apply to
  arrays and sets (`array::len` bounds), `$length` applies to arrays (exact `array<T,N>` + equality
  ASSERT) and `$size` to sets (exact `set<T,N>` + equality ASSERT), and all of
  `$min/$max/$length/$size/$regex/$gt/$gte/$lt/$lte` look through `.optional()`/`.nullable()` (the Zod
  check lands on the inner schema, wrappers preserved). A UNION bound is emitted only when ALL non-none
  members share one family (string / number / array / set): a mixed union (`int | string`) has no single
  valid SurrealQL function and no-ops (`.$assert(surql`…`)` is the explicit escape hatch).
  `.$assert()` (no args) additionally derives container bounds from Zod's `min_length`/`max_length`/
  `length_equals` (arrays) and `min_size`/`max_size`/`size_equals` (sets — gated to sets, since Zod
  maps share those check names but lower to `object`).

### Fixed
- **surrealdb:** an ASSERT on a NULLABLE field no longer rejects explicit NULL — SurrealDB skips an
  assert only for NONE, so `T | null` / `option<T | null>` (and `s.union([…, s.null()])`) now emit
  `ASSERT $value = NULL OR <expr>` (applied identically by the emitter and the Struct-IR lowering, so
  the two sides converge). `len`/format functions error on NULL, so without the guard a valid NULL was
  rejected (e.g. `s.number().nullable().$gt(0)`); a `null` union member is also ignored when deriving
  the bound, so `s.union([s.string(), s.null()]).$max(10)` now bounds the string member. `.optional()`
  is unchanged (the engine skips NONE) and custom `$assert` exprs are guarded the same way. The guard
  is IDEMPOTENT (an already-guarded expr normalizes to exactly one), and `pull` reverses it to the bare
  assert — so a pulled `s.number().nullable().$assert(surql\`$value > 0\`)` re-emits unchanged instead
  of stacking a guard per pass.
- **surrealdb:** a union with an `.optional()`/`.nullish()` member now lowers to the DB canonical form
  — SurrealDB reports `option<X> | Y` as `none | X | Y`, so member types are FLATTENED to top-level
  atoms and deduped (`s.union([s.string().optional(), s.int()])` → `option<string | int>`; an
  `.optional()` + `.nullable()` pair → `option<string | null>`, not `option<string | string | null>`).
  Previously the authored `option<string> | int` never matched `fromInfo`, phantom-diffing forever, and
  a repeated member would have too.
- **repo:** `src/cli/struct.ts` / `src/cli/introspect.ts` no longer contain literal NUL bytes (the
  string separators are `\x00` escapes) — git treated them as BINARY, so their diffs were unreadable.
- **repo:** `bun.lock` re-synced with the root `skills` dependency added by the skills-tooling commit —
  `bun install --frozen-lockfile` (the land gate + CI) failed without the lockfile entry.
- **surrealdb:** `$value` no longer strips a leading `option<>` — only DEFAULT/COMPUTED guarantee a
  populated column; a VALUE expression may evaluate to NONE, and SurrealDB persists `option<T>`.
  Stripping it emitted `TYPE T` while the DB stored `option<T>`, causing a phantom diff and rejected
  writes (e.g. `IF cond THEN NONE ELSE $value END`). Because VALUE runs AFTER DEFAULT and re-validates
  the type last, a field with BOTH `$default` and `$value` keeps `option<T>` too. The Struct-IR
  normalizer (`fromTableDef` vs `fromInfo`) applies the same rule, so the round-trip converges.
- **surrealdb:** `array<T, N>` / `set<T, N>` is EXACTLY N in SurrealQL — it is now inferred only from
  Zod's exact-size checks (`length_equals` for arrays, `size_equals` for sets), never from `.max()`.
  `s.array(e, { max })`/`s.set(e, { max })`/`.$max(N)` now emit `ASSERT array::len($value) <= N` on the
  bare container type instead of a wrong exact-size `array<T, N>`. `pull` reverses exact sizes to
  `.length(N)` (arrays) / `.size(N)` (sets) — it used to mangle `array<T, N>`/`set<T, N>` into
  `s.any() /* … */`, and sized sets silently degraded to `set<T>`. The size now survives the live
  `INFO` shape too: an array/set field always reports an `x.*` element child, and the renderer carries
  `N` through that branch (the old reverse only worked for element-less synthetic inputs).
- **core:** the DEFAULT migrations dir now follows the documented contract — RELATIVE TO THE SCHEMA
  (its sibling `migrations` dir) instead of a root-fixed `./database/migrations`. A nested schema
  (`schema: "./src/database/schema"`) previously split state: `init` scaffolded the snapshot
  schema-relative while `gen` wrote migrations + a second snapshot at the root default. Standard
  scaffold layouts are unchanged; an explicit `migrations` override still resolves from the root.
- **surrealdb:** `inline()` bind rewriting is boundary-aware — `$b1` no longer corrupts `$b10` with
  10+ binds (latent).
- **surrealdb:** `normalize` canonicalizes FORMATTING of function blocks / event exprs / field
  clauses / permissions (quote-aware whitespace collapse + INFO-style punctuation spacing + strip
  `;`-before-`}`) — any multi-line-authored surql body previously phantom-diffed forever against
  INFO's single-line printing; also folds `s"..."` -> `'...'` on function blocks/events (inlined
  strings phantom-diffed).
- **surrealdb:** an empty `block()` no longer emits invalid `{ ; }` — it renders the valid no-op
  `{ }` (live-verified).
- **core:** multi-line DDL renders with PER-LINE diff indicators — now that drivers pretty-print
  display statements, every line of a statement gets its `+`/`-` in `sc diff` (a bare continuation
  line read as context), unified-patch hunk counts count LINES not statements, the rollback block
  dims/indents per line, and the inline word-diff view collapses whitespace onto one line.

### Changed (BREAKING — alpha)
- **surrealdb:** dropped the deprecated `$`-less field aliases `.unique()`/`.index()` — use
  `.$unique()`/`.$index()` (already `$`-only; table-level composite
  `.index(name, fields)` unchanged).
- **surrealdb:** `db.query` is SDK-FAITHFUL — awaiting resolves the PER-STATEMENT result array (the
  old first-statement unwrap silently dropped every result after statement #1); `surql<[T1, T2]>`
  typing flows end-to-end, plain strings take `db.query<[User[]]>(...)`. Correspondingly `.as(...)`
  takes a decoder TUPLE mirroring the statements — `.as([z.number(), User.object.array()])` resolves
  `[number, App[]]` positionally; decoders are plain schemas (`TableDef.object` is the bridge into
  Zod land — no bespoke rows decoder), and a decoder-count mismatch is a teaching error.
- **surrealdb:** the `surrealdb` SDK moved from a regular dependency to a PEER dependency
  (app-vs-driver version drift created dual SDK copies whose nominal `#private` classes are
  incompatible), and `` surql`…`.as<T>() `` replaces the separate `surql.expr` tag (a second tag name
  broke editor syntax highlighting).
