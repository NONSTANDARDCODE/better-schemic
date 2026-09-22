# Better-schemic — roadmap

The **typed-query/ORM arc**: replacing the old fluent builder with the repository-style `/orm` layer.
The design + execution plan is **[`PLANO-QUERYS-TIPADAS.md`](./PLANO-QUERYS-TIPADAS.md)** (milestones
M0–M7 with a point-by-point API checklist); the live-verified SurrealQL ground truth the compiler must
emit against is `drivers/surrealdb/docs/orm-syntax-map.md`.

Packages release **in lockstep**; see `CHANGELOG.md` for what's shipped vs accumulating.

Legend: ✅ done · 🚧 in progress · 🟡 partial · ⏳ not started

---

## M0 — fundação + substituição do legado ✅ *(complete)*

- ✅ **M0.1** live syntax map (`docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`, 89 probes) —
  every statement the ORM emits, verified against server 3.2.x, with the prototype divergences recorded.
- ✅ **M0.2** `defineSchema` + `SchemaIndex` (columns/families, record links, graph adjacency,
  singletons, functions, schemaless entries; fail-fast `SchemaInvalid`).
- ✅ **M0.3** result wrappers (`ThrowingResult`/`BatchResult`/`StatementResult`) + `BetterSchemicError`
  catalog, SDK-error normalization and predicates.
- ✅ **M0.4** executor: one `conn.query` round-trip for N statements, per-statement status via
  `responses()`, atomic `BEGIN/COMMIT` batches, unique-binds guardrail.
- ✅ **M0.5** `/orm` bootstrap (`betterSchemic`/`createBetterSchemic`, delegates, `repository`,
  `tables`, `extends`, `forkSession`, BYO-managed lifecycle) + **the legacy surface removed** (fluent
  builder, `/client`, `@better-schemic/core/query`; `/query` keeps `block()`).

## M1 — leitura ✅ *(complete)*

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

## M2 — escritas ✅ *(complete)*

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

Also in this arc: record-string coercion in `where` (`"user:aeon"` → `RecordId`), `BatchResult.count`
optional on `return: 'none'`, `return: 'diff'` as the flat combined patch list, `insert`/`upsert`
`before` typed `App | null`, fail-fast `skipDuplicates` ids and `upsertMany.conflict` UNIQUE,
`updateEach.select` compiled before the write, `unrelate` timeout, and the new live map entries
(`FOR` returns `NONE`, `SET $obj` parse error, ON DUPLICATE branch evaluation).

## M3 — relações e grafos ✅ *(complete)*

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
`test/live/orm-relations.test.ts` (13 e2e) + the new syntax probes (78 total).

Hardening in the same milestone: relational `where` also lowers on `updateMany`/`deleteMany`/
`unrelateMany` (the schema index flows into the write compilers); a projected link without `id`
projects a hidden presence leaf so an absent link decodes to `null`; nested `select` objects remount
at the right path; `direction "both"` + `edge`+`target`, empty nested `include`, target filters on
edge-only includes and `_count` option typos all fail fast. The relational lowering lives in ONE
place (`relations.ts` arrow/traversal/refs + `where.ts` `compileRelationFilter`), shared by
`include`, `_count` and `where`.

## M4 — transações, live e changefeeds ✅ *(complete)*

- ✅ **M4.0** live probes + `orm-syntax-map.md` §7/§1 (84 probes total): `DIFF` right after `SELECT`
  and without a projection, `FROM ONLY`/record targets unsupported, `VALUE` emits nothing, a record
  leaving the `WHERE` filter emits nothing, `KILL $param` (string) works, `SINCE` takes literals only
  and is INCLUSIVE, changefeed shapes (`update`, `{current, update}`, `delete{original}`, `bigint`
  versionstamp), managed `beginTransaction` is the only multi-call transaction (SQL `BEGIN/COMMIT`
  does not hold across RPCs), HTTP lacks Transactions/LiveQueries.
- ✅ **M4.1** `client.transaction(fn, options?)` — SDK managed transaction, `tx` = full client,
  `tx.rollback(reason)` → `TransactionRollback` (`details.reason`), nested = SAME tx, root re-entry →
  `TransactionAlreadyActive`; retries (`writeConflict`/`serializationFailure`/`connectionError`,
  backoff + jitter, opt-in), client-side `timeout` (cancels the tx), `context`, `isolation` policy;
  `afterCommit`/`afterRollback` (root client reaches the current scope; outside a tx →
  `ValidationError`); batches inside the tx skip the implicit `BEGIN`.
- ✅ **M4.2** `live(args?, handler?)` on every delegate + `client.live(table)` / `client.liveOf(uuid)`
  / `client.kill(uuid)` — `LIVE SELECT [DIFF] <projeção> FROM t [WHERE] [FETCH]` compiled by the ORM
  (binds preserved), notifications decoded through the codec, `diff` ops, handler + async iterator,
  idempotent `kill`, reconnect re-run + `RECONNECTED`, HTTP → `LiveQueryUnsupported`, tx →
  `LiveInTransaction`; `only`/`value`/`orderBy`/`limit`/`group`/`split`/`include` → `ClauseNotSupportedInLive`.
- ✅ **M4.3** `client.changes({ table?, since?, limit? })` — `SHOW CHANGES FOR TABLE|DATABASE SINCE
  <literal>`, `since` versionstamp/`Date`/ISO, normalized `ChangeSet` (UPDATE/DELETE/DEFINE, `value`/
  `diff`/`before`), rows decoded by their own table at the database level, pagination via
  `versionstamp + 1` (inclusive `SINCE`).

Typed end to end: `TransactionClient<S>` (delegates, lifecycle stripped, `rollback` typed `never`),
`LiveArgs`/`LiveRow`/`LiveNotification` (`action` discriminated union), `ChangeSet`/`ChangeEntry`.
New modules: `orm/transaction.ts` (+ `errors.isSerializationFailure`), `orm/live.ts`, `orm/changes.ts`,
`orm/types/{transaction,live,changes}.ts`. Live: `test/live/orm-transactions.test.ts` (7 e2e, real
write conflict + retry), `orm-live.test.ts` (7 e2e), `orm-changes.test.ts` (5 e2e). Types:
`orm-{transactions,live,changes}.assert.ts` + the `TransactionClient` budget.

Known DX debt carried: per-operation `retry` on write args (prototype §10), deferred; `live`
real-transport reconnection is unit-tested (the live suite does not force a socket drop).

## M5 — escape hatches, admin e contexto ✅ *(complete)*

- ✅ **M5.1** `$raw`/`$query`/`$unsafe` — `$raw<T>` tagged template (cada `${…}` vira `$p<n>` via
  `renderValue`, então um fragmento `surql` compõe), `$raw(string|BoundQuery, options)`, e a forma
  **curry** `$raw({ meta })\`…\`` (leva as options ao template — sem ela `raw.requireComment` era
  insatisfazível no caminho recomendado); `$query` N statements com `throwOnError: false` →
  `StatementResult[]`; `$unsafe` exige `raw.unsafe: true` (`UnsafeDisabled`); `raw.requireComment`
  exige `meta.comment` em script de escrita; `raw.timeoutMs` aplica `TIMEOUT` só a statement única com
  verbo compatível (SELECT/UPDATE/CREATE/DELETE/INSERT/UPSERT/RELATE).
- ✅ **M5.2** `fn`/`api`/`auth`/admin — `client.fn.call<R>(name, args)` compila `RETURN fn::x($p…)`
  (nome validado, nunca spliced) + atalho tipado por `defineFunction` (args NOMEADOS → posicionais);
  `client.api.get/post/put/patch/delete` desembrulha `body` e lança `DatabaseError` com `status` +
  `details` em `>= 400`; `client.auth.signin/signup/authenticate/invalidate/record`;
  `info(level, table?)`/`version()`/`ping()`/`export()`/`import(dump)`.
- ✅ **M5.3** `$withContext` — clone síncrono com NS/DB prefixado (`USE NS … DB …;`) na MESMA
  operação, sem tocar a sessão (multi-tenant sem estado global); override por chamada
  (`findMany({ context: { database } })`); `$withContext({ auth })` (overload assíncrono) forka a
  sessão e autentica; operações presas à sessão (`api`/`auth`/`export`/`live`) falham rápido com
  `UnsupportedCapability` num clone por prefixo; `extends` reaplicado em clones/transação.

Typed end to end: `RawOptions`/`RawSource`/`RawStatements`/`RawTag`, `OperationContext`/`ContextScope`/
`ResolvedContext`/`CallContext`, `FnSurface`/`FnArgs`/`FnReturn`, `ApiOperations`, `AuthOperations`,
`AdminOperations` (+ `RootInfo`/`NsInfo`/`DbInfo`/`TableInfo`). New modules: `orm/raw.ts`,
`orm/context.ts`, `orm/fn.ts`, `orm/api.ts`, `orm/auth.ts`, `orm/admin.ts`,
`orm/types/{raw,context,fn,api,auth,admin,client}.ts` (a fachada tipada `Client`/`BetterSchemicOptions`
saiu do runtime). Live: `test/live/orm-raw.test.ts` (10 e2e: multi-tenant NS/DB, raw parametrizado,
`fn.call`, `DEFINE API`, admin dump/restore, sessão forkada). Types: `orm-m5.assert.ts` + o budget
`Client<S>` (75.476 instanciações).

**Passe de qualidade (pós-M5):** o executor ganhou a primitiva `runScript` (prefixo `USE`, normalização
de erro de transporte, offset de controle) reusada por `execute`, `$raw`/`$query` e `import` — este
último agora **propaga** a primeira statement com erro (antes ignorava `ERR` e "importava" em silêncio);
`transaction({ context })` virou `transaction({ meta })` (o `context` de NS/DB não colide mais);
`TransactionClient` omite `export`/`import`/`version`/`$withContext` (impossíveis numa `SurrealTransaction`);
`client.ts` caiu de 744 → 515 linhas com a fachada movida para `orm/types/client.ts` e a lista de
nomes reservados removida (a ordem do construtor agora cobre as superfícies); helpers duplicados
consolidados (`contextOption`, `contextPrefix`, `terminate`, `parseDurationMs`, `killedChange`);
`caught`/harness de live centralizados nos testes.

Divergências registradas no mapa (`docs/orm-syntax-map.md` §1/§10): `USE` escopa sem vazar a sessão;
`fn.call` por query em vez de `db.run` (session-bound); `import` por `query(dump)` (o `import()` do
SDK quebra em WS); `ping()` por `RETURN true` (`health()` não existe em WS); `api.*` inspeciona o
`status` (o SDK não rejeita em 4xx/5xx).

Adiado para o M6 (dono de hooks/plugins): `beforeRaw`/`afterRaw`/`onRawError` e
`$state`/`$withState`/`$withoutPlugins`; `meta` de contexto já é aceito e mesclado (sem consumidor).

## M6 — plugins e hooks ⏳ *(next)*

Observation hooks + `definePlugin` (`operationArgs`, transforms, `extendClient`/`extendModel`) and the
official plugins (`rules`, `zod`; then `timestamps`, `soft-delete`).

## M7 — hardening, docs e release ⏳

Exhaustive `docs/ORM-COVERAGE.md`, driver README/examples/cookbook, docs sweep, type-perf baselines,
final e2e, release.

---

## Parallel track — driver schema coverage

SurrealDB DDL completeness, tracked in `drivers/surrealdb/docs/COVERAGE.md`.
- ✅ **surrealdb:** full `DEFINE ANALYZER` coverage + fluent `defineAnalyzer`.
- ⏳ ongoing gaps.
