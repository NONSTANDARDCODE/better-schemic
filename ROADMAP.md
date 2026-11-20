# Better-schemic — roadmap

The **typed-query/ORM arc**: replacing the old fluent builder with the repository-style `/orm` layer.
This file carries the milestone plan (M0–M7) and their status; the live-verified SurrealQL ground
truth the compiler emits against is `packages/better-schemic/docs/orm-syntax-map.md`, and the exhaustive
runtime surface is `packages/better-schemic/docs/ORM-COVERAGE.md`.

Packages release **in lockstep**; see `CHANGELOG.md` for what's shipped vs accumulating.

Legend: ✅ done · 🚧 in progress · 🟡 partial · ⏳ not started

---

## M0 — fundação + substituição do legado ✅ *(complete)*

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
the new syntax probes (78 total).

Hardening in the same milestone: relational `where` also lowers on `updateMany`/`deleteMany`/
`unrelateMany` (the schema index flows into the write compilers); a projected link without `id`
projects a hidden presence leaf so an absent link decodes to `null`; nested `select` objects remount
at the right path; `direction "both"` + `edge`+`target`, empty nested `include`, target filters on
edge-only includes and `_count` option typos all fail fast. The relational lowering lives in ONE
place (`relations.ts` arrow/traversal/refs + `where.ts` `compileRelationFilter`), shared by
`include`, `_count` and `where`.

## M4 — transações ✅ *(complete)*

- ✅ **M4.1** `client.transaction(fn, options?)` — SDK managed transaction, `tx` = full client, `tx.rollback(reason)` → `TransactionRollback`, nested calls share one tx, `afterCommit`/`afterRollback`, opt-in retries and client-side timeout. Only `mode: "sdk"` is supported — SQL `BEGIN/COMMIT` does not hold across RPCs.

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
saiu do runtime). Types: `orm-m5.assert.ts` + o budget
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

Adiado ao M6 (dono de hooks/plugins): `beforeRaw`/`afterRaw`/`onRawError` e
`$state`/`$withState`/`$withoutPlugins` — ENTREGUES no M6 (ver acima); `meta` de contexto é
consumido pelos hooks.

## M6 — plugins e hooks ✅ *(complete)*

Hooks de observação (log/tracing/métricas) + `definePlugin` (transform, `operationArgs`, hooks,
`extendClient`/`extendModel`, estado por delegate) e os plugins oficiais F1 (`rules`, `zod`) e
F2 (`timestamps`, `soft-delete`).

- ✅ **M6.1 hooks** — `hooks` no bootstrap (`betterSchemic(conn, { schema, hooks })`); famílias
  `before/afterQuery|Create|Update|Delete|Relate`, `before/afterRaw`+`onRawError`,
  `beforeTransaction`/`afterTransactionCommit`/`afterTransactionRollback`+`onTransactionError`,
  `onError`. Payload com `table`/`operation`/`surql`/`vars`/`data`/`where`/`result`/`durationMs`/
  `count`/`meta` (o `meta` da chamada vence o do `$withContext`); `before*` pode abortar, `after*`
  roteia a falha para `onError`; `.explain()` NÃO dispara hooks; pipeline ausente = fast path.
- ✅ **M6.2 `definePlugin`** — `definePlugin({ id, name?, config?, operationArgs?, setup?,
  transform?, hooks?, extendClient?, extendModel? })`; `transform` muta `where`/`data`/`kind`
  (re-despacho; `false` pula a op) e é SÍNCRONO (a compilação continua eager); `operationArgs`
  tipados por operação (opcionais) fluem para `Delegate`/`Client<S,C,P>`; `setup` 1x no bootstrap
  (fail-fast `PluginError`); `$model` ganhou `dbName`/`relations`; `$state`/`$withState`/
  `$withoutPlugins` por delegate.
- ✅ **M6.3 F1** — `plugins/rules` (`noRawUnsafe`, `destructiveWriteWithoutWhere`, `requireLimit`,
  `requireOrderByForCursor`, `maxLimit`, `strict` → `UnknownField`; presets `safe`/`recommended`/
  `strict`) e `plugins/zod` (valida `data` de create/insert/update/upsert por tabela → `ValidationError`
  com o path). Subpaths `better-schemic/plugins/{rules,zod}`.
- ✅ **M6.4 F2** — `plugins/timestamps` (modo `app` carimba `time::now()` em create/update/upsert;
  modo `database` só remove as colunas gerenciadas) e `plugins/soft-delete` (`delete`→`update`/
  `updateMany` com a coluna carimbada, filtro de leitura `deleted: "with" | "without" | "only"`
  (exceto `findUnique`, cujo `where` é o alvo), `deletedBy` de `meta.actor`, `restore`/
  `restoreById` via `extendModel`). Subpaths `better-schemic/plugins/{timestamps,soft-delete}`.

Tipado ponta a ponta: `HookPayload`/`AfterHookPayload`/`ErrorHookPayload` (raw/transaction próprios),
`Plugin`/`PluginSpec`/`PluginContext`/`PluginState`/`Operation`, `PluginArgs`/`PluginClientExtras`/
`PluginModelExtras`. Novos módulos: `orm/hooks.ts`, `orm/plugins.ts`, `orm/types/{hooks,plugins}.ts`,
`plugins/{rules,zod,timestamps,soft-delete}.ts`. Testes: `test/unit/orm-{hooks,plugins,plugins-rules,
plugins-zod,plugins-timestamps,plugins-soft-delete}.test.ts`, `test/types/orm-m6.assert.ts` + budgets,
`orm-syntax-map.md` **inalterado**:
o M6 não emite SurrealQL novo.

Known DX debt carried: `soft-delete` não filtra `findUnique` (o `where` é o alvo — documentado);
`transform` é síncrono (async pertence a um hook) — registrado no PLANO.

## M7 — hardening, docs e release ✅ *(complete)*

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

Isolamento row-level por tenant como plugin oficial — preset de schema + runtime fail-closed para
sessões privilegiadas, com zero-diff para quem já escrevia a receita na mão.

- ✅ **M10.1 preset `tenant(principal, options?)`** — coluna tipada `record<principal>`
  (`DEFAULT $auth.id` / `ASSERT $value != NONE` / `READONLY`), permissions por op
  (`<col> = $auth.id`; soft delete com a cláusula `$before`; `createOnly` → `update NONE`), evento
  guard `{table}_protect_<col>`, índices `{table}_<col>_idx` / `{table}_<deleted>_idx` e
  `meta.tenant`; opções `column`/`softDelete`/`createOnly`/`protect`/`indexes`/`names`.
- ✅ **M10.2 runtime `tenantRls(options?)`** — `TenantRequired` fail-closed antes de compilar,
  injeção de escopo em create/upsert (e em `update` com `mode: "replace"`, cujo campo `READONLY`
  precisa estar presente), `Operation.scope` ANDado em TODA leitura (inclusive os alvos id/unique do
  `findUnique`) e escrita (inclusive alvos singulares por id/unique), `$forTenant(...)` via
  `extendModel` (estado namespaced pelo id do plugin), `TenantViolation` para payload/where/patch
  divergente, validação de bootstrap (coluna record link + tombstone) e recusa fail-closed dos
  caminhos `INSERT … ON DUPLICATE` (sem `WHERE`).
- ✅ **M10.3 extensões pequenas e retrocompatíveis** — placeholders `{table}` em event/index de
  preset, `TablePreset.meta` → `TableConfig.meta` (opaco; emit/snapshot/diff ignoram),
  `surql.ident(name)` (identificador escapado) e os códigos `TenantRequired`/`TenantViolation`
  (403) + `isTenantViolation`.
- ✅ **M10.4 testes + docs** — unit (preset/runtime/compiler/`surql.ident`), tipos (`@ark/attest`),
  `README`,
  `docs/orm-syntax-map.md` §2, `docs/ORM-COVERAGE.md` §7/§8, `docs/COVERAGE.md`, CHANGELOG.

Fora de escopo (documentado): `relate*`/`live`/raw e `$withoutPlugins()` (o limite é a permission
do banco / o escape explícito). `findUnique` é escopado como qualquer leitura (alvo id e campo
único), e `insert({ onDuplicate })`/`upsertMany` por ids são recusados fail-closed (o lowering
`INSERT … ON DUPLICATE` não tem `WHERE`).

## M11 — `upsertDelta` (create-or-update com delta decodificado) ✅ *(complete)*

Uma escrita **aditiva**: `delegate.upsertDelta(args)` cria-ou-atualiza em UMA ida e devolve a linha
resultante, a anterior e o delta campo-a-campo de valores **decodificados** —
`RETURN VALUE { before: $before, after: $after }` no MESMO statement (sem corrida read-then-write).

- ✅ **M11.1 API + tipos** — `UpsertDeltaArgs` (`where?` id/UNIQUE, `data` XOR `create`+`update`,
  `mode` sem `patch`, `onMissing: "create" | "throw"`, `timeout`) e `UpsertDeltaResult<TD>`
  discriminado por `created` (`before`/`delta` estreitam sozinhos; `changed` tipado como
  `DeltaKey<App<TD>>[]`); `FieldDelta`/`DeltaKey` exportados do `/orm`.
- ✅ **M11.2 lowering + probes** — alvo por `where`, inferido de `data.id` ou create sem alvo
  (`CREATE`, id por `idStrategy`); envelope em TODA lowering; `onMissing:"throw"` compila
  `UPDATE ONLY t:id`/`UPDATE t … WHERE uniq` e um resultado sem envelope vira `ResultNotFound`;
  expressões e branches distintos via LET/IF com envelope+TIMEOUT POR BRANCH; facts live-probed
  (3.2.0) em `docs/orm-syntax-map.md` §2.3.1 + probes `UPSERT DELTA` (117 no total).
- ✅ **M11.3 runtime** — `delta.ts` (`equalAppValue`/`computeFieldDelta`: `Date`, `.equals()` dos
  valores do SDK, `Uint8Array`, arrays/objetos recursivos; nunca `JSON.stringify`); decode do
  envelope em `writes.ts` (cada lado decodificado pelo codec da tabela; `before` ausente = create).
- ✅ **M11.4 integração** — hooks (família update, payload do write), `tenantRls` (injeção/escopo +
  estrito cross-tenant → `ResultNotFound`), `timestamps` (updatedAt no delta), `zod`, logger;
  `upsert` intocado (SQL, tipos e comportamento).
- ✅ **M11.5 testes + docs** — unit (lowering/guardas/decode), live (contrato, codecs, estrito,
  concorrência, transação), tipos (`@ark/attest`), probes de sintaxe; README, `ORM-COVERAGE.md`,
  syntax map, CHANGELOG, cookbook (`examples/orm/writes.ts` + manifest regenerado).

## M12 — fricções alpha.7: upsert estrito por padrão + `$value` create-opcional + `computes` ✅ *(complete)*

Uma passada de DX sobre as quatro fricções encontradas no `apps/core` do alpha.7 — defaults
perigosos viram explícitos, o contrato de `upsert` deixa de mentir e o `$value` para de exigir
flags no caso comum.

- ✅ **M12.1 `$value` create-opcional + guard** — `$value(expr)` vira create-opcional por padrão
  (espelha a schema `.create` runtime, que já marcava todo `VALUE` como opcional); uma expressão
  que LÊ `$value` precisa declarar `{ optional: false }` (transform que exige input) ou
  `{ optional: true }` (o DB pode computar sem input) — sem escolha explícita e sem
  `$default`/Zod-optional, o authoring lança erro ensinando (o TIPO não lê o texto da expressão).
  `{ optional: false }` também endurece a schema `.create`. `sc pull` emite `{ optional: true }`
  quando o `VALUE` puxado lê `$value`; `readsClientValue` compartilha a detecção.
- ✅ **M12.2 `computes`** — `$value(…, { computes: […] })` marca as chaves aninhadas que a
  expressão do pai preenche como create-opcionais POR ITEM (`Create<>`/`CreateData`/`create()` +
  schema `.create`), tipadas contra o elemento (typo/campo escalar falham no authoring). As flags
  `computes:<key>` viajam num brand type-only (`~szFlags`) lido por propriedade — imune à
  inferência estrutural; sem DDL e sem `sc pull`.
- ✅ **M12.3 upsert estrito + contrato honesto** — `onMissing: "create" | "throw"` (default
  `"throw"`) nos dois upserts: alvo inexistente ou filtrado (permission/escopo) rejeita
  `ResultNotFound` em vez de criar em silêncio ou resolver `null`; `UPDATE ONLY t:id` /
  `UPDATE t … WHERE uniq`; `create`+`update` exige `onMissing: "create"`; `return: "none"` estrito
  compila row-returning (miss observável) e `return: "diff"` é recusado; `return: "after"` em modo
  create que não escreve linha também rejeita. `upsertMany` fica como está (insert-style).
- ✅ **M12.4 testes + docs** — unit (lowering/guardas/decode/miss), live (estrito por padrão,
  miss real, cross-tenant, idStrategy, concorrência, transação), tipos (`@ark/attest`), probes de
  sintaxe (`UPDATE ONLY` miss → NONE, `UPDATE … WHERE` miss → []), README, `ORM-COVERAGE.md`,
  `orm-syntax-map.md` §2.3/§12, `COVERAGE.md`, CHANGELOG, cookbooks + manifests regenerados.

## M13 — fricções alpha.8: alvo opcional do `upsert` (paridade com o `upsertDelta`) ✅ *(complete)*

Uma passada de DX sobre a fricção do `apps/core`: as duas APIs de upsert passam a resolver o alvo do
mesmo jeito, então as rotas de save trocam `upsertDelta({ data })` por `upsert({ data })` — uma
chamada, sem branch e sem cast, sem o custo do envelope delta.

- ✅ **M13.1 alvo compartilhado** — `where` opcional no `UpsertArgs`; `resolveUpsertTarget` (extraído
  do delta) resolve `where` > `data.id` > sem alvo; `where.id` divergente de `data.id` é
  `ValidationError`; `where` não-único/`{ id: undefined }` continua `UniqueTargetRequired`.
- ✅ **M13.2 lowering sem alvo** — `compileUpsert` ganha o ramo `target === undefined`: `CREATE`
  (target por `idStrategy`, `only`/`return`/`timeout` do `create`); com `return:"after"`, um create
  filtrado por permission/escopo → `ResultNotFound`; guardas compartilhadas
  (`assertTargetlessCreate`) com o delta: `"throw"` explícito, branches distintos e `mode` sem alvo.
- ✅ **M13.3 miss honesto** — `WritePlan.strictMiss` (setado só pelas lowerings estritas) decide a
  mensagem do `upsertMiss`/`deltaMiss`; um create sem alvo filtrado não afirma mais
  `onMissing:"throw"`.
- ✅ **M13.4 testes + docs** — unit (lowering/guardas/decode/miss/idStrategy/tenant), live
  (target-less create, `data.id` estrito, miss, create-or-update, MERGE com id igual), tipos
  (`@ark/attest`), probe de sintaxe (`UPDATE ONLY t:id MERGE { id: t:id }`), README,
  `ORM-COVERAGE.md`, `orm-syntax-map.md` §2.3/§12, CHANGELOG, cookbook + manifest regenerado.

## M14 — create-only (append-only) tables: preset `createOnly()` + runtime `createOnlyGuard()` ✅ *(complete)*

Tabelas append-only declaradas no schema: `update` bloqueado no banco (`FOR update NONE`), guarda
client-side fail-fast para sessões privilegiadas e `updatedAt` suprimido pelo `timestamps()`.

- ✅ **M14.1 preset `createOnly({ hard? })`** — permissions `FOR update NONE` (AND-narrowed com as da
  tabela), marker opaco `meta.createOnly`, evento duro opt-in `{table}_create_only`
  (`WHEN $event = 'UPDATE' THEN { THROW … }`) que roda SEM permission checks (bloqueia root/raw/
  `$withoutPlugins()`); o preset `tenant(…, { createOnly: true })` passa a carimbar o mesmo marker.
- ✅ **M14.2 runtime `createOnlyGuard({ tables? })`** — a família update inteira + `insert` com
  `onDuplicate: "update" | map` rejeitados ANTES de compilar (`CreateOnlyViolation`, 403,
  `isCreateOnlyViolation`) com hint teaching ciente do evento duro; fallback `tables` para schemas
  sem preset (pulled/schemaless); tags por `SchemaIndex` cacheadas (WeakMap, caminho quente = 1 `Map.get`).
- ✅ **M14.3 interop `timestamps()`** — tabela create-only nunca recebe `updatedAt` (create ou
  update burlado), independente da ordem de registro dos plugins (marker lido no transform).
- ✅ **M14.4 testes + docs + fix de paridade** — unit (preset golden/AND-narrowing/runtime/interop/
  erros), tipos (`@ark/attest`), (evento round-trip; `what` do INFO normalizado de `Table` → string, corrigindo um phantom-diff
  pré-existente em QUALQUER tabela com evento); README, `ORM-COVERAGE.md` §7/§8, `COVERAGE.md`,
  `orm-syntax-map.md` §2.5, CHANGELOG.

## M15 — string ids: a superfície do ORM fala string bare (RecordId só no wire) ✅ *(complete)*

A fricção do `apps/core`: `extractId`/`toBareRecordId`/codecs locais em todo call site. O modo
string-id faz o APP ler/gravar strings bare (`01M…`), mantendo `RecordId` apenas no wire/DB —
**DDL inalterado** (zero migração).

- ✅ **M15.1 modo por campo (`RecordIdField.stringIds()`)** — o schema vira um codec
  (wire `string | RecordId`, app `BareId<T>` phantom-branded com a tabela alvo); decode normaliza
  `table:id`/`table:⟨id⟩`/`RecordId` com `splitRecordId` + unescape (corrigindo o double-escape
  latente de ids escapados em `recordTarget`/RELATE), encode sempre `RecordId(table, bare)`;
  validação de `targets` e `valueType` mantida; `.type()`/`rebuild` preservam o modo.
- ✅ **M15.2 açúcar por tabela (`TableDef.stringIds()`)** — flipa o id + todos os campos record do
  shape (objetos/arrays aninhados, wrappers, unions com record), preservando o DDL byte-idêntico;
  multi-alvo (`s.recordId([A,B])`) e alvo aberto lançam erro ensinando (string bare não nomeia a
  tabela no encode); `.default()`/`.catch()` (que carregam valor de fallback) são autorados DEPOIS de
  `.stringIds()`; `TableDef.record()` herda o modo (e o preset `tenant()` com ele);
  `RelationDef.stringIds()` flipa edge + in/out + id, e `.from(User)`/`.to(Post)` herdam endpoint
  único string-id; RELATE aceita endpoint bare quando a direção declara UMA tabela.
- ✅ **M15.3 ORM runtime** — binds de `where` (equals/in/contains/not/any/all e scope de plugins)
  coerciona string→`RecordId` pelo target da coluna; writes (create/update/upsert/upsertDelta/
  updateEach/relate) normalizam data aninhada via codec + fallback de alvo; cursor coage por coluna
  do keyset (`record` → `RecordId`, `datetime` → `DateTime`) e devolve `nextCursor`/`previousCursor`
  na representação app (id bare no modo string; `DateTime` cru mantém ns); includes/FETCH decodificam
  refs bare; `ColumnMeta.record.stringIds` expõe o modo ao runtime.
- ✅ **M15.4 tipos** — `BareId<T>`/`RecordIdTable<T>` phantom (string comum continua atribuível),
  `RecordIdName` resolve a tabela alvo no brand (relações `is`/`some`/`every`/`none` preservadas),
  `CreateData`/`UpdateData` aceitam `string | RecordId` (aninhado), `CursorInput` idem,
  `TenantField` segue o modo do principal.
- ✅ **M15.5 testes + docs** — unit (codec/DDL identity/deep map/relações/tenant; where/write/cursor
  goldens), live (create/where/cursor/tuple/upsertDelta/include/RELATE + probes em
  `orm-syntax.test.ts`), tipos (`orm-string-ids.assert.ts`), cookbook `examples/orm/string-ids.ts` +
  manifests, README, `ORM-COVERAGE.md` §11, `COVERAGE.md`, `orm-syntax-map.md` §12, CHANGELOG.
  Documentado: `db.query()` cru, `live` e `changes` continuam devolvendo `RecordId`; `sc pull` não
  recupera o modo (como `idStrategy`).

## M17 — fechar os gaps de completude do ORM ✅ *(complete)*

Onze lacunas da superfície mapeadas contra o servidor real (3.3.4) e fechadas — cada uma com
probe live, porque três delas eram **respostas silenciosamente erradas** (o mais caro que existe
numa API de relatório).

- ✅ **M17.1 `aggregate` aceita o próprio alias** — `groupBy` valida o output key **ou** o path
  projetado (o servidor aceita as duas grafias, live 3.3.4); `select: { customerName: "customer.name" }`
  + `groupBy: ["customerName"]` deixa de ser recusado por um erro que mandava adicionar
  `customerName: "customerName"`.
- ✅ **M17.2 operando de agregado validado contra o schema** — `math::*` é **number-only** e o
  servidor responde `0` (sum/avg), `{}` (median) ou `null` (min/max) para string/link/array/
  inexistente **sem erro algum**; o `aggregate` recusa com a alternativa que funciona
  (`array::min(array::group(…))`, `split`, ou `{ collect }`). Um relatório com `{ sum: "x.y" }`
  errado parou de mostrar R$ 0,00 e virou erro de compilação.
- ✅ **M17.3 `aggregate({ split })` — UNWIND + GROUP** — o split vai para uma subquery interna
  (o servidor avalia `SPLIT` antes de `GROUP`, e `SELECT *` não expõe os campos do elemento), a
 grupagem por fora; cada entrada do `select` é re-mapeada para a coluna reservada que a subquery
  projetou. `where` filtra o **pai** (filtro por elemento continua receita `surql` com
  `array::flatten` — `SPLIT <expr>` é avaliado por elemento, live 3.3.4).
- ✅ **M17.4 idioma de `SPLIT` automático** — o campo split vira uma coluna reservada
  (`_split_<field>`) quando o `select` não o traz; um **alias** satisfaz o idioma do servidor
  (live 3.3.4), então `findMany({ select: { … }, split })` funciona sem projetar o campo à mão.
- ✅ **M17.5 marcadores de array no `data`** — `{ append }` (`+=`, append **sem dedup**), `{ remove }`
  (`-=`, remove **todas** as ocorrências), `{ union }` (`array::union`, a única forma que
  deduplica) e `{ at: { index, value } }` (`f[n] =`), cada um UMA escrita server-side — o que
  mantém correto o índice UNIQUE do array. Alvo validado (família `array`/`set`, nunca `id`).
- ✅ **M17.6 alvo UNIQUE composto** — um `where` que cobre **todos** os campos de um índice
  UNIQUE composto é um alvo válido (`findUnique`/`upsert`/`upsertDelta`); um `where` parcial
  continua recusado (casa várias linhas) e a mensagem nomeia o grupo — que é o near-miss do
  multi-tenant (`email` único *dentro* do tenant).
- ✅ **M17.7 `plugins/hard-delete`** — `delete` segue DELETE físico, com a intenção destrutiva
  explícita na operação (`meta.hardDelete`), `tables`/`reason` opcionais; `soft-delete` ganhou
  `tables` para os dois comporemem num schema misto.
- ✅ **M17.8 `fn.expr` + `search::rrf`** — a **forma fragmento** do catálogo de `defineFunction`
  (`fn::jw($p0, …)` como `Surql`, binds fundidos no statement que a compõe) entra num
  `where`/`select`/`orderBy` tipado sem `$query`; `search::rrf` (a metade RRF de uma busca
  híbrida, cuja outra metade já é `matchesFullText`) entrou no catálogo `fn.ts` com probe live.
- ✅ **M17.9 `$raw` não engole statements** — um script de N statements é recusado com erro
  apontando o `$query` (que devolve a tupla), em vez de resolver o primeiro resultado e descartar
  o resto em silêncio (um `LET` inicial virava `null` sem erro).
- ✅ **M17.10 tiebreaker de `cursor` no TIPO** — `.index(name, [field], { unique: true })` registra o
  campo no terceiro parâmetro de `TableDef`, e `CursorArgs.orderBy` só aceita ordenações cujo
  último campo ∈ `id ∪ únicos` (índice composto não conta: os campos são únicos só em conjunto).
  O guard runtime (`CursorTiebreakerRequired`) continua como rede para índice vindo de `config`.
- ✅ **M17.11 testes + docs** — unit (goldens em `orm-reads`/`orm-writes-projection`/`orm-raw`/
  `orm-fn`/`orm-plugins-hard-delete`), tipos (`@ark/attest`: markers de array e tiebreaker),
  live (split idiom, UNWIND+GROUP, markers de array, alvo composto, `fn.expr`, `search::rrf`),
  `orm-syntax-map.md` §2.4.2/§2.4.3/§3.1/§9, `ORM-COVERAGE.md`, README, cookbook
  `examples/orm/{reads,writes}.ts` + manifest (55 entradas), CHANGELOG.
- ✅ **M17.12 modificadores de ajuste `when`/`else`/`coalesce`** — a guarda `when` (um `surql`
  avaliado no servidor) transforma o marcador em `SET f = IF <g> THEN <efeito> ELSE <else> END`,
  ainda UMA escrita server-side; `else` é o ramo de fallback (`"keep"`, `"throw"` que aborta a
  statement inteira — `updateMany` incluído — ou um valor/`Surql`) e `coalesce` semeia um array
  `NONE` (`array::union(f ?? $c, $p)` / `(f ?? $c) + $p`), só em `union`/`append`. `when` é
  recusado em `{ at }` e `else` sem `when` é `ValidationError`; os seis operadores de
  `AdjustmentLowering` não mudam. Unit (goldens + tabela de decisão), tipos, probes live §2.4.2,
  README/cookbook, CHANGELOG.

## M16 — write projections (`select`/`omit`) + ajustes numéricos (`{ increment }`/`{ decrement }`) ✅ *(complete)*

Uma passada de DX/performance sobre o RETORNO das escritas: toda op que devolve linha aceita a MESMA
projeção das leituras, e contadores ajustam num read-modify-write do servidor (sem lost update).

- ✅ **M16.1 superfície** — `select`/`omit` em `create`/`createMany`/`insert`/`insertMany`/`update`/
  `updateMany`/`patch`/`upsert`/`upsertDelta`/`upsertMany`/`delete`/`updateEach`/`relate`/
  `relateMany` (`WriteProjection`); `select`+`return:"diff"` → `ReturnNotSupported`.
- ✅ **M16.2 lowering** — o servidor carrega a projeção no próprio `RETURN <proj>` (paths aninhados,
  aliases, expressões, `*`; `RETURN … OMIT` é parse error — omit vai client-side); BEFORE/`delete`/
  `upsertDelta`/`create.relate` decodificam a linha inteira e projetam no cliente (entradas de
  expressão → `ReturnNotSupported`); `updateEach.select` agora também usa o RETURN do servidor.
- ✅ **M16.3 `increment`/`decrement`** — `data: { balance: { decrement: 10 } }` → `SET balance -= $p`
  (uma ida); merge achata objetos aninhados em leaves (`SET address.city = $p`) para preservar o
  merge profundo; `set` mantém atribuições top-level; operandos number/bigint/`Decimal`/expressão;
  alvo validado (campo numérico conhecido, nunca `id`); payloads de create (create/insert/relate/
  `onDuplicate`/`upsertMany.update`/branch de create) → `ValidationError` teaching; o plugin `zod`
  valida o OPERANDO (substitui o wrapper).
- ✅ **M16.4 tipos** — resultados dirigidos pelo literal dos args como nas leituras
  (`ResultOf`/`WriteResultOf` em `CreatedResult`/`WrittenResult`/`UpdatedResult`/`DeletedResult`/
  `BatchWriteResult`/`UpsertDeltaResult`, incluindo `record`/`before`/`delta`/`changed`);
  `UpdateWriteData` aceita `Increment`/`Decrement` só em campos numéricos; `CreateData` segue sem
  marcadores.
- ✅ **M16.5 testes + docs** — unit (`test/unit/orm-writes-projection.test.ts`), live (probes
  `WRITE PROJECTIONS`), tipos (`orm-writes.assert.ts`); README,
  `ORM-COVERAGE.md` §2, `orm-syntax-map.md` §2.4.1/§2.4.2 (125 probes), CHANGELOG, cookbook
  `examples/orm/writes.ts` + manifest regenerado.

## M18 — um único pacote (`better-schemic`) ✅ *(complete)*

O monorepo tinha 5 pacotes (`core` + `cli` + `surrealdb` + o alias `better-schemic` + o
scaffolder). Como o projeto é **SurrealDB-only**, o desacoplamento entre driver/CLI/engine pagava
um custo real (5 manifests, pins `workspace:*`, release lockstep de 5, um alias de 20 linhas) sem
comprar nada: o driver nunca foi plugável.

- ✅ **M18.1 runtime único** — `packages/better-schemic` passa a conter o engine (`src/core`), o CLI
  (`src/cli`) e o driver SurrealDB (`src/surreal`); as fronteiras de bundle passam a ser as entradas
  de `exports` (`/connection`, `/orm`, `/query`, `/config`, `/plugins/*`, `/driver`, `/core`), e o
  entry de autoria (`better-schemic`) segue **side-effect-free** (o emit/diff não entra no bundle do
  app).
- ✅ **M18.2 CLI estático** — o driver é embutido (importado uma vez pelo entry do CLI): sem
  carregamento dinâmico por nome, sem resolução do entry compilado de outro pacote. `init`/`diff`
  perderam a flag `--driver` (o build é SurrealDB-only) e o `init` deixou de fazer bootstrap via
  `create-better-schemic` (o driver já está instalado).
- ✅ **M18.3 dependências internas** — `zod` e o SDK `surrealdb` viraram **dependências** do pacote
  (não peers): o app instala `better-schemic` e pronto — `s.*` estende os builders do Zod, e uma
  segunda cópia quebraria `instanceof`. Zod cru sai do mesmo pacote (`import { z } from
  "better-schemic"`), garantindo uma única cópia.
- ✅ **M18.4 scaffolder** — `create-better-schemic` dropped o `--driver` (só existe SurrealDB) e
  resolve o bin do pacote instalado pelo próprio `package.json` (nada de path hardcoded).
- ✅ **M18.5 release + toolagem** — release lockstep de 2 pacotes (`release.ts` sem pin de
  `core`), `land.ts` apontando para o layout novo, e os pacotes
  antigos (`@better-schemic/core`, `@better-schemic/cli`, `@better-schemic/surrealdb`) depreciados
  no npm, apontando para `better-schemic`.
- ✅ **M18.6 docs** — `AGENTS.md`, README raiz, README do pacote, `docs/engine/*` (os docs de
  onboarding de driver viraram históricos) e o guia `docs/MIGRATION-one-package.md` com o mapa
  antigo → novo.

## M19 — typed graph traversal on the ORM 🚧 *(in progress)*

Initial slice delivered: `delegate.from(anchor).graph(g => g.out(E).in(E).both(E)…)` compiles to a single
`SELECT [DISTINCT] VALUE <path> FROM ONLY <anchor>` and decodes the resulting node array.

- ✅ **M19.0** anchor + builder skeleton + runtime compilation (`src/surreal/orm/graph.ts`, `src/surreal/orm/compiler/graph.ts`).
- ✅ **M19.1** `.out`/`.in`/`.both` chaining with schema-checked direction (runtime resolve via `resolveEdge` + edge config targets).
- ✅ **M19.2** `.select` (object + callback via `FieldRef`/`fragOf`) + `.distinct()`.
- ✅ **M19.3** per-hop `where` (edge/target split via `classifyWhereByOwner`) + final `.where` (object or callback `Expr`).
- ✅ **M19.4** tagged-template `.traverse\`…\`` (runtime-parsed path).
- ✅ **M19.5** recursion (`.repeat` + collect/paths/shortest), edge steps (`.outEdges/.inEdges/.bothEdges` + `.node()`), `.match` (where + select), polymorphic-union targets (via target list).

### Gaps de ORM para agentes/IA — entregues ✅

O mapeamento completo está em `packages/better-schemic/docs/ORM-COVERAGE.md` §§12–13 e no README do
pacote. Nenhum destes itens é "AI-native" por si só — são as peças que fazem o ORM servir bem a
agentes. Não há claim de LLM-facing query API, MCP/GraphQL ou métricas OTel.

- ✅ **`describeSchema()` / descriptor legível por agente** — `orm/describe.ts` deriva do `SchemaIndex` + defs um objeto JSON-safe (colunas, tipos, asserts/default/computed, índices, eventos, permissões, endpoints de relation, functions e tags `meta` de plugins). Sem DDL e sem DB. Teste: `orm-describe-schema.test.ts`.
- ✅ **Preview de SQL sem servidor (`.toSQL()`) + dry-run de writes** — `execute.ts::sqlPreview`/`statementParts` compartilham a lógica com o executor; `.toSQL()` nas leituras e `delegate.$sql.<op>(args)` nos writes (compile-only, transform de plugins aplicado). `.explain()` continua server-backed e separado. O gate "shadow/dry-run verify" de migrations segue em aberto em `docs/RELEASE-MATURITY.md`. Teste: `orm-sql-preview.test.ts`.
- ✅ **DSL de política declarativa no ORM** — `better-schemic/plugins/policy` (`definePolicy`) com efeitos `deny`/`scope`/`require`, nomes de tabela tipados pelo schema e `PolicyDenied`/`PolicyRequired` (403). A fronteira de autorização continua sendo a permission do banco (ou `$withoutPlugins()`). Teste: `orm-plugins-policy.test.ts`.
- ✅ **Camada semântica** — `defineMetric`/`defineGlossary`/`lineage()` em `orm/semantic.ts`: métricas tipadas contra a tabela, lineage validado por campos declarados (sem parse de SQL), glossário JSON-safe; compiled via o `aggregate` existente, sem DDL novo. GraphQL e integrações de IA seguem fora de escopo em `docs/engine/SURREALDB-FEATURE-MAP.md`. Teste: `orm-semantic.test.ts`.

## M20 — Bun AOT DX 🚧 *(in progress)*

Surface de autoria e ORM ajustada para que `bun build --compile --aot` gere layout fixo nos caminhos
quentes, sem workarounds no app consumidor (baseline `--explain=json`: 49.143 causas de slow path,
causa #1 no helper de tabela genérico).

- ✅ **M20.1 builder de tabela fluente** — `table(name, shape).extend(meta).extendIf(cond, meta).use(preset).index(...).stringIds().build()`. `TableBuilder` é alias de `TableDef` (zero quebra); o spread genérico sai do app e acontece dentro da lib, compilada uma vez. Guards de literal concreto mantidos. Testes: `aot-builder.{assert,test}.ts`.
- ✅ **M20.2 presets idempotentes** — `.use()` aceita colunas idênticas já presentes (runtime + tipo); `CheckPresetIdempotent`, `MergePresetShape`, `ApplyPreset`, `useUnchecked`, `useAs`. Toolkit de tipos exportado no entry root (`AnyTableDef`, `AnyTableRef`, `WithSmartId`, `RejectNoDdl`, `RejectBadId`, `CheckPreset`, `PresetCols`, `Fields`, `ZShape`, `PresetColumns`). Testes: `aot-presets.assert.ts`, `table-preset.test.ts`.
- ✅ **M20.3 superfície ORM estática** — `OrmSurface<S,C,P>` tipada e `sc generate:orm`, que gera getters **estáticos** no fonte (o que o AOT exige) com `satisfies OrmSurface`. `ClientRuntime` passa a declarar + atribuir explicitamente cada membro (antes `Object.assign`). Testes: `aot-orm-surface.test.ts`.
- ✅ **M20.4 cache e late binding** — `createOrmClientFactory({cache:'weak'})` com `peek`/`dispose` (substitui o `WeakMap` do app), `orm(() => conn, …)` lazy, `setClientResolver`/`clientRef`. Testes: `aot-orm-surface.test.ts`.
- ✅ **M20.5 inferência de escrita** — `NoInfer` + overload estável em `upsertDelta`, helpers públicos `UpsertDeltaFor`/`InferWriteResult`/`RowOf`, piso `Record<string, unknown>` quando o def é shape-erased. Teste: `aot-upsert-delta.assert.ts`.
- ✅ **M20.6 fronteira `unknown`** — `TypedBoundQuery<B,R>`/`surqlWith` (binds + resultado tipados, overload em `$query`), `selectQuery(from, allowlist)` (linhas com chaves fixas a partir de uma projeção), `s.json<T>()`, `s.regex(string, flags?)` com `RegExp` compilado uma vez na lib. Testes: `aot-raw-json.assert.ts`, `aot-regex-json.test.ts`.
- ✅ **M20.7 zod-compiler — validators AOT para `s.*`** — `sc compile` gera um módulo sintético com os `field.schema`, roda `zod-compiler generate` e escreve `.better-schemic/schema.aot.ts`. A compilação preserva identidade (zod-compiler muta o objeto original): DDL, `.shape`, `instanceof`, `z.toJSONSchema()` e ORM intactos; só a validação ganha o fast path. Subpaths `better-schemic/aot` (ponte) e `better-schemic/plugin` (`betterSchemic()`, adapter `zod-compiler/bun` para `Bun.build`). Teste: `aot-compile.test.ts`.
- ✅ **M20.9 geradores declarativos + `sc generate`** — `defineConfig({ resolve, generators, generated })`; um único comando roda todos os geradores (`--only`, `--watch`, `--config`), resolve paths contra a raiz, aplica `resolve.alias` no jiti da CLI (sem symlink), emite as directives nos gerados e instala o bootstrap via `installVia: 'orm'`/`importIn`. `sc generate:orm`/`sc compile` viram aliases de um gerador só; o alias oculto `generate` do `gen` foi removido. Testes: `generate-config.test.ts`, `cli-smoke.test.ts`.
- ✅ **M20.10 especificadores Zod controlados pela lib** — subpaths `better-schemic/zod` e `better-schemic/zod/core`; `sc compile` reescreve o header do zod-compiler (`from "zod"`, `from "zod/v4/core"`) para eles, eliminando a dependência direta de `zod` no app e garantindo uma única cópia. `generated.zodSpecifier` permite opt-out. Teste: `zod-specifier.test.ts`.
- ✅ **M20.11 convenções de artefatos gerados** — directives `@ts-nocheck`/`eslint-disable` centralizadas e idempotentes; `generated.knip`/`knipAutoWrite` mesclam ignores em `knip.json`, `tsconfig.json`, `bunfig.toml` e `.gitignore`. Teste: `generated-directives.test.ts`.
- ✅ **M20.12 semântica `s.json<T>()`** — `s.jsonValue<T>()` faz parse real para `T` no decode e stringify no encode, com DDL idêntico; `s.json<T>()` mantém o comportamento legado (string JSON) agora documentado. Testes: `json-value.test.ts`, `json-value.assert.ts`.
- ✅ **M20.13 regras de lint do consumidor na lib** — `bunfig.toml` na raiz com o ruleset, plugins e 9 overrides do consumidor; `bun lint`/`bun run lint` verdes. ~35k violações mecânicas corrigidas (Prettier, sort de tipos/imports, regex `u`, comentários, disables justificados em loops). 104 regras que exigem refatoração semântica (ordem de chaves em SQL, `curly`, `any`/unsafe) ficam marcadas como diferidas no próprio arquivo, com justificativa; `bun test` + `bun check` continuam como gate de comportamento.
- ⏳ **M20.8 validação no app** — medir `build:aot:explain-json`, `bun check` e `test:changed` no app consumidor após subir a versão; aplicar a migração para a nova API (agora sem `scripts/generate.ts`, symlink `@`, directives manuais nem `zod` direto).

## Removido (decisão deliberada)

Numa passada de enxugamento para liberar o ORM para mudanças grandes, foram removidos por completo:

- **Live queries / changefeeds** — runtime (`live.ts`, `changes.ts`, compilers, types), API no client/delegate, `DEFINE TABLE … CHANGEFEED`, testes, exemplos e docs. O ORM segue com reads/writes/relaciones/transações/raw/plugins.
- **Gates de verificação pesados** — cobertura (`scripts/coverage/*`, `coverage.config.json`), MC/DC (`scripts/mcdc/*`, configs, manifest), mutation (`scripts/mutation/*`, Stryker), type-bench (`scripts/type-bench.ts`, budgets), jobs correspondentes no CI e suítes parity/e2e/live. Ficam: `bun test` (unit + PBT + fuzz), `bun check`, `bun build` no gate único.

Pretensão: rever a robustez desses testes no futuro, depois das alterações no ORM.
