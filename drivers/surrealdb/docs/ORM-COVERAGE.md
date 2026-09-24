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
| `paginate` — data+count in ONE round-trip, offset envelope | `[x]` | `test/unit/orm-pagination.test.ts:56`; `test/live/orm-reads.test.ts:268` |
| `cursor` — keyset tuple, unique tiebreaker, before/after | `[x]` | `test/unit/orm-pagination.test.ts:214`; `test/live/orm-reads.test.ts:307` |
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
| Row decoding (`decodeRows`/`decodeRow`) — full/omit/leaf/value/include hydration | `[x]` | `test/unit/orm-decode.test.ts` |
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

Entry: `createWriteOperations` (`writes.ts`); compiler `compiler/{write,mutate,relate,write-shared}.ts`.
Writes are **eager** (run immediately, no `.explain()`).

| Feature | Status | Surface / test |
|---|---|---|
| `create` — `CREATE [ONLY] t:id CONTENT`; string id → `RecordId` | `[x]` | `test/unit/orm-writes.test.ts:21`; `test/live/orm-writes.test.ts:86` |
| `createMany` — one `CREATE` per row, ONE round-trip (implicit tx) | `[x]` | `test/unit/orm-writes.test.ts:73`; `test/live/orm-writes.test.ts:109` |
| `create.relate` sugar — `LET … CREATE ONLY; RELATE; RETURN` | `[x]` | `test/unit/orm-writes.test.ts:109`; `test/live/orm-writes.test.ts:131` |
| `insert` — `INSERT INTO` + `onDuplicate` (`ignore`/`update`/map) | `[x]` | `test/unit/orm-writes.test.ts:125`; `test/live/orm-syntax.test.ts:1269` |
| `insertMany` — single `INSERT`, batched | `[x]` | `test/unit/orm-writes.test.ts:169`; `test/live/orm-writes.test.ts:158` |
| `update` — unique `where`, **never creates**; modes `merge`/`set`/`content`/`replace`/`patch` | `[x]` | `test/unit/orm-writes.test.ts:184`; `test/live/orm-writes.test.ts:194` |
| `update` `unset` (extra statement with data) | `[x]` | `test/unit/orm-writes.test.ts:236`; `test/live/orm-writes.test.ts:194` |
| `updateMany` — optional `where` (whole table) | `[x]` | `test/unit/orm-writes.test.ts:296`; `test/live/orm-writes.test.ts:240` |
| `patch` — JSON Patch (`add/remove/replace/move/copy/test`, validated) | `[x]` | `test/unit/orm-writes.test.ts:304`; `test/live/orm-writes.test.ts:261` |
| `upsert` — `where` id/UNIQUE; `data` or `create`+`update` branches | `[x]` | `test/unit/orm-writes.test.ts:346`; `test/live/orm-writes.test.ts:284` |
| `upsertMany` — ids ⇒ `ON DUPLICATE`; else `conflict` (single UNIQUE) required | `[x]` | `test/unit/orm-writes.test.ts:416`; `test/live/orm-writes.test.ts:321` |
| `delete` — unique `where`, `return` `before`/`none` | `[x]` | `test/unit/orm-writes.test.ts:436`; `test/live/orm-writes.test.ts:347` |
| `deleteMany` — optional `where`; without it requires `all:true` (`UnsafeMutation`) | `[x]` | `test/unit/orm-writes.test.ts:463` |
| `updateEach` — one `UPDATE … WHERE by=…` per item (no `FOR`); `onEmpty` | `[x]` | `test/unit/orm-writes.test.ts:473`; `test/live/orm-writes.test.ts:372` |
| `relate` — endpoints validated vs declared FROM/TO | `[x]` | `test/unit/orm-writes.test.ts:547`; `test/live/orm-writes.test.ts:424` |
| `relateMany` — one `RELATE` per item, transactional | `[x]` | `test/unit/orm-writes.test.ts:561`; `test/live/orm-writes.test.ts:424` |
| `unrelate` / `unrelateMany` — `DELETE edge WHERE in/out` / `where`+`all` | `[x]` | `test/unit/orm-writes.test.ts:588`; `test/live/orm-writes.test.ts:424` |
| `return` semantics — `after`/`before`/`diff`/`none`, diff flattening | `[x]` | `test/unit/orm-writes-returns.test.ts`; `test/live/orm-writes.test.ts:483` |
| Batch atomicity — transactional batches wrap `BEGIN/COMMIT` | `[x]` | `test/unit/orm-execute.test.ts:39`; `test/live/orm-execute.test.ts:69` |
| Write identity — `id`/`in`/`out` never updatable; expressions bypass codec | `[x]` | `test/unit/orm-writes.test.ts:31`/`:52`; `test/live/orm-syntax.test.ts:1270` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| `delete`/`deleteMany` `return` `after`/`diff` | `[ ]` | only `before`/`none` → `ReturnNotSupported`. `test/unit/orm-writes.test.ts:448` |
| `updateEach` `return` `before`/`diff`; `mode:"replace"` | `[ ]` | only `after`/`none`; replace excluded. `test/unit/orm-writes-returns.test.ts:293` |
| `upsert`/`upsertMany` `RETURN DIFF` with expressions or explicit map | `[ ]` | → `ReturnNotSupported`. `test/unit/orm-writes-returns.test.ts:90`/`:152` |
| `upsert` `mode:"patch"` | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:393` |
| `create.relate` + `return:"diff"`; `relateMany` per-item `return` | `[ ]` | → `ReturnNotSupported` / `ValidationError`. `test/unit/orm-writes-returns.test.ts:230`/`:243` |
| `skipDuplicates` without explicit id on every item | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:84` |
| `insert` with array `data` | `[ ]` | use `insertMany`. `test/unit/orm-writes.test.ts:154` |
| `upsertMany` without ids and no `conflict` | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:424` |
| `relate`/`unrelate` on a plain (non-relation) table | `[ ]` | → `ValidationError`. `test/unit/orm-writes.test.ts:581` |

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

Runtime `hooks.ts`, `plugins.ts`; built-ins `src/plugins/*` (subpaths `plugins/{rules,zod,timestamps,soft-delete}`).

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
| Type-level extraction — `PluginArgs`/`PluginClientExtras`/`PluginModelExtras` | `[x]` | `test/types/orm-m6.assert.ts` |

### Not implemented / guarded

| Feature | Status | Note |
|---|---|---|
| `soft-delete` filtering on `findUnique` | `[x]` by design | `where` is the unique target — filtering would break `uniqueTarget`; documented in-code |
| `soft-delete` `deletedBy` from `meta.actor` | `[x]` | `test/unit/orm-plugins-soft-delete.test.ts` |
| `restore`/`restoreById` via `UNSET` (not `SET null`) | `[x]` | codec `date().optional()` rejects `null`; documented in-code |

## 8. Types, errors & results

Runtime `errors.ts`, `results.ts`.

| Feature | Status | Surface / test |
|---|---|---|
| `BetterSchemicError` — `code`/`status`/`table`/`field`/`surql`/`vars`/`cause`; `from()` | `[x]` | `test/unit/orm-errors.test.ts` |
| Error-code catalog (26 codes, per-code default HTTP status) | `[x]` | `test/unit/orm-errors.test.ts:36` |
| `normalizeError` — SDK `ServerError` mapping, Zod issue → `ValidationError` | `[x]` | `test/unit/orm-errors.test.ts:146` |
| Predicates — `isUniqueViolation`/`isNotFound`/`isValidationError`/… | `[x]` | `test/unit/orm-errors.test.ts:224` |
| `ThrowingResult`/`attachThrow`/`NotFoundInfo` — miss ⇒ `null`, `.throw()` | `[x]` | `test/unit/orm-results.test.ts:15` |
| `BatchResult<T>` — `count`/`data`/`skipped`/`statements` | `[x]` | `test/unit/orm-results.test.ts:96` |
| `StatementResult<T>` / `statementResult` | `[x]` | `test/unit/orm-results.test.ts:110` |
| `lazyResult<T>` — lazy thenable | `[x]` | `test/unit/orm-reads.test.ts:397` |
| `.explain()` — reads only; writes have none | `[x]` | `test/unit/orm-writes.test.ts:618` |

## 9. Errors-guard vocabulary (teaching errors by code)

Every guard below is intentional (a strongly-typed alternative to a silently-wrong query). The
`BetterSchemicErrorCode` is the error contract; see §1–§7 for the triggering call.

| Code | Raised when |
|---|---|
| `UnsupportedCapability` | removed args (`parallel`), SDK-only ops on a non-SDK conn, auth/`forkSession` without SDK |
| `UnsafeDisabled` | `$unsafe` without `raw: { unsafe: true }` |
| `UnsafeMutation` | `deleteMany` without `where` (requires `all:true`) |
| `UnknownField` | unknown include option / where key |
| `ValidationError` | arg shape errors (`take`/`skip`, mixed relational ops, invalid patch, missing `by`) |
| `UniqueTargetRequired` | `findUnique`/`update`/`delete` `where` not `id`/single-field UNIQUE |
| `ReturnNotSupported` | unsupported `return` for the op (`after`/`diff` on delete, `diff` on expression upsert) |
| `HavingUnsupported` | `aggregate.having` |
| `ClauseNotSupported` | `aggregate`+`split`, `include`+`value`/`split`/`groupBy`, cursor with group/split |
| `ClauseNotSupportedInLive` | disallowed clause in `live` |
| `LiveInTransaction` / `LiveQueryUnsupported` | `live` in a tx / over a websocket-less transport |
| `CursorDirectionConflict` / `CursorTiebreakerRequired` | `after`+`before`; non-unique last order field |
| `ResultNotFound` / `RecordNotFound` | `.throw()` on a miss |
| `RecordAlreadyExists` | duplicate create |
| `SchemaInvalid` / `RepositoryNotFound` / `PluginError` | bootstrap collisions / unknown repository / plugin id or `extend*` collision |

---

## At a glance

| Area | Status |
|---|---|
| Reads (`find*`, projection, where, order/limit/range, groups, paginate, cursor) | `[x]` — `parallel`/fuzzy/having intentionally `[ ]` |
| Writes (`create`/`insert`/`update`/`upsert`/`delete`/`each`/`relate` + modes + returns) | `[x]` — per-op `return` caps documented |
| Relations/graph (links, edges, `_count`, relational where, recursion) | `[x]` — nested projected include `[~]` |
| Live/changefeeds (live, DIFF, FETCH, reconnect, `SHOW CHANGES`) | `[x]` |
| Raw/admin/auth/api/fn/session | `[x]` — `$unsafe` gated |
| Context/multi-connection (`$withContext`, `meta`, `forkSession`, `extends`) | `[x]` |
| Hooks/plugins (families, `definePlugin`, F1 `rules`/`zod`, F2 `timestamps`/`soft-delete`) | `[x]` |
| Types/errors/results (26 codes, predicates, throwing/lazy results, explain) | `[x]` |

> **Not in this document:** DDL/schema authoring → [`COVERAGE.md`](./COVERAGE.md); the raw SurrealQL
> facts the compiler emits (statement shapes, operator semantics, divergences) →
> [`orm-syntax-map.md`](./orm-syntax-map.md). This matrix cites features and their proving tests, not
> golden SurrealQL.
