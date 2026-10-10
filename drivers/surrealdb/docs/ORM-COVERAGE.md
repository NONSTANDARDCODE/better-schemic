# ORM Coverage — `@better-schemic/surrealdb`

An exhaustive, honest map of the **runtime ORM surface** — the `/orm` client (`betterSchemic` /
`createBetterSchemic`, one delegate per schema entry). This is deliberately **separate** from:

- [`COVERAGE.md`](./COVERAGE.md) — the **schema/DDL** surface (what a migration defines; kind registry).
- [`orm-syntax-map.md`](./orm-syntax-map.md) — the **live-verified SurrealQL** ground truth (89 probes).

The ORM emits **runtime SurrealQL** (SELECT/CREATE/UPDATE/…), not DDL, so it gets its own matrix.

**Legend:** `[ ]` not implemented · `[~]` partial (guarded/limited form, or accepted for less than the
full shape) · `[x]` full, end-to-end (typed author → compile → execute → decode), with a unit + live test.

A `[x]` feature is backed by a **unit golden** (`test/unit/orm-*.test.ts`) and, where the server matters,
a **live probe** (`test/live/orm-*.test.ts`, skips without the `surreal` binary; probed on SurrealDB
3.2.0). Type-level surface is proven by `test/types/orm-*.assert.ts`. Tests marked `~` are
compile-only-proven (`[~]` status) — the exact SurrealQL is a behavioral divergence recorded in
`orm-syntax-map.md` §1.

> **Conventions.** Every operation compiles **eagerly** (a bad arg throws at the call site) and runs
> **lazily** (nothing touches the connection until awaited). Writes run immediately. `.explain()` exists
> on reads only. Argument validity is enforced at compile time — the guards below are **teaching errors**
> (a code from `BetterSchemicErrorCode`), not silent fallbacks.

---

## 0. Bootstrap & connections

| Feature | Status | Surface / test |
|---|---|---|
| `betterSchemic(conn, { schema, debug?, transaction?, live?, raw?, hooks?, plugins? })` — BYO connection | `[x]` | `test/unit/orm-client.test.ts`; `test/types/orm-client.assert.ts` |
| `createBetterSchemic({ url, namespace?, database?, auth?, connectTimeoutMs?, schema, … })` — managed | `[x]` | `test/live/orm-client.test.ts:38` ("createBetterSchemic connects, authenticates") |
| `client.close()` / `[Symbol.asyncDispose]` — BYO no-op, managed tears down | `[x]` | `test/unit/orm-client.test.ts:185`; `test/live/orm-client.test.ts:64` |
| `client.tables`, `client.repository(name)` (key or physical; `RepositoryNotFound`) | `[x]` | `test/unit/orm-client.test.ts` |
| `client.$sdk` escape hatch, `$index` | `[x]` | `test/unit/orm-client.test.ts:103` |
| `client.query<T>(sql, vars?)` — one raw statement → first statement's rows (the neutral `ctx.connections.<name>.query` handle) | `[x]` | `test/unit/chained-config.test.ts` (live cross-connection) |
| `surrealConnection(config \| resolver)` — authoring-side connection entry/fleet | `[x]` | `src/connection.ts`; `test/types/orm-client.assert.ts` |
| Connection params (`authLevel` root/ns/db, `params`, `check`, env timeouts) | `[x]` | `src/connect.ts`; `test/live/orm-client.test.ts` |
| Reserved schema-key / member collisions → `SchemaInvalid`; `$`-prefixed keys reserved; `then` guarded | `[x]` | `test/unit/orm-client.test.ts:121` |

## 1. Reads

Entry: `createReadOperations` (`reads.ts`); compiler `compiler/{select,aggregate,pagination,unique,projection,where}.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| `findMany` — lazy thenable array, eager compile | `[x]` | `test/unit/orm-reads.test.ts`; `test/live/orm-reads.test.ts:76` |
| `findFirst` / `findOne` — forces `limit:1`, miss ⇒ `null` | `[x]` | `test/unit/orm-reads.test.ts:471`; `test/live/orm-reads.test.ts:191` |
| `findUnique({ where })` — `id` or **single-field UNIQUE**; else `UniqueTargetRequired` | `[x]` | `test/unit/orm-reads.test.ts:534`/`:590`; `test/live/orm-reads.test.ts:386` |
| `count` — `SELECT count() … GROUP ALL` | `[x]` | `test/unit/orm-reads.test.ts:623`; `test/live/orm-reads.test.ts:200` |
| `exists` — `SELECT VALUE id … LIMIT 1` | `[x]` | `test/unit/orm-reads.test.ts:645`; `test/live/orm-reads.test.ts:200` |
| `aggregate` — `_count`, path, `{sum,avg,min,max,median,stddev,variance,collect,distinct}`, fragment | `[x]` | `test/unit/orm-reads.test.ts:683`; `test/live/orm-reads.test.ts:214` |
| `paginate` — data+count in ONE round-trip, offset envelope | `[x]` | `test/unit/orm-pagination.test.ts:47`; `test/live/orm-reads.test.ts:268` |
| `cursor` — keyset tuple, unique tiebreaker, before/after; ordered fields the `select` misses ride reserved `_keyset_<n>` aliases (read for the cursors, stripped from `data`); cursor values are the RAW stored values (`DateTime` keeps ns — never the codec-decoded app value) | `[x]` | `test/unit/orm-cursor.test.ts:62`/`:992`; `test/live/orm-reads.test.ts:307`/`:403` |
| `where` — full operator vocabulary | `[x]` | `test/unit/orm-where.test.ts`; `test/live/orm-reads.test.ts:414` |
| `select` — array / projection object, paths, aliases, `*`, nested, expressions | `[x]` | `test/unit/orm-reads.test.ts:63`/`:80`/`:92` |
| `omit` — `(keyof App)[]` | `[x]` | `test/unit/orm-reads.test.ts:101` |
| `value` — exactly one projected expression | `[x]` | `test/unit/orm-reads.test.ts:107` |
| `only` — `FROM ONLY` single-result contract | `[x]` | `test/unit/orm-reads.test.ts:113`; `test/live/orm-syntax.test.ts:1157` |
| `orderBy` — fields/aliases + bare fragments (parenthesized expr rejected) | `[x]` | `test/unit/orm-reads.test.ts:192`/`:347` |
| `limit` / `start` — bound params | `[x]` | `test/unit/orm-reads.test.ts:119` |
| `range` — `{ start, end, inclusive? }` → `t:a..b` / `..=b` | `[x]` | `test/unit/orm-reads.test.ts:178`; `test/live/orm-reads.test.ts:138` |
| `split` — array unfold (exclusive with group) | `[x]` | `test/unit/orm-reads.test.ts:141`; `test/live/orm-reads.test.ts:146` |
| `groupBy` / `groupAll` — require explicit projection | `[x]` | `test/unit/orm-reads.test.ts:148`; `test/live/orm-reads.test.ts:160` |
| `with` — `WITH INDEX` / `WITH NOINDEX` | `[x]` | `test/unit/orm-reads.test.ts:129`/`:310`; `test/live/orm-reads.test.ts:181` |
| `timeout` — `TIMEOUT` | `[x]` | `test/unit/orm-reads.test.ts:163` |
| `version` — `VERSION d'…'` (versioned backend only; else structured error) | `[x]` | `test/live/orm-syntax.test.ts:477` |
| `include` — links, edges, `_count` (see §3) | `[x]` | `test/unit/orm-include.test.ts` |
| `explain: true` / `.explain()` — plan only, never executes; reads only | `[x]` | `test/unit/orm-reads.test.ts:822`; `test/live/orm-reads.test.ts:362` |
| Result shape dispatch (`ResultOf` on select/omit/value/split + include overlay) | `[x]` | `test/types/orm-reads.assert.ts` |
| Row decoding (`decodeRows`/`decodeRow`) — full/omit/leaf/value/include hydration; compiled fast path skips Zod for primitive leaves/arrays (falls back to the full decode on mismatch, so errors are identical) | `[x]` | `test/unit/orm-decode.test.ts` (incl. a pure-Zod parity fuzz) |
| `meta` (hook metadata) on reads | `[x]` | `test/unit/orm-hooks.test.ts:83` |
| `context` per-call override | `[x]` | `test/unit/orm-context.test.ts:37` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| `parallel` | `[ ]` | removed (`orm-syntax-map.md` §1: server parse error); passing it → `UnsupportedCapability`. `test/unit/orm-reads.test.ts:238` |
| `take` / `skip` aliases | `[ ]` | renamed to `limit`/`start`; → `ValidationError`. `test/unit/orm-reads.test.ts:238` |
| `fuzzy` / `anyFuzzy` / `allFuzzy` | `[ ]` | 3.x operators are parse errors; use `string::similarity::*` fragments. `test/unit/orm-where.test.ts:415` |
| `having` (aggregate) | `[ ]` | → `HavingUnsupported`. `test/unit/orm-reads.test.ts:756` |
| `aggregate` + `split` | `[ ]` | mutually exclusive → `ClauseNotSupported`. `test/unit/orm-reads.test.ts:774` |
| `orderBy` parenthesized expression | `[ ]` | server parse error; fragments must be bare. `test/live/orm-syntax.test.ts:1212` |

## 2. Writes

Entry: `createWriteOperations` (`writes.ts`); compiler `compiler/{write,mutate,relate,write-shared}.ts`; runtime delta helpers `delta.ts`.
Writes are **eager** (run immediately, no `.explain()`).

| Feature | Status | Surface / test |
|---|---|---|
| `create` — `CREATE [ONLY] t:id CONTENT`; string id → `RecordId` | `[x]` | `test/unit/orm-writes.test.ts:21`; `test/live/orm-writes.test.ts:86` |
| `createMany` — one `CREATE` per row, ONE round-trip (implicit tx) | `[x]` | `test/unit/orm-writes.test.ts:73`; `test/live/orm-writes.test.ts:109` |
| `createMany` `skipDuplicates` — one `INSERT IGNORE` per row; id-less rows get the generated id | `[x]` | `test/unit/orm-id-strategy.test.ts`; `test/live/orm-id-strategy.test.ts` |
| `create.relate` sugar — `LET … CREATE ONLY; RELATE; RETURN` | `[x]` | `test/unit/orm-writes.test.ts:109`; `test/live/orm-writes.test.ts:131` |
| `idStrategy` — per-table create-id generation (`ulid` default, `uuid` v7, `rand`); explicit id + singleton win; schema-versioned by `defineSchema` (id-field inference + conflict fail-fast; a pinned uuid v4/v6 id field resolves to `"none"` — explicit ids only, generated creates fail at compile time) | `[x]` | `CREATE type::record(s"t", rand::ulid())` / INSERT `id` expression / upsert target-expression. No DDL (migrations never diff); raw SQL + `sc pull` keep/fall back to the server default. `test/unit/orm-id-strategy.test.ts`; `test/live/orm-id-strategy.test.ts` |
| `insert` — `INSERT INTO` + `onDuplicate` (`ignore`/`update`/map) | `[x]` | `test/unit/orm-writes.test.ts:125`; `test/live/orm-syntax.test.ts:1269` |
| `insertMany` — single `INSERT`, batched | `[x]` | `test/unit/orm-writes.test.ts:169`; `test/live/orm-writes.test.ts:158` |
| `update` — unique `where`, **never creates**; modes `merge`/`set`/`content`/`replace`/`patch` | `[x]` | `test/unit/orm-writes.test.ts:184`; `test/live/orm-writes.test.ts:194` |
| `update` `unset` (extra statement with data) | `[x]` | `test/unit/orm-writes.test.ts:236`; `test/live/orm-writes.test.ts:194` |
| `updateMany` — optional `where` (whole table) | `[x]` | `test/unit/orm-writes.test.ts:296`; `test/live/orm-writes.test.ts:240` |
| `patch` — JSON Patch (`add/remove/replace/move/copy/test`, validated) | `[x]` | `test/unit/orm-writes.test.ts:304`; `test/live/orm-writes.test.ts:261` |
| `upsert` — alvo `where` id/UNIQUE, inferido de `data.id` ou **sem alvo = `CREATE` puro** (id por `idStrategy`); **STRICT by default** (`UPDATE ONLY t:id` / `UPDATE … WHERE uniq`, miss → `ResultNotFound`); `onMissing:"create"` = create-or-update (`data` ou `create`+`update`); a mensagem do miss vem do plano (`strictMiss`) | `[x]` | `test/unit/orm-writes.test.ts:359`; `test/live/orm-writes.test.ts:285`/`:338`; guardas target-less `:531`; tenant `test/unit/orm-plugins-tenant.test.ts` |
| `upsertDelta` — **STRICT update by default** (`onMissing:"throw"`) em UMA ida, devolvendo `record`/`before`/`delta`/`changed` **decodificados** (`RETURN VALUE { before: $before, after: $after }`); alvo por `where`, `data.id` ou create sem alvo; `onMissing:"create"` = create-or-update | `[x]` | `test/unit/orm-mutate-delta.test.ts`; `test/live/orm-writes-delta.test.ts`; probes `test/live/orm-syntax.test.ts` (`UPSERT DELTA` + `STRICT upsert lowering`) |
| `upsertMany` — ids ⇒ `ON DUPLICATE`; else `conflict` (single UNIQUE) required | `[x]` | `test/unit/orm-writes.test.ts:416`; `test/live/orm-writes.test.ts:321` |
| `delete` — unique `where`, `return` `before`/`none` | `[x]` | `test/unit/orm-writes.test.ts:436`; `test/live/orm-writes.test.ts:347` |
| `deleteMany` — optional `where`; without it requires `all:true` (`UnsafeMutation`) | `[x]` | `test/unit/orm-writes.test.ts:463` |
| `updateEach` — one `UPDATE … WHERE by=…` per item (no `FOR`); `onEmpty` | `[x]` | `test/unit/orm-writes.test.ts:473`; `test/live/orm-writes.test.ts:372` |
| `relate` — endpoints validated vs declared FROM/TO | `[x]` | `test/unit/orm-writes.test.ts:547`; `test/live/orm-writes.test.ts:424` |
| `relateMany` — one `RELATE` per item, transactional | `[x]` | `test/unit/orm-writes.test.ts:561`; `test/live/orm-writes.test.ts:424` |
| `unrelate` / `unrelateMany` — `DELETE edge WHERE in/out` / `where`+`all` | `[x]` | `test/unit/orm-writes.test.ts:588`; `test/live/orm-writes.test.ts:424` |
| `return` semantics — `after`/`before`/`diff`/`none`, diff flattening | `[x]` | `test/unit/orm-writes-returns.test.ts`; `test/live/orm-writes.test.ts:483` |
| `select`/`omit` no retorno de toda escrita — o servidor carrega a projeção no próprio `RETURN <proj>` (paths aninhados, aliases, expressões, `*`; `OMIT` é parse error no servidor); BEFORE/`delete`/`upsertDelta`/`create.relate`/omit são decodificados inteiros e projetados no cliente (entradas de expressão → `ReturnNotSupported`); resultado tipado pelo `ResultOf` das leituras | `[x]` | `test/unit/orm-writes-projection.test.ts`; probes `test/live/orm-syntax.test.ts` (`WRITE PROJECTIONS`); `test/types/orm-writes.assert.ts` |
| Ajustes `{ increment: n }` / `{ decrement: n }` em `data` — `SET f ±= $p` (merge achata objetos aninhados em leaves para preservar o merge profundo; `set` mantém atribuições top-level); operandos number/bigint/Decimal/expressão; alvo validado (campo numérico, não-`id`) | `[x]` | `test/unit/orm-writes-projection.test.ts`; probe `test/live/orm-syntax.test.ts` (`SET ±=`) |
| Batch atomicity — transactional batches wrap `BEGIN/COMMIT` | `[x]` | `test/unit/orm-execute.test.ts:39`; `test/live/orm-execute.test.ts:69` |
| Write identity — `id`/`in`/`out` never updatable; expressions bypass codec | `[x]` | `test/unit/orm-writes.test.ts:31`/`:52`; `test/live/orm-syntax.test.ts:1270` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| `delete`/`deleteMany` `return` `after`/`diff` | `[ ]` | only `before`/`none` → `ReturnNotSupported`. `test/unit/orm-writes.test.ts:448` |
| `updateEach` `return` `before`/`diff`; `mode:"replace"` | `[ ]` | only `after`/`none`; replace excluded. `test/unit/orm-writes-returns.test.ts:293` |
| `upsert`/`upsertMany` `RETURN DIFF` with expressions or explicit map | `[ ]` | → `ReturnNotSupported`. `test/unit/orm-writes-returns.test.ts:90`/`:152` |
| `upsert` strict + `RETURN DIFF` | `[ ]` | → `ReturnNotSupported` (diff vazio não distingue "não casou" de "não mudou"); `test/unit/orm-writes.test.ts` |
| `upsert` `mode:"patch"` | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:393` |
| `upsertDeltaMany` (batch) | `[ ]` | fora de escopo; o compiler do singular fica reutilizável |
| `upsertDelta` com `onMissing:"throw"` + `create`/`update` | `[ ]` | estrito nunca cria → `ValidationError` (passe `data`/`update`). `test/unit/orm-mutate-delta.test.ts` |
| `upsert`/`upsertDelta` sem alvo com `mode`/`onMissing:"throw"` explícito/branches distintos | `[ ]` | create puro não tem branch de update → `ValidationError` (`assertTargetlessCreate`). `test/unit/orm-writes.test.ts:531`; `test/unit/orm-mutate-delta.test.ts` |
| `create.relate` + `return:"diff"`; `relateMany` per-item `return` | `[ ]` | → `ReturnNotSupported` / `ValidationError`. `test/unit/orm-writes-returns.test.ts:230`/`:243` |
| `insert` with array `data` | `[ ]` | use `insertMany`. `test/unit/orm-writes.test.ts:154` |
| `upsertMany` without ids and no `conflict` | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:424` |
| `relate`/`unrelate` on a plain (non-relation) table | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:581` |
| `select`/`omit` + `return:"diff"` | `[ ]` | diff is a patch list, not rows → `ReturnNotSupported`. `test/unit/orm-writes-projection.test.ts` |
| expression entries in a client-projected state (BEFORE/`delete`/`upsertDelta`/`create.relate`) | `[ ]` | only the server computes expressions → `ReturnNotSupported`. `test/unit/orm-writes-projection.test.ts` |
| `{ increment/decrement }` on create-shaped payloads (`create`/`insert`/`relate` data/`onDuplicate` maps/`upsertMany.update`/the create branch of upserts) | `[ ]` | no previous value → `ValidationError`; `update`/`updateMany`/`updateEach`/strict `upsert` and the update branch of `create`+`update` adjust. `test/unit/orm-writes-projection.test.ts` |

## 3. Relations & graph

Compiler `compiler/include/*`, `compiler/relations.ts`; types `types/{include,relations,where}.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| Include link `true` → FETCH (last clause) | `[x]` | `test/unit/orm-include.test.ts:60` |
| Include link `{ select }` → remounted aliases (presence leaf for absent) | `[x]` | `test/unit/orm-include.test.ts:75`; `test/live/orm-relations.test.ts:88` |
| Nested include — **only `true` nested projected links** | `[~]` | `test/unit/orm-include.test.ts:60`/`:540` (a projected nested link → `ClauseNotSupported`) |
| Graph edge `{ target }` / `{ edge }` / `{ edge, target }` / `{ wildcard }` | `[x]` | `test/unit/orm-include.test.ts:168`; `test/live/orm-relations.test.ts:119` |
| Edge opts `where`/`orderBy`/`limit`/`start`/`direction` | `[x]` | `test/unit/orm-include.test.ts:181`/`:200`; `test/live/orm-syntax.test.ts:596` |
| `direction` incl. `both`; wildcard `->?`/`<-?` | `[x]` | `test/unit/orm-include.test.ts:226`; `test/live/orm-syntax.test.ts:663` |
| `_count` include — links + edges, NONE-safe | `[x]` | `test/unit/orm-include.test.ts:325`; `test/live/orm-relations.test.ts:274` |
| Relational `where` — `is`/`isNot`, `some`/`none`/`every` | `[x]` | `test/unit/orm-include.test.ts:386`; `test/live/orm-relations.test.ts:304` |
| Relational `where` on write batches (`updateMany`/`deleteMany`/`unrelateMany`) | `[x]` | `test/unit/orm-include.test.ts:472`; `test/live/orm-relations.test.ts:230` |
| Recursion/traversal via `select` + `surql` (`@.{n..m}`) | `[x]` | `test/unit/orm-include.test.ts:493`; `test/live/orm-relations.test.ts:378` |
| `include` with `findUnique`/`paginate`/`cursor` | `[x]` | `test/unit/orm-include.test.ts:690` |
| Schema adjacency / relation metadata; link name-collision at bootstrap | `[x]` | `test/unit/orm-schema.test.ts:177` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| Nested projected include; nested FETCH across >1 target | `[~]` | nested `include.include` supports only `true`. `compiler/include/links.ts` |
| `include` + `value`/`split`/`groupBy`/`groupAll` | `[ ]` | → `ClauseNotSupported`. `test/unit/orm-include.test.ts:390` |
| `edge`+`target`+`direction:"both"` | `[ ]` | teaching error. `test/unit/orm-include.test.ts:288` |
| Use of `"id"` as an include key | `[ ]` | → `ValidationError`. `compiler/include/index.ts:109` |

## 4. Live queries & changefeeds

Runtime `live.ts`, `changes.ts`; compilers `compiler/{live,changes}.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| `delegate.live(args?, handler?)` / `client.live(table, …)` | `[x]` | `test/unit/orm-live.test.ts:105`; `test/live/orm-live.test.ts:72` |
| Live `where` / `select` / `fetch` | `[x]` | `test/unit/orm-live.test.ts:106`/`:121`; `test/live/orm-live.test.ts:141` |
| `diff: true` — `LIVE SELECT DIFF` (no projection) | `[x]` | `test/unit/orm-live.test.ts:121`; `test/live/orm-syntax.test.ts:1127` |
| `LiveSubscription` — `uuid`/`isAlive`/`kill()`/`onError`/async-iterable | `[x]` | `test/unit/orm-live.test.ts:150` |
| Notification actions `CREATE`/`UPDATE`/`DELETE`/`KILLED`/`RECONNECTED` | `[x]` | `test/unit/orm-live.test.ts:150`; `test/live/orm-live.test.ts:100` |
| Auto-reconnect (`live.reconnect` default `true`) | `[x]` | `test/unit/orm-live.test.ts:236` |
| `client.liveOf(uuid)` — reattach (values NOT decoded) | `[x]` | `test/unit/orm-live.test.ts:293` |
| `client.kill(uuid)` — `KILL $p`, idempotent | `[x]` | `test/unit/orm-live.test.ts:223`; `test/live/orm-syntax.test.ts:1621` |
| `client.changes(args?)` — `SHOW CHANGES FOR TABLE\|DATABASE SINCE …` | `[x]` | `test/unit/orm-changes.test.ts:33`; `test/live/orm-changes.test.ts:54` |
| Change normalization — `UPDATE`/`DELETE`/`DEFINE`, `bigint` versionstamp, pagination | `[x]` | `test/unit/orm-changes.test.ts:80`; `test/live/orm-changes.test.ts:103` |
| Changefeed schema (`CHANGEFEED … INCLUDE ORIGINAL`) | `[x]` | `test/live/orm-changes.test.ts:54` (see `COVERAGE.md` for DDL) |
| Time-travel `version` (read arg) | `[x]` | `test/unit/orm-reads.test.ts:163`; `test/live/orm-syntax.test.ts:477` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| ORDER BY/LIMIT/GROUP/SPLIT/include/only/value in `live` | `[ ]` | → `ClauseNotSupportedInLive`. `test/unit/orm-live.test.ts:132` |
| `live` inside a transaction | `[ ]` | → `LiveInTransaction`. `test/unit/orm-live.test.ts:317` |
| `live` over a transport without websockets | `[ ]` | → `LiveQueryUnsupported`. `test/unit/orm-live.test.ts:338` |
| `LIVE` projection with `diff` | `[ ]` | `diff` + `select` rejected. `test/unit/orm-live.test.ts:132` |

## 5. Raw, admin, auth, API, functions, session

Runtime `raw.ts`, `execute.ts`, `admin.ts`, `auth.ts`, `api.ts`, `fn.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| `$raw` tagged template / `$raw(options)` curried — first statement, throwOnError on | `[x]` | `test/unit/orm-raw.test.ts:20`; `test/live/orm-raw.test.ts:80` |
| `$query` — many statements/one round-trip; `throwOnError:false` → per-statement results | `[x]` | `test/unit/orm-raw.test.ts:69`; `test/live/orm-raw.test.ts:80` |
| `$unsafe(sql, params?)` — gated by `raw.unsafe`; else `UnsafeDisabled` | `[x]` | `test/unit/orm-raw.test.ts:102` |
| `RawOptions`/`RawDefaults` — timeout injection, `raw.requireComment` | `[x]` | `test/unit/orm-raw.test.ts:119`; `test/live/orm-syntax.test.ts:1778` |
| Raw context/transaction awareness (`USE …;` prefix, wraps before `BEGIN`) | `[x]` | `test/unit/orm-raw.test.ts:175`; `test/live/orm-raw.test.ts:115` |
| `execute`/`runScript`/`terminate`/`Queryable`/`Statement` | `[x]` | `test/unit/orm-execute.test.ts`; `test/live/orm-execute.test.ts` |
| `client.info(level, table?)` — `INFO FOR ROOT\|NS\|DB\|TABLE` typed | `[x]` | `test/unit/orm-admin.test.ts:139`; `test/live/orm-syntax.test.ts:1752` |
| `client.version()` / `client.ping()` | `[x]` | `test/unit/orm-admin.test.ts:156`; `test/live/orm-raw.test.ts:214` |
| `client.export()` / `client.import(dump)` — session-bound / replay | `[x]` | `test/unit/orm-admin.test.ts:167`; `test/live/orm-raw.test.ts:214` |
| `client.auth` — `signin`/`signup`/`authenticate`/`invalidate`/`record<T>()` | `[x]` | `test/unit/orm-admin.test.ts:94`; `test/live/orm-raw.test.ts:242` |
| `client.api` — `get/post/put/patch/delete` (+query/headers/body) | `[x]` | `test/unit/orm-admin.test.ts:44`; `test/live/orm-raw.test.ts:194` |
| `client.fn` — `fn.call<R>(name, args)` + typed shortcut per `defineFunction` | `[x]` | `test/unit/orm-fn.test.ts`; `test/live/orm-syntax.test.ts:1763` |
| Session-bound ops rejected on a prefix clone (`api`/`auth`/`export`/`live`) | `[x]` | `test/unit/orm-context.test.ts:84`; `test/live/orm-raw.test.ts:141` |

## 6. Context & multi-connection

Runtime `context.ts`; `$withContext`, `forkSession`, `extends`.

| Feature | Status | Surface / test |
|---|---|---|
| `OperationContext` `{ namespace?, database?, meta? }` (shared + per-call) | `[x]` | `test/unit/orm-context.test.ts:37`; `test/types/orm-m5.assert.ts` |
| `$withContext(ctx?)` sync clone — `USE NS … DB …;` prefix, no session mutation | `[x]` | `test/unit/orm-context.test.ts:16` |
| Per-call `context` overrides the clone | `[x]` | `test/unit/orm-context.test.ts:37` |
| `$withContext({ …ctx, auth })` → `Promise<Client>` (fork + use + authenticate) | `[x]` | `test/unit/orm-context.test.ts:107`; `test/live/orm-raw.test.ts:228` |
| `resolveContext`/`contextPrefix`/`contextOption`/`resolveMeta` fallback chain | `[x]` | `test/unit/orm-hooks.test.ts:83` |
| `forkSession()` — scoped disposable session; helpers re-applied | `[x]` | `test/unit/orm-client.test.ts:194`; `test/live/orm-client.test.ts:81` |
| `extends` (object/factory) — re-applied on clones/forks/tx; collision → `PluginError` | `[x]` | `test/unit/orm-client.test.ts:149`; `test/unit/orm-context.test.ts:155` |
| Multi-connection — `surrealConnection` neutral entry, bulk fleet | `[x]` | `src/connection.ts` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| ns/db required by `$withContext` — no side anywhere → teaching `ValidationError` | `[x]` guard | `test/unit/orm-context.test.ts:48` |
| `$withContext` auth/`forkSession` without the SDK | `[ ]` | → `UnsupportedCapability`. `test/unit/orm-context.test.ts:108` |

## 7. Hooks & plugins

Runtime `hooks.ts`, `plugins.ts`; built-ins `src/plugins/*` (subpaths `plugins/{rules,zod,timestamps,soft-delete,create-only,tenant}`).

| Feature | Status | Surface / test |
|---|---|---|
| Hook families — reads/writes/relate/raw/transaction/`onError` | `[x]` | `test/unit/orm-hooks.test.ts` (reads `:36`, writes `:119`, raw/errors/tx `:180`) |
| Dispatcher semantics — `before*` aborts; `after*`/`on*Error` → `onError` (console fallback) | `[x]` | `test/unit/orm-hooks.test.ts:293`/`:299`/`:320` |
| Fast path — no hooks ⇒ dispatcher `undefined`, zero overhead | `[x]` | `test/unit/orm-hooks.test.ts:292` |
| `.explain()` fires no hooks | `[x]` | `test/unit/orm-hooks.test.ts` |
| `definePlugin(spec)` — `id`/`operationArgs`/`setup`/`transform`/`hooks`/`extend*` | `[x]` | `test/unit/orm-plugins.test.ts`; `test/types/orm-m6.assert.ts` |
| `transform` — mutates args, re-dispatches `kind`, `false` skips | `[x]` | `test/unit/orm-plugins.test.ts:26`/`:42`/`:91` |
| Plugin bootstrap validation — duplicate/colliding id, `setup` throw → `PluginError` | `[x]` | `test/unit/orm-plugins.test.ts:168` |
| `extendClient` / `extendModel` — grafted methods, collision → `PluginError` | `[x]` | `test/unit/orm-plugins.test.ts:104` |
| `$state` / `$withState` / `$withoutPlugins` | `[x]` | `test/unit/orm-plugins.test.ts:60`/`:78` |
| F1 `plugins/rules` — `noRawUnsafe`/`destructiveWriteWithoutWhere`/`requireLimit`/`maxLimit`/`strict` presets | `[x]` | `test/unit/orm-plugins-rules.test.ts` |
| F1 `plugins/zod` — `{ schemas, validate? }` | `[x]` | `test/unit/orm-plugins-zod.test.ts` |
| F2 `plugins/timestamps` — `app` stamp / `database` strip | `[x]` | `test/unit/orm-plugins-timestamps.test.ts`; `test/live/orm-plugins.test.ts:78` |
| F2 `plugins/soft-delete` — soft `delete`/`deleteMany`, `deleted` filter, `restore`/`restoreById` | `[x]` | `test/unit/orm-plugins-soft-delete.test.ts`; `test/live/orm-plugins.test.ts:49` |
| `Operation.scope` — plugin scope channel ANDed by EVERY compiler (reads: `findMany`/`findUnique`/`count`/`exists`/`aggregate`/`paginate`/`cursor`; writes incl. singular targets `update`/`patch`/`delete`/`upsert`/`updateEach`; never joins `uniqueTarget`) | `[x]` | `test/unit/orm-reads.test.ts` (plugin scope); `test/unit/orm-mutate-compiler.test.ts` (plugin scope); `test/unit/orm-plugins-tenant.test.ts` |
| Preset `{table}` placeholders + opaque `meta` (A1/A2) | `[x]` | `test/unit/table-preset.test.ts` |
| `surql.ident(name)` — escaped identifier fragment for presets/plugins | `[x]` | `test/unit/surql-ident.test.ts` |
| F3 `plugins/tenant` PRESET — `tenant(principal, options?)` column/permissions/guard event/indexes + `meta.tenant` (zero-diff with the manual recipe) | `[x]` | `test/unit/tenant-preset.test.ts`; `test/types/orm-tenant.assert.ts` |
| F3 `plugins/tenant` RUNTIME — `tenantRls`, `$forTenant`, fail-closed scope, payload/where divergence, scoped reads (incl. `findUnique` id/unique targets), `replace`-mode injection, ON DUPLICATE refusal, bootstrap validation, soft-delete combo | `[x]` | `test/unit/orm-plugins-tenant.test.ts`; `test/live/orm-plugins-tenant.test.ts` |
| M14 `plugins/create-only` PRESET — `createOnly({ hard? })`: `PERMISSIONS FOR update NONE` (AND-narrowed), `meta.createOnly`, optional `{table}_create_only` event (blocks even root/raw) | `[x]` | `test/unit/create-only-preset.test.ts`; `test/parity/struct-parity.test.ts` |
| M14 `plugins/create-only` RUNTIME — `createOnlyGuard({ tables? })`: update family + `insert({ onDuplicate: "update" \| map })` → `CreateOnlyViolation` before compiling; hard-aware hint; per-index tag cache | `[x]` | `test/unit/orm-plugins-create-only.test.ts`; `test/live/orm-plugins.test.ts` |
| M14 `timestamps()` create-only interop — tagged tables never get `updatedAt` (create or bypassed update), order-independent | `[x]` | `test/unit/orm-plugins-timestamps.test.ts` |
| Type-level extraction — `PluginArgs`/`PluginClientExtras`/`PluginModelExtras` | `[x]` | `test/types/orm-m6.assert.ts` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| `soft-delete` filtering on `findUnique` | `[x]` by design | `where` is the unique target — filtering would break `uniqueTarget`; documented in-code |
| `soft-delete` `deletedBy` from `meta.actor` | `[x]` | `test/unit/orm-plugins-soft-delete.test.ts` |
| `restore`/`restoreById` via `UNSET` (not `SET null`) | `[x]` | codec `date().optional()` rejects `null`; documented in-code |
| `tenant` runtime scope on `relate*`/`unrelate*`, `live`, `changes`, `$raw`/`$query`/`$unsafe` | `[x]` by design | the DB permission (or `$withoutPlugins()`) is the boundary; documented in-code |
| `tenant` runtime on `insert({ onDuplicate: "update" \| map })` and `upsertMany` by ids | `[x]` fail-closed | `INSERT … ON DUPLICATE KEY UPDATE` has no `WHERE` (cross-tenant write) → `TenantViolation`; use `upsert({ data })`/`conflict` |
| `tenant` runtime on `upsert({ create, update })` by id | `[x]` fail-closed | the `INSERT … ON DUPLICATE` lowering has no scoped form → teaching `UnsupportedCapability`; use `upsert({ data })` |
| `create-only` guard on raw SQL (`$raw`/`$query`/`$unsafe`), `$sdk`, `relate*`/`unrelate*` | `[x]` by design | the preset's DB permission (record users) and the opt-in `hard` event (every session, raw included) are the boundary; documented in-code |
| `create-only` guard on a pulled schema (`sc pull`) | `[x]` by design | `meta` markers are not recoverable from the DB → pass `createOnlyGuard({ tables: [...] })`; the permission/event persist in the DDL |
| `create-only` on `insert({ onDuplicate: "ignore" })` / plain insert | `[x]` allowed | `INSERT IGNORE` never updates — the idempotent-create idiom for append-only tables |
| `create-only` blocks delete? | `[x]` by design | NO — create-only = immutable rows, not tombstones; only the update family is rejected (`hard` emits `WHEN $event = 'UPDATE'`) |

## 8. Types, errors & results

Runtime `errors.ts`, `results.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| `BetterSchemicError` — `code`/`status`/`table`/`field`/`surql`/`vars`/`cause`; `from()` | `[x]` | `test/unit/orm-errors.test.ts` |
| Error-code catalog (29 codes, per-code default HTTP status — incl. `TenantRequired`/`TenantViolation`/`CreateOnlyViolation`, 403) | `[x]` | `test/unit/orm-errors.test.ts:36` |
| `normalizeError` — SDK `ServerError` mapping, Zod issue → `ValidationError` | `[x]` | `test/unit/orm-errors.test.ts:146` |
| Predicates — `isUniqueViolation`/`isNotFound`/`isValidationError`/`isTenantViolation`/`isCreateOnlyViolation`/… | `[x]` | `test/unit/orm-errors.test.ts:224` |
| `ThrowingResult`/`attachThrow`/`NotFoundInfo` — miss ⇒ `null`, `.throw()` | `[x]` | `test/unit/orm-results.test.ts:15` |
| `BatchResult<T>` — `count`/`data`/`skipped`/`statements` | `[x]` | `test/unit/orm-results.test.ts:96` |
| `StatementResult<T>` / `statementResult` | `[x]` | `test/unit/orm-results.test.ts:110` |
| `lazyResult<T>` — lazy thenable | `[x]` | `test/unit/orm-reads.test.ts:397` |
| `.explain()` — reads only; writes have none | `[x]` | `test/unit/orm-writes.test.ts:618` |

## 9. Logging & observability (M9)

Runtime `src/orm/logger/*` (`colors`/`highlight`/`plan`/`logger`); public subpath
`@better-schemic/surrealdb/logger` + the `logger` client option. The logger observes the executor
(`runScript`), so it sees every round-trip — including `.explain()` (which fires no hooks).

| Feature | Status | Surface / test |
|---|---|---|
| `logger` option — `true` / preset / `LoggerOptions`; `BETTER_SCHEMIC_LOG` env fallback | `[x]` | `test/unit/orm-logger.test.ts` (resolveLogger); `test/types/orm-logger.assert.ts` |
| `pretty` frame — box, icons, syntax highlight, binds, rows, duration, counter, timestamp | `[x]` | `test/unit/orm-logger.test.ts`; `test/unit/orm-logger-highlight.test.ts` |
| `compact` / `json` formats (log-shipper friendly, JSON-safe vars) | `[x]` | `test/unit/orm-logger.test.ts` |
| Level gating (`debug`/`info`/`warn`/`silent`) + `slowMs` slow badge | `[x]` | `test/unit/orm-logger.test.ts` |
| SurrealQL tokenizer (keywords/strings/records/`$binds`/`fn::`/durations/comments) + clause wrap | `[x]` | `test/unit/orm-logger-highlight.test.ts` |
| `EXPLAIN` plan renderer — object / indented string / legacy array; `TableScan ⚠` / `IndexScan ✓` | `[x]` | `test/unit/orm-logger-plan.test.ts`; `test/live/orm-logger.test.ts` |
| `.explain()` / `explain: true` plan logging (no hooks fired) | `[x]` | `test/unit/orm-logger.test.ts`; `test/live/orm-logger.test.ts` |
| Auto-explain — `explain: "slow" \| "all" \| "analyze"` (`EXPLAIN [ANALYZE] FORMAT JSON`) | `[x]` | `test/unit/orm-logger.test.ts`; `test/live/orm-logger.test.ts` |
| Coverage — reads/writes/`$raw`/`fn`/admin/changes/live/transactions + `$withContext` scope + errors | `[x]` | `test/unit/orm-logger.test.ts` |
| Zero-overhead when absent / `silent` | `[x]` | `test/unit/orm-logger.test.ts` |

## 10. Errors-guard vocabulary (teaching errors by code)

Every guard below is intentional (a strongly-typed alternative to a silently-wrong query). The
`BetterSchemicErrorCode` is the error contract; see §1–§7 for the triggering call.

| Code | Raised when |
|---|---|
| `UnsupportedCapability` | removed args (`parallel`), SDK-only ops on a non-SDK conn, auth/`forkSession` without SDK |
| `UnsafeDisabled` | `$unsafe` without `raw: { unsafe: true }` |
| `UnsafeMutation` | `deleteMany` without `where` (requires `all:true`) |
| `UnknownField` | unknown include option / where key |
| `ValidationError` | arg shape errors (`take`/`skip`, mixed relational ops, invalid patch, missing `by`); cursor `orderBy` field redefined by a select alias/expression (ORDER BY would bind the alias) |
| `UniqueTargetRequired` | `findUnique`/`update`/`delete` `where` not `id`/single-field UNIQUE |
| `ReturnNotSupported` | unsupported `return` for the op (`after`/`diff` on delete, `diff` on expression upsert) or a projection the lowering can't serve (`select`/`omit` + `diff`; expression entries in a client-projected state) |
| `HavingUnsupported` | `aggregate.having` |
| `ClauseNotSupported` | `aggregate`+`split`, `include`+`value`/`split`/`groupBy`, cursor with group/split/`value`/`only`/`start` |
| `ClauseNotSupportedInLive` | disallowed clause in `live` |
| `LiveInTransaction` / `LiveQueryUnsupported` | `live` in a tx / over a websocket-less transport |
| `CursorDirectionConflict` / `CursorTiebreakerRequired` | `after`+`before`; non-unique last order field |
| `ResultNotFound` / `RecordNotFound` | `.throw()` on a miss |
| `RecordAlreadyExists` | duplicate create |
| `SchemaInvalid` / `RepositoryNotFound` / `PluginError` | bootstrap collisions / unknown repository / plugin id or `extend*` collision |
| `TenantRequired` / `TenantViolation` | `tenantRls`: a tenant-tagged table with no scope; a divergent/forged tenant payload, `where`, patch or `ON DUPLICATE` path (both 403) |

---

## 11. String ids (M15)

The APP surface speaks **bare id strings** (`01M…`); `RecordId` exists only on the wire/DB. The
emitted DDL is UNCHANGED (`record<…>`) — `sc diff`/migrations stay empty. `sc pull` cannot recover
the mode (like `idStrategy`); raw `db.query()`, `live` and `changes` still return `RecordId`.

| Feature | Status | Proving tests |
|---|---|---|
| `s.recordId('customer').stringIds()` / `Table.record().stringIds()` — per-field mode (wire `string \| RecordId`, app `BareId<T>`); decode normalizes `bare`/`table:id`/`table:⟨id⟩`/`RecordId`; encode always `RecordId(table, bare)`; target + valueType validation kept | `[x]` | `test/unit/string-ids.test.ts`; `test/live/string-ids.test.ts` |
| `TableDef.stringIds()` — id + every record field (nested objects/arrays/wrappers/unions) flips; DDL byte-identical; multi-target/open links throw; a value-carrying `.default()`/`.catch()` is authored AFTER `.stringIds()` (bare-string fallback) | `[x]` | `test/unit/string-ids.test.ts` ("emits byte-identical DDL") |
| `TableDef.record()` inherits the id mode; `tenant()` follows the principal; `RelationDef.stringIds()` flips edge + in/out + id; `.from()/.to()` inherit a single string-id endpoint; RELATE accepts a bare endpoint when the direction declares ONE table | `[x]` | `test/unit/string-ids.test.ts`; `test/live/string-ids.test.ts` |
| `where` binds (equals/in/contains/not/any/all + plugin scope) coerce bare strings via the column target; writes (create/update/upsert/updateEach/relate) normalize nested data; `upsertDelta` before/after are bare | `[x]` | `test/unit/string-ids.test.ts`; `test/live/string-ids.test.ts` |
| `cursor` coerces per keyset column (`record` → `RecordId`, `datetime` → `DateTime`) and returns `nextCursor`/`previousCursor` in the APP representation (bare id; raw `DateTime` keeps ns) | `[x]` | `test/unit/string-ids.test.ts`; `test/live/string-ids.test.ts` |
| Types: `BareId<T>` phantom brand, `RecordIdName` resolves targets (relational filters survive), `CreateData`/`UpdateData`/`CursorInput` accept `string \| RecordId` (nested), `TenantField` follows the principal mode | `[x]` | `test/types/orm-string-ids.assert.ts` |
| Cookbook: `examples/orm/string-ids.ts` (capture golden) | `[x]` | `test/examples/orm-reference.test.ts` |

---

## At a glance

| Area | Status |
|---|---|
| Reads (`find*`, projection, where, order/limit/range, groups, paginate, cursor) | `[x]` — `parallel`/fuzzy/having intentionally `[ ]` |
| Writes (`create`/`insert`/`update`/`upsert`/`delete`/`each`/`relate` + modes + returns) | `[x]` — per-op `return` caps documented |
| Write projections (`select`/`omit` on the returned rows) + `{increment/decrement}` adjustments | `[x]` — server `RETURN <proj>`; client fallback for BEFORE/delete/delta/omit |
| Relations/graph (links, edges, `_count`, relational where, recursion) | `[x]` — nested projected include `[~]` |
| Live/changefeeds (live, DIFF, FETCH, reconnect, `SHOW CHANGES`) | `[x]` |
| Raw/admin/auth/api/fn/session | `[x]` — `$unsafe` gated |
| Context/multi-connection (`$withContext`, `meta`, `forkSession`, `extends`) | `[x]` |
| Hooks/plugins (families, `definePlugin`, F1 `rules`/`zod`, F2 `timestamps`/`soft-delete`, F3 `tenant`) | `[x]` |
| Logger (`logger: true`/presets, `EXPLAIN` plan rendering, auto-explain, `@better-schemic/surrealdb/logger`) | `[x]` |
| String ids (`TableDef.stringIds()` / `s.recordId(…).stringIds()`, bare app strings; DDL unchanged) | `[x]` — raw `db.query`/`live`/`changes` keep `RecordId` |
| Types/errors/results (28 codes, predicates, throwing/lazy results, explain) | `[x]` |

> **Not in this document:** DDL/schema authoring → [`COVERAGE.md`](./COVERAGE.md); the raw SurrealQL
> facts the compiler emits (statement shapes, operator semantics, divergences) →
> [`orm-syntax-map.md`](./orm-syntax-map.md). This matrix cites features and their proving tests, not
> golden SurrealQL.
