# SurrealDB ORM syntax map — empirical (server 3.2.0)

Every row below was verified against SurrealDB **3.2.0** during authoring, never inferred. This is the
ground truth the `/orm` compiler emits: where the original design prototype disagreed, the server won.
The executable probe suite was removed with the live/DB-test cleanup — this map is now a reference.

- Related: [`graph-syntax-map.md`](./graph-syntax-map.md) (graph traversal detail, probed on 3.1.4).

> ⚠️ **Design-critical divergences from the prototype** are flagged `DIVERGE`. The plan's M0
> milestones and the `/orm` surface must follow this map, not the prototype docs.

---

## 1. DIVERGE — divergences from the prototype (decision-changing)

| Prototype says                                                                                   | Reality on 3.2.0                                                                                                                                                                                                                       | ORM decision                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE t:id` **creates** the record if it does not exist (hence updates by `WHERE`)                  | `UPDATE t:id {MERGE,SET,CONTENT,REPLACE}` on a non-existent id returns `[]` and **does not create**                                                                                                                                               | `update` compiles a direct target (`UPDATE t:id …`); `upsert` is the only create-or-update. The `UPDATE … WHERE id = …` workaround is unnecessary                                                       |
| `parallel: true` → `PARALLEL`                                                                    | **parse error** (`Unexpected token PARALLEL`)                                                                                                                                                                                          | remove `parallel` from the surface (or error `UnsupportedCapability`)                                                                                                                              |
| `fuzzy: 'x'` → `~`; `anyFuzzy`/`allFuzzy` → `?~`/`*~`                                            | **parse error** for `~`, `?~`, `*~`                                                                                                                                                                                                   | do not emit; fuzzy via `string::similarity::jaro/smithwaterman`, regex via `string::matches`                                                                                                     |
| `DEFINE INDEX … SEARCH ANALYZER a BM25 HIGHLIGHTS`                                               | 3.x uses `FULLTEXT ANALYZER a BM25 HIGHLIGHTS`; `SEARCH ANALYZER` is a parse error                                                                                                                                                           | emit `FULLTEXT`; check `defineIndex` in the DDL                                                                                                                                                |
| `search::highlight('<b>', '</b>', field)`                                                        | arity is `search::highlight(prefix, suffix, indexRef, field)`                                                                                                                                                                         | emit with the `indexRef`                                                                                                                                                                         |
| Range `FROM users:1..users:100`                                                                  | **parse error**; the valid form is `FROM t:1..100` (exclusive end) and `FROM t:1..=100` (inclusive)                                                                                                                                       | `range: { start, end, inclusive? }` → `t:<start>..<end>` / `..=<end>`                                                                                                                           |
| `where: { 'contacts[*].type': 'email' }` compara igualdade                                       | `contacts[*].type` returns **array**; `= 'email'` is `false`                                                                                                                                                                            | equality on array path → `CONTAINS`; scalar membership → `INSIDE`                                                                                                                              |
| `aggregate({ split, groupBy })`                                                                  | **`SPLIT` and `GROUP` are mutually exclusive** in a `SELECT`                                                                                                                                                                           | DIVERGE resolved (M17): `aggregate` does the UNWIND in a subquery and groups outside (§3.1)                                                                                                      |
| `logins = logins + 1` in `ON DUPLICATE KEY UPDATE`                                               | bare fields, `$before`/`$after` are `NONE`; only `$input.*` works                                                                                                                                                                      | increment against the previous state = subquery correlated by id (`(SELECT VALUE f FROM ONLY t:id) + 1`) — and the creation branch evaluates it too, so upsert with expression uses `LET`/`IF` |
| `SET $obj` (bound object) in `UPDATE`/`UPSERT`                                                 | **parse error** (`Unexpected token 'a parameter'`)                                                                                                                                                                                     | emit `SET f = $p` per field                                                                                                                                                                   |
| `FOR $row IN $rows { … }` returns the result of each iteration                                   | returns **`NONE`** (live 3.2.4)                                                                                                                                                                                                        | `updateEach`/`skipDuplicates` compile 1 statement per item (same round-trip)                                                                                                                  |
| `INSERT` with a string `id` `"user:x"` points to `user:x`                                       | the id becomes the **string value** (`user:⟨user:x⟩`)                                                                                                                                                                                         | the ORM converts string `id` → `RecordId` before binding                                                                                                                                         |
| `ON DUPLICATE KEY UPDATE` accepts a partial payload                                                 | validates the INSERT row: a partial payload in SCHEMAFULL **fails** before the conflict                                                                                                                                                    | document that `onDuplicate` receives insertable rows                                                                                                                                           |
| `KILL "uuid"` (string)                                                                           | parse error; accepts `KILL $param` / `KILL u"…"`                                                                                                                                                                                        | `kill()` binds the uuid as a parameter                                                                                                                                                             |
| `.explain()` on writes                                                                           | `EXPLAIN` only exists for `SELECT` ("only supported with the new execution model")                                                                                                                                                      | `.explain()` on reads only                                                                                                                                                                        |
| `VERSION d'…'` always available                                                                 | requires a versioned backend; memory server: "does not support versioned queries"                                                                                                                                                          | emit; structured error when the backend does not support it                                                                                                                                           |
| `FETCH` placed freely                                                                   | FETCH is the **last** clause (after WHERE/ORDER/LIMIT)                                                                                                                                                                            | lower in the correct order                                                                                                                                                                       |
| `[NONE]` and `NULL` identical                                                                      | remain distinct (`isNone` ≠ `isNull`)                                                                                                                                                                                              | keep both                                                                                                                                                                                    |
| `include: { likes: true }` → `->likes->post AS likes` returns records                          | raw traversal returns **record ids**; records require a subquery `(SELECT * FROM ->likes->post)`                                                                                                                                        | graph `include` always via subquery                                                                                                                                                          |
| `include: { likes: { where: { score: 4 } } }` → `(SELECT … FROM ->likes->post WHERE score = $p)` | the subquery row is the **target** (`score` doesn't exist there); the edge filter goes in `->(likes WHERE score = $p)` and the target's in `->post->(post WHERE …)`                                                                                   | split edge/target by the column's owner                                                                                                                                                           |
| `edge` + `target` → `(SELECT …, out.* FROM ->likes->post …)`                                     | `out.*` only exists while the row is the EDGE: after `->target` the row is the target and `out` is `NONE` → **`[{}]`** (silently, with or without `WHERE`/`ORDER BY`)                                                                         | `edge`+`target` stops at the edge (`FROM ->likes`), projects `out.*` and filters the target by `WHERE out.<field>`                                                                                          |
| `<-edge->target` reaches the other endpoint                                                        | the target follows the **same direction** (`<-edge<-target`); `<-edge->target` returns `[]`                                                                                                                                                     | lowering of the `in` direction uses `<-edge<-target`                                                                                                                                                   |
| `every` → `count(traversal[WHERE NOT …]) = 0`                                                    | `NOT` without parentheses in a traversal filter is **parse error**; `count(t) = count(t[WHERE …])` is NONE-safe and equivalent                                                                                                                | `every` by count equality                                                                                                                                                              |
| `_count` of array link uses `count(field)`                                                        | `array::len(field)` **errors on `NONE`**; `count(field)` returns `0`                                                                                                                                                                     | use `count(field)`                                                                                                                                                                             |
| `FETCH` materializes the link even outside the `select`                                                | `SELECT id FROM post FETCH author` **does not return** `author`; the link must be in the selection                                                                                                                                           | the compiler adds the link to the projection when `include` is FETCH                                                                                                                                  |
| `orderBy` in include sorts any field                                                       | inside the subquery the server requires the **order idiom** in the selection (projection `*` covers it)                                                                                                                                                  | validate `orderBy` ⊆ target projection (or `select: '*'`)                                                                                                                                         |
| `SINCE` accepts param                                                                             | parse error ("expected a version stamp or a date-time")                                                                                                                                                                                | inline the literal (`0`, number/bigint or `d'…'`)                                                                                                                                                |
| `BEGIN/COMMIT` in separate `query()` calls holds the transaction                                | each `query()` RPC is its own transaction: the `CREATE` persists and the following `COMMIT` gives "Cannot COMMIT without starting a transaction"                                                                                                  | only `mode: 'sdk'` (SDK's `beginTransaction()`); `mode: 'sql'` fails fast (`UnsupportedCapability`)                                                                                            |
| nested `beginTransaction` is an error                                                               | the SDK/server **allows** it (without savepoint)                                                                                                                                                                                             | the client folds the nested call into the SAME tx; re-entry from the root client → `TransactionAlreadyActive`                                                                                            |
| Write conflict has a dedicated error                                                                 | `kind: "Internal"`, message `Transaction conflict: Write conflict, retry the transaction. This transaction can be retried`                                                                                                            | message heuristic already normalizes to `WriteConflict`; retry re-executes the callback                                                                                                           |
| `afterCommit` outside a tx                                                                         | no transactional scope                                                                                                                                                                                                                | `ValidationError` fail-fast (recorded debt)                                                                                                                                                 |
| `$withContext` with NS/DB "without global state" via `USE`                                           | `USE NS … DB …;` in the SAME script scopes the following statements and **does not change the session** (the connection stays in the previous NS/DB)                                                                                                         | prefix `USE NS … DB …;` on every clone operation (1 round-trip, zero global state); `auth` doesn't fit in the prefix → async overload that forks the session                                     |
| `client.fn.call` via `db.run`                                                                    | `run`/`api`/`export`/`import`/`auth` use the **session's** NS/DB — a prefix clone would target the wrong DB                                                                                                                             | `fn.call` compiles `RETURN fn::x($p…)` (context-aware); `api`/`auth`/`export` fail fast (`UnsupportedCapability`) on a prefix clone                                                |
| `client.import(dump)` via SDK                                                                    | the SDK's `import()` **breaks over WebSocket** (`JSON Parse error: Unexpected identifier "undefined"`)                                                                                                                                 | `import` replays the dump via `query()` (works on WS and respects context)                                                                                                                  |
| `client.ping()` via `health()`                                                                   | `health()` resolves over WebSocket on SDK 2.2.0 / server 3.2.0; `ping()` keeps `RETURN true` (uniform on WS/HTTP)                                                                                                                    | `ping()` does a `RETURN true` round-trip (uniform on WS/HTTP)                                                                                                                                  |
| `client.api.*` throws on an HTTP error                                                                | the SDK resolves the `{ status, body, headers, request_id }` envelope **without rejecting** on 4xx/5xx                                                                                                                                           | the ORM inspects `status >= 400` and throws `DatabaseError` with `status` + `details.body`                                                                                                          |

---

## 2. Statement shapes (writes)

### 2.1 `CREATE`

| Form                                                        | Result                                                               | Notes                                                                                                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE t CONTENT $p`                                       | `[ {…generated id…} ]`                                                  | random id                                                                                                                                                                                                     |
| `CREATE ONLY t CONTENT $p`                                  | **object** (not array)                                               | used by `create({ only: true })`                                                                                                                                                                               |
| `CREATE t:id CONTENT $p`                                    | `[ {…} ]`                                                            | explicit id                                                                                                                                                                                                     |
| `CREATE [ONLY] type::record(s"t", rand::ulid()) CONTENT $p` | id **ULID** (26 chars, time-sortable)                          | target generated on the server — the ORM's lowering when there's no explicit id. `type::record(t, …)` with a simple ident also works; an **escaped** ident (`⟨x-y⟩`) doubles the escape → use `toSurqlString` (`s"…"`) |
| `CREATE t CONTENT { …, id: rand::ulid() }`                  | id ULID                                                              | alternative form (expression `id` field inside CONTENT)                                                                                                                                                    |
| `CREATE t:id` duplicado                                     | **error** `Database record \`t:id\` already exists` (`AlreadyExists`) | normalize → `RecordAlreadyExists`                                                                                                                                                                               |
| `LET $c = (CREATE ONLY t CONTENT $p); RETURN $c;`           | created object                                                        | `create + relate` sugar (`to: '$self'`)                                                                                                                                                                         |
| `CREATE t CONTENT $p RETURN NONE`                           | `[]`                                                                 | minimal payload                                                                                                                                                                                                   |

### 2.2 `INSERT`

| Form                                                                           | Result                                                                               | Notes                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT INTO t $rows` (array)                                                  | array of rows (payload ids preserved)                                         | 1 statement                                                                                                                                                                  |
| `INSERT INTO t $rows` duplicate id                                             | **error** `already exists`                                                            |                                                                                                                                                                              |
| `INSERT IGNORE INTO t $rows`                                                   | returns **only the inserted rows**                                                   | `count` = inserted                                                                                                                                                          |
| `INSERT … ON DUPLICATE KEY UPDATE f = $input.f`                                | affected rows                                                                      | `$input` = the INSERT record (nested paths ok)                                                                                                                           |
| `INSERT … ON DUPLICATE KEY UPDATE f = (SELECT VALUE f FROM ONLY t:id) + 1`     | increment against the previous state                                                  | only fields accessible before: the subquery — and it's evaluated **in the creation branch too** (live 3.2.4: `NONE + int` = error), so upserts with expression use `LET`/`IF` |
| `INSERT … ON DUPLICATE … RETURN AFTER/NONE`                                    | ok                                                                                   | see `RETURN` below                                                                                                                                                          |
| `INSERT … ON DUPLICATE … RETURN BEFORE`                                        | returns the **previous** state (live 3.2.4)                                           | exposed by the ORM                                                                                                                                                             |
| `INSERT … ON DUPLICATE … RETURN DIFF`                                          | `[[ { op: "change", path, value: "@@ … @@" } ]]`                                     | **paged diff** format (nested), ≠ UPDATE's                                                                                                                               |
| `INSERT INTO t $p` with an `id` string (`"user:x"`)                                | the id becomes a **string** (`user:⟨user:x⟩`), not a record id                             | the ORM converts to `RecordId` before binding                                                                                                                               |
| `INSERT … ON DUPLICATE` with a partial payload + SCHEMAFULL table                | **error** coercing the missing field                                                  | the INSERT must be an insertable row (`ON DUPLICATE` does not relax validation)                                                                                           |
| `INSERT … ON DUPLICATE KEY UPDATE` with another tenant's payload (guessed id) | **updates the other tenant's row** (the `READONLY` `tenant_id` stays the original) | there's no `WHERE`: that's why `tenantRls` rejects `onDuplicate` ≠ `"ignore"` on a tagged table                                                                                   |
| `INSERT INTO t { …, id: rand::ulid() }` (or array with one expression per row) | each row gets its id, evaluated per element                                       | the ORM injects the EXPRESSION field when there's no explicit id; payload spread (`{ ...$d, id: … }`) is **parse error**                                                       |
| `INSERT RELATION INTO edge {…}`                                                | edge rows                                                                     | native path for `relateMany`/seeding                                                                                                                                        |

### 2.3 `UPSERT`

| Form                                                                                                        | Result                                                                                                                                                                        | Notes                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `UPSERT t:id MERGE $p`                                                                                      | `[ {…} ]`; creates if missing                                                                                                                                                     | `upsert` by id                                                                                                       |
| `UPSERT t MERGE $p WHERE cond`                                                                              | affected rows; **creates when nothing matches** — and only when the payload ITSELF satisfies the `WHERE`                                                                                 | `upsert` by single field (validate uniqueness in the schema)                                                                |
| `UPSERT ONLY t:id MERGE $p WHERE tenant = $t` (another tenant's record)                                    | `NONE` (object) — **does not update**                                                                                                                                            | the `WHERE` filters the UPDATE branch; it's the `scope` channel of the `tenantRls` plugin                                          |
| `UPSERT ONLY t:missing MERGE $p WHERE tenant = $t` (payload WITH the tenant)                                   | **creates** with the payload's tenant                                                                                                                                              | the CREATE branch **does not evaluate the `WHERE`** — that's why the runtime ALWAYS injects the tenant into the payload                    |
| `UPSERT t MERGE $p WHERE uniq = $v AND tenant = $t`                                                         | hit from another tenant → `[]`; miss creates with the payload's tenant                                                                                                                 | `upsertMany` conflict-form                                                                                            |
| `UPSERT ((SELECT VALUE id FROM t WHERE uniq = $v LIMIT 1)[0] ?? type::record(s"t", rand::ulid())) MERGE $p` | hit updates the existing; miss creates with a generated id                                                                                                                             | ORM lowering with `idStrategy` ≠ `rand`: 1 statement, `RETURN DIFF` preserved; `UPSERT ONLY <expr>` returns an object |
| `UPSERT t:id MERGE { …, id: rand::ulid() }` on an EXISTING record                                          | **error** `Found '…' for the id field, but a specific record has been specified`                                                                                               | id cannot be injected in MERGE — that's why the generated upsert uses the target-expression, never the payload                 |
| `UPSERT t:id SET $p` (whole object)                                                                       | **parse error** (`Unexpected token 'a parameter'`) — use `SET f = $p` per field                                                                                              | the ORM emits per-field                                                                                                 |
| `UPSERT ONLY t:id MERGE/SET`                                                                                | ok (object? → array, verified: array)                                                                                                                                       |                                                                                                                       |
| `UPSERT t:id CONTENT $p`                                                                                    | replaces content                                                                                                                                                          |                                                                                                                       |
| `UPDATE ONLY t:id MERGE $p` (miss)                                                                          | `undefined` (NONE) — **does not create**                                                                                                                                             | default STRICT lowering of `upsert` by id (`onMissing:"throw"`)                                                      |
| `UPDATE ONLY t:id MERGE $p` (hit)                                                                           | **object** (not array) — `RETURN NONE` is omitted in strict mode so the miss is observable                                                                                        | strict `upsert`; decode discards the object when `return:"none"`                                                   |
| `UPDATE t MERGE $p WHERE uniq = $v` (miss)                                                                  | `[]` — **does not create**                                                                                                                                                           | default STRICT lowering of `upsert` by single field                                                                   |
| `UPDATE t MERGE $p WHERE uniq = $v` (hit)                                                                   | array of rows                                                                                                                                                               | strict `upsert` by single field                                                                                      |
| `UPDATE ONLY t:id … WHERE tenant = $t` (another tenant's record)                                           | `undefined` (NONE) → the runtime rejects `ResultNotFound`                                                                                                                       | `tenantRls` scoping in strict upsert                                                                               |
| `UPDATE ONLY t:id MERGE { id: t:id, … }` (existing target)                                                   | ok — id **equal** to the target is accepted; the `Found … specific record has been specified` error is only for a **divergent** (or generated) id                                               | target inferred from `data.id`: `UPDATE ONLY t:id MERGE $p` with the `id` in the payload (probe `strict_same`)                   |
| `CREATE t CONTENT $p` / `CREATE type::record(s"t", fn()) CONTENT $p` (without `where` or `data.id`)            | lowering of `upsert`/`upsertDelta` **without a target** — plain create (id by `idStrategy`); explicit `onMissing:"throw"`, distinct branches or target-less `mode` → `ValidationError` | §2.2; `return:"after"` with no row (permission/scope) → `ResultNotFound`                                               |

#### 2.3.1 `RETURN VALUE { before: $before, after: $after }` — the `upsertDelta` envelope (probe 3.2.0)

| Form                                                                         | Result                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPSERT ONLY t:id … RETURN VALUE { before: $before, after: $after }` (create) | object `{ after }` — the `before` key **exists** with `undefined` (over WS; `null` over HTTP JSON)                                                                                                                                                             |
| the same form (update)                                                        | `{ before, after }` — both sides come from the SAME statement (atomic snapshot)                                                                                                                                                                                   |
| non-`ONLY` forms (by table, generated subquery)                               | **array** `[envelope]`; decode flattens (`payloadRows`)                                                                                                                                                                                                         |
| `LET`+`IF/ELSE` with the envelope in EACH branch                                 | the `IF` statement returns `[envelope]`; `$before` is `undefined` in the CREATE branch; expressions (`SET f = f + 10`) produce server-computed values on both sides                                                                                      |
| `… RETURN VALUE { … } TIMEOUT 5s`                                             | ok — `RETURN` **before** `TIMEOUT`; `TIMEOUT … RETURN` is a parse error; same for `END TIMEOUT`; per-branch `TIMEOUT` INSIDE the IF works                                                                                                                          |
| `UPDATE ONLY t:missing … RETURN VALUE { … }`                                  | `undefined` (NONE) — the strict-mode miss                                                                                                                                                                                                                     |
| `UPDATE t … WHERE … RETURN VALUE { … }` with no match                             | `[]` — the strict-mode miss by single field                                                                                                                                                                                                                   |
| `CREATE t CONTENT … RETURN VALUE { … }`                                       | `[{ after }]` (or object with `ONLY`) — creation branch without `before`                                                                                                                                                                                           |
| `INSERT … ON DUPLICATE … RETURN VALUE { … }`                                  | the envelope **exposes** `$before`/`$after` in `RETURN` (3.2.0) — **observed, not used**: the NONE `$before`/`$after` note applies to the ASSIGNMENT context; `upsertDelta` uses `LET`/`IF` for distinct branches (cross-version robustness + `scope` support) |
| `LET $__b = (SELECT …); UPDATE …; RETURN { before: $__b, after: … }`          | `{}` — capture-and-return with a final `RETURN` does NOT return a value; **rejected** (hence the per-branch envelope)                                                                                                                                                |

### 2.4 `UPDATE`

| Form                                                                     | Result                                                        | Notes                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `UPDATE t:id MERGE $p` (inexistente)                                     | `[]` — **does not create**                                           | DIVERGE (2.x created)                                                               |
| `UPDATE t MERGE $p WHERE cond` (no match)                               | `[]`                                                          | safe for `updateMany`                                                           |
| `UPDATE ONLY t:id … WHERE tenant = $t` (another tenant)                    | `NONE` (not `[]`) — does not update                              | singular target with `WHERE`: `tenantRls`'s `scope` channel                            |
| `UPDATE t:id SET tenant_id = <same value>`                              | ok                                                            | `READONLY` only rejects a value CHANGE                                             |
| `UPDATE t:id SET tenant_id = <other>`                                    | error `Found changed value for field …, but field is readonly` | DDL backstop                                                                    |
| `UPDATE t CONTENT { … without the READONLY field }`                            | preserves the `READONLY` value                                   |                                                                                    |
| `UPDATE t REPLACE { … without the READONLY field }`                            | **error** (`Found changed value … readonly`)                   | `REPLACE` requires the field to be present                                                   |
| `UPDATE ONLY t:id REPLACE { …, tenant: <same> } WHERE tenant = <same>` | updated object                                             | the runtime injects the tenant into the `replace` payload (the equal value passes `READONLY`) |
| `UPDATE ONLY t:id SET …`                                                 | **objeto**                                                    | `only: true`                                                                       |
| `SET`                                                                    | per-field assignment                                          |                                                                                    |
| `MERGE`                                                                  | deep merge                                                | default                                                                            |
| `CONTENT`                                                                | replaces the record; **DEFAULTs are not reapplied**              | payload must be complete                                                       |
| `REPLACE`                                                                | replaces                                                     |                                                                                    |
| `PATCH $ops`                                                             | JSON Patch; returns the record                                | `{ op, path, value }`                                                              |
| `UNSET a, b`                                                             | error on a required field; ok on `option<…>`                  |                                                                                    |
| `… TIMEOUT 5s`                                                           | accepted                                                        |                                                                                    |

`RETURN` (UPDATE):

| `RETURN` | Result                                                      |
| -------- | ----------------------------------------------------------- |
| `NONE`   | `[]`                                                        |
| `BEFORE` | previous state (array)                                     |
| `AFTER`  | resulting state (array)                                   |
| `DIFF`   | `[[ { op: "replace", path: "/age", value } ]]` (JSON Patch) |

#### 2.4.1 `RETURN <projection>` in mutations (probe 3.2.0)

| Form                                                                                                 | Result                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE … SET … RETURN name, age`                                                                     | `[{ name, age }]` — list projection; nested paths (`address.city`) nest as in `SELECT`                          |
| `UPDATE ONLY … RETURN name`                                                                           | object (not array)                                                                                                         |
| `RETURN <expr> AS alias`                                                                              | evaluated by the server (`string::uppercase(name) AS upper`)                                                                |
| `RETURN *` / `RETURN *, name`                                                                         | full row (+ extra entries)                                                                                         |
| `RETURN <proj> TIMEOUT 5s`                                                                            | ok — `RETURN` **before** `TIMEOUT`                                                                                       |
| `RETURN * OMIT age`                                                                                   | **parse error** — `OMIT` doesn't exist in mutations; the ORM applies `omit` client-side                                          |
| `CREATE`/`INSERT`/`UPSERT`/`RELATE` and the `THEN`/`ELSE` branches of `LET`+`IF` accept `RETURN <proj>` | one object per row (or array in table form)                                                                          |
| `DELETE … RETURN name`                                                                                | the projection evaluates **after** removal → `NONE` fields; the ORM uses `RETURN BEFORE` + client-side projection                     |
| `RETURN $before.name AS nome`                                                                         | evaluates the previous state in RETURN (`RETURN VALUE $before` returns the whole row; `$before.name` without alias prints `{}`) |

#### 2.4.2 Compound assignment `SET f ±= $p` (probe 3.2.0)

| Form                                        | Result                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE ONLY t:id SET n -= $d RETURN BEFORE` | a read-modify-write; `RETURN BEFORE` returns the previous state                                                                                                |
| `SET meta.a += $d`                           | a nested path adjusts deeply; missing objects (`prefs.theme`) are created                                                                             |
| `SET f += $x` on a missing field               | `NONE + n` = `n` in UPDATE (`ON DUPLICATE` errors in the create branch — §2.2)                                                                                  |
| `SET s += '!'` / `SET arr += ['y']`          | `+=` is general compound assignment (string concat, array append); the ORM TYPE restricts `increment`/`decrement` to numeric fields and the runtime validates the column |
| `SET arr += ['a']` with `arr = ['a']`         | **`['a','a']`** — `+=` does APPEND, **no dedup** (probe 3.3.4): hence `{ append }` ≠ `{ union }`                                                            |
| `SET arr -= 'a'` with `arr = ['a','b','a']`   | `['b']` — `-=` removes **ALL** occurrences (probe 3.3.4)                                                                                                   |
| `SET arr = array::union(arr, ['b'])`         | the **only** form that deduplicates: `['a','b']` (probe 3.3.4)                                                                                                     |
| `SET arr[0] = $v`                            | assigns an index (an out-of-range index is a server error)                                                                                                    |
| `SET f += $p` with `p` a string and `f` decimal   | **error**: `Cannot perform addition with 'decimal' and 'string'` — the numeric operand is number/bigint/`Decimal`, never string                                  |
| `SET f = IF true THEN f + 1 ELSE f END`      | applies the effect — a server-side read-modify-write (probe 3.x)                                                                                     |
| `SET f = IF false THEN f + 1 ELSE f END`     | keeps `f` — the default `ELSE` is the field itself (probe 3.x)                                                                                                   |
| `SET f = IF <g> THEN f + $p ELSE THROW s"…" END` | **aborts the statement** — no row is written (the entire `updateMany`) (probe 3.x)                                                                   |
| `SET arr = array::union(arr ?? [], $p)` with `arr = NONE` | `$p` — `coalesce` seeds the missing array (probe 3.x)                                                                                             |
| `SET arr = (arr ?? $c) + $p`                 | seed for `{ append }`: concatenates onto the default array when the field is `NONE` (probe 3.x)                                                                     |
| `SET arr = IF <g> THEN array::union(arr ?? [], $p) ELSE arr END` | guard + seed combined, still ONE server-side write (probe 3.x)                                                                        |

**`when`/`else`/`coalesce` modifiers (M17.12).** They refine a marker without becoming an operator
(the six lines of `AdjustmentLowering` remain the operators): `when` is a guard evaluated on the
server (`IF <g> THEN … ELSE … END`), `else` is the `ELSE` branch (`"keep"` → `ELSE f`, `"throw"` →
`ELSE THROW s"adjustment guard failed on <campo>"`, which aborts the statement, or a value/fragment →
`ELSE <value>`), and `coalesce` seeds a `NONE` array (`f ?? $c`) — only in `union`/`append`. `when` is
rejected on `{ at }` (the `f[n]` target has no field expression for the `IF`) and `else` without
`when` is `ValidationError`. Each field remains ONE server-side write, so the array's UNIQUE index
stays correct.

**Array markers (M17).** `{ append }` / `{ remove }` / `{ union }` / `{ at: { index, value } }`
are the typed surface of the four forms above; the target is validated against the schema
(`array`/`set` family, never `id`) and each marker is ONE server-side write — which keeps the whole
array's UNIQUE index correct, since the server is what swaps the key.

#### 2.4.3 `math::*` only aggregates NUMBERS (probe 3.3.4) — operand validation

| Form                                                     | Result                                            |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `SELECT math::sum(campo_inexistente) … GROUP ALL`         | `0` — **no error**                                   |
| `SELECT math::sum(campo_string) … GROUP ALL`              | `0` — **no error**                                   |
| `SELECT math::sum(link.name)` / `math::sum(arr.quantity)` | `0` — **no error** (each row of the group has 1 field) |
| `SELECT math::median(campo_string)`                       | `{}` — empty object, **no error**                    |
| `SELECT math::min/max(campo_string \| datetime \| bool)`  | `null` — **no error**                                |
| `SELECT array::min(array::group(campo))`                  | the correct extremum of a non-number (probe 3.3.4)    |

`aggregate` validates the operand against the schema and rejects each of these cases, pointing at
the working alternative (`array::min(array::group(…))` for a non-number extremum, `split` to walk a
link/array): a report showing `R$ 0,00` with no warning is worse than a compile error. What the
schema does NOT know (schemaless input, non-SCHEMAFULL table, flexible object, element operand in
`split`) stays permissive — the server has the final word.

### 2.5 `DELETE`

| Form                                           | Result                            |
| ---------------------------------------------- | --------------------------------- |
| `DELETE t:id RETURN BEFORE`                    | `[ record ]`                    |
| `DELETE t:id` inexistente                      | `[]`                              |
| `DELETE t:id WHERE tenant = $t` (another tenant) | `[]` — does not delete (`scope` channel) |
| `DELETE t:id RETURN NONE`                      | `[]`                              |
| `DELETE FROM t WHERE cond RETURN BEFORE`       | deleted                         |
| `DELETE t` (table)                            | deletes everything                       |

**Event guard of the `tenant()` preset:** the preset's `DEFINE EVENT … THEN IF $auth != NONE AND $after.<col> != $auth.id { THROW s"…"; }` is accepted; `INFO … STRUCTURE` returns `WHEN` in single quotes and `THEN` with the `'…'` literal (the inline `s"…"` converges during `canonicalizeLiterals` canonicalization), so authored ≡ introspected (clean `diff --live`).

**Event guard of the `createOnly({ hard: true })` preset:** the `DEFINE EVENT {table}_create_only … WHEN $event = 'UPDATE' THEN { THROW s"…" }` is accepted and **runs even for privileged/root sessions** (`$auth = NONE`, no permission checks), so it blocks `$withoutPlugins()`, `$raw`/`$sdk` and migrations — `PERMISSIONS FOR update NONE` alone only stops record users. `INFO … STRUCTURE` returns single-line `THEN` with the `'…'` literal; the authored ≡ introspected round-trip is proven in `struct-parity` (corpus `sp_create_only`).

### 2.6 `RELATE` / edges

| Form                                                        | Result                       |
| ----------------------------------------------------------- | ---------------------------- |
| `RELATE a->edge->b SET …`                                   | edge row              |
| `RELATE a->edge:named->b`                                   | named edge id         |
| `LET $c = (CREATE ONLY t CONTENT $p); RELATE a->edge->$c …` | create+relate in one round-trip |
| `DELETE edge WHERE in = $a AND out = $b`                    | `unrelate`                   |
| `DELETE edge WHERE <filtro>`                                | `unrelateMany`               |
| `INSERT RELATION INTO edge { in, out, … }`                  | edge via payload           |

### 2.7 Batches and transactions

| Form                                                                                                                      | Result                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `FOR $row IN $rows { UPDATE t MERGE $row.fields WHERE by = $row.by; }`                                                    | **returns `NONE`** (nothing per iteration) — the ORM does NOT use `FOR` for `updateEach`                                 |
| `UPDATE t MERGE $f0 WHERE id = $b0; UPDATE t MERGE $f1 WHERE id = $b1;`                                                   | 1 result per statement, in order (`updateEach` per-item: hit → `[row]`, miss → `[]`)                       |
| `INSERT IGNORE INTO t $p0; INSERT IGNORE INTO t $p1;`                                                                     | `skipDuplicates` per-item (only inserted rows come back)                                                      |
| `LET $e = (SELECT VALUE id FROM t WHERE uniq = $v LIMIT 1); IF array::len($e) = 0 THEN CREATE … ELSE UPDATE $e[0] … END;` | upsert-by-single-field without id (and id fallback when the `update` has expressions)                             |
| `LET $c = (CREATE ONLY t CONTENT $p); RELATE a->edge->$c SET …; RETURN $c;`                                               | create + relate; `RETURN $c` returns the **object** (not array)                                                  |
| `BEGIN TRANSACTION; …; COMMIT TRANSACTION;`                                                                               | applies                                                                                                         |
| `BEGIN TRANSACTION; …; CANCEL TRANSACTION;`                                                                               | discards; the SDK **throws** when collecting responses (`Cancelled`) — the executor treats the cancel as an expected error |

**Atomicity (verified with the SDK via `responses()`, 3.2.0):**

| Scenario                                                  | Result                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch `stmts` **without** a transaction, middle statement fails | the others **persist** (`CREATE first`, `CREATE dup` fails, `CREATE third` persists) — each statement is independent                                                                                                                                                                  |
| Batch inside `BEGIN/COMMIT`, statement fails          | **nothing persists**: the failed statement returns the real error; EARLIER statements are retroactively marked as `Query` + `NotExecuted` ("not executed due to a failed transaction"); `COMMIT` returns "Cannot COMMIT: the transaction was aborted due to a prior error" |
| All responses (including `BEGIN`/`COMMIT`)          | 1 response per statement, in order — the offset of user statements is stable                                                                                                                                                                                                      |

Implications: `transactional: true` (batch default) wraps in `BEGIN/COMMIT` and is atomic in 1
round-trip; the executor reports the **root** failure (skipping `NotExecuted`/`Cancelled`, which
normalize to `TransactionRollback`). `UPDATE`/`CREATE` without a transaction are NOT atomic with
each other.

---

## 3. SELECT — projections, clauses, `ONLY`, ranges

| Form                                                         | Result                                                                                                     | Notes                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SELECT id, f, path.sub AS alias`                            | projection                                                                                                   | unknown paths → `null` (validate client-side with `strict`)                                         |
| `SELECT * OMIT f`                                            | removes fields                                                                                              | works even with `f` selected                                                                    |
| `SELECT * FROM ONLY t:id`                                    | **objeto**                                                                                                 | missing → `null`/`undefined` (falsy)                                                              |
| `SELECT * FROM ONLY t:id WHERE cond`                         | object on hit; **`NONE`** (falsy) when `WHERE` filters                                                  | `ONLY` target + filter: the `scope` channel of `tenantRls` in `findUnique` by id                           |
| `SELECT … FROM t WHERE uniq = $v AND scope LIMIT 1`          | array 0/1                                                                                                  | `findUnique` by single field with ANDed scope                                                        |
| `SELECT * FROM ONLY t` (2+ rows)                             | **error** (`Expected a single result output`)                                                               | `LIMIT 1` resolves it (`FROM ONLY t LIMIT 1` → object)                                                    |
| `SELECT VALUE f`                                             | array of values                                                                                           | `value: true`                                                                                         |
| `SELECT VALUE id … LIMIT 1`                                  | `exists` probe                                                                                          |                                                                                                       |
| `SELECT count() … GROUP ALL`                                 | `[ { count: n } ]`                                                                                         | `count`                                                                                               |
| `SELECT count() FROM t` (without GROUP)                          | **one row per record**                                                                                 | always emit `GROUP ALL`                                                                             |
| `SELECT … GROUP BY f`                                        | rows per group                                                                                           |                                                                                                       |
| `SELECT * … GROUP BY f` / `GROUP ALL`                        | **error** (`cannot be aggregated`)                                                                          | require explicit projection                                                                             |
| `SELECT count() FROM (SELECT f … GROUP BY f) GROUP ALL`      | counts **groups**                                                                                           | pagination with `groupBy`                                                                               |
| `SELECT math::sum/avg/min/max(…)`                            | aggregators                                                                                                | `math::median`/`stddev`/`variance` also; **`math::avg` does not exist in 3.x → `math::mean`** (DIVERGE) |
| `SELECT array::group(f), array::distinct(f)`                 | arrays                                                                                                     | `aggregate`'s `collect`/`distinct`                                                                   |
| `SELECT … SPLIT f`                                           | unfolds arrays (1 row per element)                                                                     | `count()` per split row = 1 → aggregating requires another form                                             |
| `SELECT … SPLIT f GROUP BY f` / `GROUP ALL`                  | **error** (`mutually exclusive` / `Missing split idiom`)                                                    | DIVERGE — see §3.1: the ORM does the UNWIND in a subquery and groups outside                                |
| `SELECT name FROM t SPLIT f` (f outside the selection)             | **error** `Missing split idiom "f" in statement selection` (3.3.4)                                          | the compiler injects `f AS _split_f` and the decoder discards the column (see §3.1)                          |
| `SELECT name, f AS _split_f FROM t SPLIT f`                  | **ok** — the _alias_ satisfies the idiom as well as the raw path                                               | this is the basis of the automatic idiom                                                                         |
| `SELECT *, f AS _split_f FROM t SPLIT f`                     | ok (with `*`)                                                                                               | idem                                                                                                  |
| `SPLIT a.b` (nested path) with `SELECT x, a.b AS _split_ab` | ok — the idiom accepts a nested path **under an alias**                                                           | the automatic idiom covers nested paths                                                               |
| `SELECT … SPLIT f WHERE <elem>`                              | the `WHERE` filters the **PARENT** (`WHERE f[*].q > 2` doesn't remove the element; the expression is evaluated per element) | per-element filtering remains a `surql` recipe with `array::flatten`                               |

#### 3.1 UNWIND + GROUP: `aggregate({ split })` (M17, probe 3.3.4)

`SPLIT` is evaluated **before** `GROUP` within a `SELECT`, so `SELECT … SPLIT f GROUP ALL`
is an error. The lowering pushes the split into a subquery and groups outside:

```surql
SELECT name, math::sum(_split_lines_quantity) AS total
FROM (SELECT lines AS _split_lines, name AS name, lines[*].quantity AS _split_lines_quantity
      FROM cart SPLIT lines)
GROUP BY name
```

| Verified fact                                                                      | Lowering consequence                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| the inner subquery needs the **split field as an idiom** (an alias works)           | `_split_lines` is always projected                                               |
| inner `SELECT *` does **not** expose the element's fields (`math::sum(quantity)` → `0`) | the inner projection is always explicit, derived from the caller's `select`           |
| `products[*].quantity` and `products.quantity` give the same element field           | either spelling is accepted in `select`                                    |
| `array::group`, `count()`, `math::*`, `ORDER BY`, `LIMIT` work over the subquery | the outer aggregator is the normal `aggregate`                                        |
| the inner `WHERE` filters the parent                                                       | `where` of `aggregate({ split })` is PARENT scope (per-element filter = `surql`) |
| `SELECT id, (expr) AS alias … ORDER BY alias DESC`                                   | sorts by alias/expression                                                        |                                                                        |
| `SELECT … ORDER BY (expr)`                                                           | **parse error**                                                                   | identifier/alias only; use `AS alias`                                 |
| `SELECT … ORDER BY a DESC, b ASC`                                                    | ok                                                                                |                                                                        |
| `SELECT … LIMIT n START m` / `LIMIT $l START $s`                                     | ok (binds accepted)                                                                | `limit`/`start`                                                        |
| `SELECT … WITH INDEX a, b`                                                           | ok (list)                                                                        | `WITH INDEX` **before** WHERE                                        |
| `SELECT … TIMEOUT 5s`                                                                | ok                                                                                | `TIMEOUT` **after** `LIMIT/START`; `TIMEOUT … LIMIT` = parse error |
| `SELECT … WITH INDEX idx` / `WITH NOINDEX`                                           | ok                                                                                | `WITH` before `WHERE`; after = parse error                          |
| `SELECT … PARALLEL`                                                                  | **parse error**                                                                   | DIVERGE                                                                |
| `SELECT … FROM t:2..4`                                                               | `[t:2, t:3]` (exclusive end)                                                      | suffix, not `t:2..t:4`                                                 |
| `SELECT … FROM t:2..=4`                                                              | `[t:2, t:3, t:4]`                                                                 | inclusive                                                              |
| `SELECT … FROM t:abc..=xyz`                                                          | ok with string ids; `⟨a-b⟩` when needed                                         |                                                                        |
| `SELECT … FROM t:2..t:4`                                                             | **parse error**                                                                   | DIVERGE                                                                |
| `SELECT * FROM ONLY t:id FETCH link`                                                 | FETCH after ONLY                                                              |                                                                        |
| `EXPLAIN SELECT …`                                                                   | plan as string                                                                   | `SELECT` only; `EXPLAIN UPDATE` is an error                                   |
| `SELECT … VERSION d'…'`                                                              | error on memory backend ("does not support versioned queries")                     | emit conditionally on support                                        |
| `SELECT … VERSION d'…' TIMEOUT 5s`                                                   | ok (order)                                                                        | `VERSION` **before** `TIMEOUT`                                       |

**Clause order (3.2.4, verified):**

```surql
SELECT [VALUE] <projection> FROM <target>
  [WITH INDEX … | WITH NOINDEX]
  [WHERE …]
  [SPLIT …]
  [GROUP BY … | GROUP ALL]
  [ORDER BY …]
  [LIMIT …]
  [START …]
  [VERSION d'…']
  [TIMEOUT …]
  [FETCH …]            -- M3
```

`SELECT * OMIT f` works even with a required `f` and with `f` projected
(`SELECT name, age OMIT age` → `{ name }`).

### 3.1 Path projections (verified forms)

| Form                                  | Result                                                     |
| -------------------------------------- | ------------------------------------------------------------- |
| `SELECT address.city FROM t`           | `{ address: { city } }` (nests by path)                 |
| `SELECT contacts[*].type FROM t`       | `{ contacts: { type: [ … ] } }` (array)                       |
| `SELECT contacts.type FROM t`          | `{ contacts: { type: [ … ] } }` (array — the ancestor is an array) |
| `SELECT contacts[0].value FROM t`      | `{ contacts: { value } }` (scalar — fixed index)             |
| `SELECT contacts[*].type AS t FROM t`  | `{ t: [ … ] }` (alias flattens)                                 |
| `SELECT *, (expr) AS x FROM t`         | full row + `x` (flat)                                   |
| `SELECT VALUE contacts[*].type FROM t` | `[ [ … ] ]` (direct value)                                    |

### 3.2 `FETCH` (links)

| Form                                                                        | Result                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SELECT * FROM t ORDER BY id FETCH author`                                  | `author` materialized (full object)                                    |
| `SELECT * FROM t WHERE … LIMIT n FETCH author`                              | same, respecting the limit                                                  |
| `FETCH a.b`                                                                 | nested (link within link) materialized                                |
| `FETCH a, b`                                                                | multiple (non-links are ignored without error)                                |
| `FETCH` before `ORDER BY`                                                 | **parse error** — FETCH is the last clause                                 |
| `SELECT id, author.name AS an … FETCH author`                               | alias preserved; FETCH does not overwrite                                     |
| `SELECT id, author.id AS author_id, author.name AS author_name` (without FETCH) | flat projection — basis for remounting `include: { author: { select } }` |

### 3.3 Pagination / cursor

| Form                                                                                      | Result                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SELECT … ORDER BY id ASC LIMIT n` + `SELECT count() … GROUP ALL`                         | 2 statements in the same `query` (`paginate`)                                                                                                                   |
| `WHERE (age < $c0 OR (age = $c0 AND id > $c1)) ORDER BY age DESC, id ASC LIMIT n`         | tuple cursor                                                                                                                                             |
| `id > $c` / `id < $c`                                                                     | cursor by record id (`before` reorders client-side)                                                                                                           |
| `SELECT id FROM t ORDER BY age`                                                           | **parse error** (`Missing order idiom`) — the server requires the ordered field in the selection; projection `*` covers it                                                 |
| `SELECT name, age AS _keyset_0, id AS _keyset_1 FROM t ORDER BY age DESC, id ASC LIMIT n` | an alias of the path itself satisfies the order idiom; that's how the cursor projects keyset fields the `select` doesn't return, and the client strips them from `data` |
| `SELECT *, age AS _keyset_0 OMIT age FROM t ORDER BY age ASC`                             | the explicit alias **survives `OMIT`** (even of an ancestor) — the compiler never rewrites `select`/`omit`                                         |
| `ORDER BY <select alias>`                                                              | resolves the **alias**, not the field — that's why a `select` redefining the ordered field's name is a compile error                                           |

> The cursor builds `nextCursor`/`previousCursor` from the **raw** row, never from the
> codec-decoded value: a `datetime` field comes back as the SDK's `DateTime` with nanoseconds (the
> CBOR bind uses `toCompact()`), so `after`/`before` compare the exact database value. The codec's
> `Date` truncates to milliseconds and would make the predicate `field < $c OR (field = $c AND …)`
> skip all rows created in the same ms. `data` stays decoded and without the `_keyset_<n>` aliases.

---

## 4. WHERE — verified operators

### 4.1 Equality / comparison / presence

| Operator             | Emitted form                 | Verified |
| -------------------- | ----------------------------- | ---------- |
| plain value           | `f = $p`                      | ✓          |
| `exact`              | `f == $p`                     | ✓          |
| `isNull`/`isNotNull` | `f = NULL` / `f != NULL`      | ✓          |
| `isNone`/`isNotNone` | `f = NONE` / `f != NONE`      | ✓          |
| `lt/lte/gt/gte`      | `< <= > >=`                   | ✓          |
| `between`            | `f >= $a AND f <= $b`         | ✓          |
| `outside`            | `f < $a OR f > $b`            | ✓          |
| `in`/`notIn`         | `f IN $set` / `f NOT IN $set` | ✓          |
| `inRange`            | `f >= $a AND f <= $b`         | ✓          |

### 4.2 Strings

| Operator                                | Emitted form                                                   | Verified                             |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| `contains`                              | `f CONTAINS $p`                                                 | ✓                                      |
| `startsWith` / `endsWith`               | `string::starts_with(f, $p)` / `string::ends_with(f, $p)`       | ✓                                      |
| `matches`                               | `string::matches(f, /regex/)`                                   | ✓                                      |
| `eqInsensitive` / `containsInsensitive` | `string::lowercase(f) = string::lowercase($p)` / `… CONTAINS …` | ✓                                      |
| `matchesFullText`                       | `f @@ $q` / `f @0@ $q`                                          | ✓ (requires a FULLTEXT index)         |
| `fuzzy` / `anyFuzzy` / `allFuzzy`       | **do not emit** (`~`/`?~`/`*~` = parse error)                    | DIVERGE — use `string::similarity::*` |

**Field-level `regex` (DDL, not a filter):** `.$regex(source, flags?)` emits
`ASSERT $value = /source/`, and `.regex(source, params?, flags?)` is the app-side Zod chain (no DDL).
A string `source` is compiled to a `RegExp` once at authoring time (Bun AOT constant-foldable);
passing a `RegExp` keeps the prior behavior. Explicit `flags` are appended to the DDL literal
(`/^a$/i`) — verified by `aot-regex-json.test.ts` against the identical `RegExp` form when omitted.

### 4.3 Arrays / sets — exact semantics

| Operator       | Form                 | Verified semantics                                                  |
| -------------- | --------------------- | --------------------------------------------------------------------- |
| `contains`     | `f CONTAINS $x`       | element present                                                     |
| `containsNot`  | `f CONTAINSNOT $x`    | absent                                                               |
| `containsAll`  | `f CONTAINSALL $set`  | all of `$set` present in `f`                                      |
| `containsAny`  | `f CONTAINSANY $set`  | some present                                                        |
| `containsNone` | `f CONTAINSNONE $set` | none present                                                       |
| `inside`       | `f INSIDE $set`       | **scalar** inside `$set` (array ≠ element → `false`)              |
| `allInside`    | `f ALLINSIDE $set`    | `f` ⊆ `$set`                                                          |
| `anyInside`    | `f ANYINSIDE $set`    | some element of `f` in `$set`                                       |
| `noneInside`   | `f NONEINSIDE $set`   | no element of `f` in `$set`                                      |
| `notInside`    | `f NOTINSIDE $set`    | negation of `INSIDE`                                                   |
| `outside`      | `f OUTSIDE $set`      | negation of `INSIDE`                                                   |
| `intersects`   | `f INTERSECTS $set`   | `false` for ordinary arrays — use `ANYINSIDE`; use only for geometry |
| `anyEquals`    | `f ?= $x`             | some element `= $x`                                                 |
| `allEquals`    | `f *= $x`             | all elements `= $x`; **empty array → `true`** (vacuous truth)   |
| `length`       | `array::len(f) = $p`  | ✓                                                                     |

### 4.4 Paths / logical / records / geo / vector

| Form                                      | Verified result                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `'address.city'`                           | direct projection ✓                                            |
| `'contacts[0].value'`                      | index works ✓                                            |
| `'contacts[*].type'`                       | returns **array** — equality requires `CONTAINS`/`INSIDE` |
| nested `AND`/`OR`/`NOT`                 | ✓ (explicit parentheses)                                    |
| record value `f = $recordId`               | ✓                                                            |
| `geometry INTERSECTS $geo` / `INSIDE $geo` | ✓                                                            |
| `geo::distance(f, $p) <= $r`               | ✓                                                            |
| KNN `embedding <                           | k, metric                                                    | > $q` | ✓ with HNSW index (see §6) |
| fragmento `surql`                          | interpolates with binds ✓                                        |
| correlated subquery                    | `$parent.id` inside `(SELECT …)` ✓                        |

---

## 5. Graph (complement to `graph-syntax-map.md`, reconfirmed on 3.2.0)

| Form                                                                                     | Result                                                       |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `SELECT ->edge AS e`, `<-edge AS i`, `(<->edge) AS b`                                     | arrays of edges                                               |
| `SELECT ->edge->target AS t`                                                              | array of targets                                                |
| `SELECT ->edge->target.field`                                                             | field values                                                |
| `SELECT ->? AS any`, `<->?` (record-anchored)                                             | edges of any type                                        |
| `SELECT <->edge<->target` (record-anchored)                                               | both directions (not in projection)                             |
| `count(->edge)`, `count(->edge[WHERE …])`                                                 | counts                                                       |
| `->(edge WHERE …)->target`, `->edge->(target WHERE …)`                                    | edge/target filters                                           |
| `(SELECT id, title FROM ->(likes WHERE score > 4)->post ORDER BY title LIMIT 2) AS liked` | include by parent **with the filter on the edge**                        |
| `(SELECT id, out.* FROM ->likes) AS likes`                                                | edge + target in the same object                                   |
| `@.{1..2}->edge->target` / `rec.{1..2}(->edge->target)`                                   | recursion returns **record ids**; projecting inside the body → error |
| `$parent.id`                                                                              | correlation with the outer record                               |

### 5.1 `include` — verified lowering (M3)

Forms the compiler emits (`out` direction; `in` mirrors the arrows to `<-edge<-target` and uses `in.*`):

| `include` form             | Statement                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| link `true`                    | `SELECT * … FETCH author` (link enters the selection if explicit)                                          |
| link `{ select }`              | `author.id AS author_id, author.name AS author_name` + remounting client-side (no FETCH)                 |
| nested link `{ include }`    | `FETCH author.profile`                                                                                  |
| edge `true`                  | `(SELECT * FROM ->likes->post) AS likes`                                                                |
| edge `{ select }`            | `(SELECT id, title FROM ->likes->post) AS likes`                                                        |
| edge `{ where }`             | `FROM ->(likes WHERE <edge>) ->(post WHERE <target>)`; `orderBy`/`limit`/`start` in the subquery            |
| edge `{ edge: true }`        | `(SELECT * FROM ->likes) AS likes`                                                                      |
| edge `{ edge, target }`      | `(SELECT <edge…>, out.* FROM ->likes)` → remounts `{ edge, target }` client-side                           |
| edge `edge`+`target`+`where` | `(SELECT <edge…>, out.* FROM ->(likes WHERE <edge>) WHERE <out.target…>)`                               |
| `in` direction                   | `(SELECT … FROM <-likes<-user)`; `edge`+`target` materializes `in.*` and filters `WHERE in.<field>`         |
| `both` direction (target)        | `(SELECT id, title FROM <->likes<->post)` — the target follows the same direction                                |
| `both` direction (edge)          | `(SELECT * FROM <->likes)`; `edge`+`target` in `both` is **rejected** (there's no single target alias)       |
| wildcard edge                | `(SELECT * FROM ->?)` / `<-?` / `<->?`; edge filter `->(? WHERE score > 4)`                          |
| `_count` (edge)              | `count(->likes) AS _count_likes` / `count(->likes[WHERE score > 4])` / `count(->likes->(post WHERE …))` |
| `_count` (link array)          | `count(friends) AS _count_friends` / `count(friends[WHERE name = 'Alice'])`                             |

Lowering facts the table above relies on (all live-probed on 3.2.x):

- The target subquery returns **full records**; raw traversal would return record ids.
- `FETCH` **does not overwrite** a projected alias (`author.id AS author_id` survives) and does not return
  links outside the selection.
- `out.*` (**edge**+**target**) requires the subquery to stop at the edge (`FROM ->(edge WHERE …)`); moving
  to the target (`->target`) makes `out` `NONE` and the row become `{}` — the target filter goes in
  `WHERE out.<field>`.
- `ORDER BY` inside the subquery requires the field in the selection; projection `*` covers any field.
- `count(<->likes)`, `count(<->?)` and `<->edge<->target` work for `both` direction; but `?.*` is
  **parse error** (hence `edge`+`target` + `both` has no lowering).
- Wildcard edge filter: `->(? WHERE score > 4)` filters the edge row; `->?[WHERE …]` also
  filters the array (the compiler emits the parenthesized form).

### 5.2 Relational `where` — verified lowering (M3)

| Operator                 | Emitted form                                                                   |
| ------------------------ | ------------------------------------------------------------------------------- |
| link `one` `is`          | `<link>.<field> = $p` (nested filter compiled with the link prefix)           |
| link `one` `isNot`       | `NOT (<link>.<field> = $p …)` — true when the link is `NONE`               |
| edge `some`            | `count(<traversal>[WHERE …]) > 0`                                               |
| edge `none`            | `count(<traversal>[WHERE …]) = 0`                                               |
| edge `every`           | `count(<traversal>) = count(<traversal>[WHERE …])` (vacuously true at 0) |
| link array `some`/`none` | `count(<field>[WHERE …]) > 0` / `= 0`                                           |
| link array `every`       | `count(<field>) = count(<field>[WHERE …])`                                      |

### 5.3 Traversal/recursion via `select` + `surql` (M3.5)

No new surface: `select` already accepts fragments, so the sugar is a documented recipe (the
compiler doesn't try to parse `@.{…}` — whoever writes the fragment knows the depth/edge):

```ts
client.users.findMany({
  select: {
    name: true,
    descendants: surql`@.{1..10}->parent_of->person`.as<RecordId[]>(),
    liked: surql`->likes->posts.title`.as<string[]>(),
    likedCount: surql`count(->likes)`.as<number>(),
  },
});
```

- `@.{n}` / `@{n,m}` / `@.{n+collect}` only exist in projection position (`SELECT`); the fragment
  `user:alice.{1..2}(->likes->post)` anchors at an explicit record.
- The body returns **record ids** — projecting fields inside the body is a runtime error
  (`Expected a record ID during recursive graph traversal`); project outside.
- In `/query` the procedural alternative is `block()`.

---

## 6. Full-text and vector

```surql
-- full-text (3.x spelling)
DEFINE ANALYZER ascii TOKENIZERS blank,class FILTERS lowercase,ascii;
DEFINE INDEX idx_ft ON post FIELDS title FULLTEXT ANALYZER ascii BM25 HIGHLIGHTS;
SELECT id FROM post WHERE title @@ 'hello';
SELECT id, search::score(0) AS score FROM post WHERE title @0@ 'hello' ORDER BY score DESC;
SELECT search::highlight('<b>', '</b>', 0, title) AS hl FROM post WHERE title @@ 'hello';
```

| Item                                                 | Verified                                 |
| ---------------------------------------------------- | ------------------------------------------ |
| `SEARCH ANALYZER` (2.x)                              | **parse error** → use `FULLTEXT ANALYZER` |
| `@@` (all indexes) and `@n@` (index `n`)         | ✓                                          |
| `search::score(n)`                                   | number; sorts by alias ✓                 |
| `search::highlight(prefix, suffix, indexRef, field)` | **4 arguments**; 2–3 → error               |

```surql
DEFINE TABLE vec SCHEMALESS;
DEFINE FIELD embedding ON vec TYPE array<float>;
DEFINE INDEX idx_vec ON vec FIELDS embedding HNSW DIMENSION 3 DIST COSINE;
SELECT id, vector::distance::knn() AS dist FROM vec WHERE embedding <|3, COSINE|> $q;
SELECT vector::similarity::cosine(embedding, $q) AS sim FROM vec;
```

---

## 10. Context, raw and admin (M5)

**Context via `USE` (server 3.2.0):**

| Form                                                     | Result                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `USE NS tenant_a DB app; SELECT * FROM t;` (same script) | the following statement runs in the `USE`'s NS/DB; `USE` returns a row `{ namespace, database }`                                               |
| session after the script                                      | **unchanged** (`db.namespace`/`db.database` stay the previous ones) — no global state leakage                                       |
| `USE NS tenant_a;` (without DB)                               | **keeps** the current DB (the response carries `{ namespace, database }`); with no DB selected, the next statement fails (`DatabaseEmpty`) |
| `USE NS ⟨tenant b⟩ DB ⟨my db⟩;`                           | ✓ — identifiers escaped with `⟨…⟩` are accepted (the ORM uses `escapeIdent`)                                                                |
| `USE` inside `BEGIN … COMMIT`                          | accepted by the server (the ORM does not emit `USE` inside a transaction without context)                                                                |

**Raw / functions / admin:**

| Form                                                 | Result                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETURN fn::x($p0, $p1)`                              | ✓ — function via query (context-aware); `db.run("fn::x", […])` is bound to the session                                                                       |
| `INFO FOR ROOT` / `NS` / `DB` / `TABLE t`             | objects with `namespaces`/`databases`/`tables`/`fields`/`indexes`/`events`/`lives`/`functions`/`apis`/…                                              |
| `DEFINE API '/x' FOR get THEN {…} FOR post THEN {…};` | multi-method in **one** `DEFINE API`; each `THEN` returns `{ status, body, headers? }`                                                               |
| `db.api().get('/x')`                                  | resolves `{ status, body, headers, request_id }` (does not reject on 4xx/5xx)                                                                            |
| `db.version()`                                        | `{ version: "surrealdb-3.2.0" }`                                                                                                                    |
| `db.health()`                                         | over WebSocket: resolves (SDK 2.2.0 / server 3.2.0)                                                                                                 |
| `db.import(dump)` (SDK)                               | over WebSocket: breaks (`JSON Parse error`); `db.query(dump)` works                                                                             |
| `db.run`/`export`/`import`/`api`/`auth`               | bound to the SESSION (connection's NS/DB), not to the clone's context                                                                                        |

---

## 8. SDK errors → ORM codes (real samples)

| Server error      | Observed text                                                                                  | `OrmError` code                      |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| duplicate id          | ``Database record `user:u1` already exists`` (`AlreadyExists`)                                   | `RecordAlreadyExists`                  |
| assert/type           | ``Couldn't coerce value for field `password` of `user:u1`: Expected `string` but found `NONE` `` | `AssertionFailed` / `ValidationError`  |
| cancelled transaction   | `The query was not executed due to a cancelled transaction` (`Cancelled`)                        | `TransactionRollback`                  |
| invalid `EXPLAIN`    | `Invalid statement: EXPLAIN is only supported with the new execution model`                      | `ParseError` / `UnsupportedCapability` |
| unsupported `VERSION` | `…The underlying datastore does not support versioned queries`                                   | `UnsupportedCapability`                |
| parse                 | `Parse error: Unexpected token …`                                                                | `ParseError`                           |

Note: in multi-statement scripts, the SDK can **throw** (not just respond per statement) on
`AlreadyExists`/`Cancelled` during collection — the executor uses `responses()` and normalizes both cases.

---

## 9. Lowering decisions the ORM implements

1. **Simplified `update`**: direct target (`UPDATE t:id …`), no `WHERE` workaround; `updateMany` with no match → `[]` (never creates).
2. **`upsert` by single field**: `UPSERT t MERGE $p WHERE uniq = $v` (creates when nothing matches — only if the payload satisfies the `WHERE`) is the lowering when the id strategy is `rand` or the payload has `id`; with generated id (`ulid`/`uuid`) the lowering is `UPSERT ((SELECT VALUE id FROM t WHERE uniq = $v LIMIT 1)[0] ?? type::record(s"t", <fn>())) MERGE $p` (1 statement, `RETURN DIFF` preserved); `LET`+`IF/ELSE` remains the fallback (expressions/create+update).
3. **Remove `parallel`** from the read surface (or mark `UnsupportedCapability`).
4. **Remove fuzzy `~`/`?~`/`*~`**; expose `string::similarity::*` via `fn.*`/fragments.
5. **Full-text**: use `FULLTEXT ANALYZER`; `search::highlight` with 4 args; `matchesFullText` accepts `index`/`indexes`.
6. **`aggregate`**: group `count` via subquery. `SPLIT` + `GROUP` are mutually exclusive on the server, so `aggregate({ split })` (M17) does the UNWIND in an inner subquery and groups outside (§3.1) — `where` filters the PARENT. Each aggregator's **operand** is validated against the schema (§2.4.3): `math::*` is number-only and the server answers `0`/`null`/`{}` for everything else without any error.
7. **Path-array equality** becomes `CONTAINS` (or `INSIDE` for scalar membership) — not `=`.
8. **`range`** → `t:<start>..<end>` / `t:<start>..=<end>`.
9. **Cursor** by tuple confirmed; `before` reorders client-side. The **tiebreaker** (last `orderBy` field) must be unique: at runtime it's `CursorTiebreakerRequired`, and in the TYPE since M17 — `.index(name, [field], { unique: true })` registers the field in `TableDef`'s third parameter, and `CursorArgs.orderBy` accepts only orderings whose last field ∈ `id ∪ uniques` (a composite index doesn't count: the fields are unique only together).
10. **`ON DUPLICATE`**: `$input` only for payload values; increment via subquery (also evaluated in the creation branch → upsert with expression uses `LET`/`IF`); `RETURN BEFORE` returns the previous state (3.2.4) and `RETURN DIFF` has its own nested shape.
12. **`.explain()`** on reads only; `VERSION` and `PARALLEL` subject to capability/backend.
13. **`FROM ONLY t:missing`** → falsy (not an error) — `findUnique` returns `null`.
14. **`INSERT RELATION INTO`** available for batched edges.
15. **`fn.ts` catalog**: `search.highlight` is typed with 3 args (`f3<string, string, number, string>`) but the server requires 4 (`prefix, suffix, indexRef, field`) — fix in M5.2 (or on the next touch of `fn.ts`) and cover with the live test (today `fn-catalog.test.ts` marks `search.highlight: null`).
16. **`only` (findMany)**: `FROM ONLY <table>` is valid only with **exactly one** result (otherwise an error). The compiler emits `FROM ONLY`; use `limit`/`where` to guarantee uniqueness (`findUnique`/`findFirst` cover the common cases).
17. **Clause order**: `WITH` → `WHERE` → `SPLIT` → `GROUP` → `ORDER BY` → `LIMIT` → `START` → `VERSION` → `TIMEOUT` (the compiler emits in this order; the server rejects others).
18. **`count()`/aggregators without `GROUP ALL`**: `count()` becomes one row per record; `math::*` requires an array. `aggregate`/`count` always emit `GROUP ALL`/`GROUP BY`.
19. **`ORDER BY`**: identifier/alias only — a parenthesized expression is a parse error; use `SELECT (expr) AS alias … ORDER BY alias`.
20. **Path projection**: the server nests by path (`contacts[*].type` → `{ contacts: { type: [ … ] } }`); an alias flattens (`AS t` → `{ t: [ … ] }`). The decoder mirrors this shape.
21. **`SELECT *` + `GROUP`**: invalid ("cannot be aggregated") — `groupBy`/`groupAll` require explicit projection (the compiler fails with `ValidationError` pointing at `aggregate()`).
22. **Record ranges**: `t:1..=2` / `t:abc..=xyz` (id suffix, never `t:1..t:2`); non-identifier ids are escaped (`⟨a-b⟩`).
23. **`math::avg` does not exist in 3.x** (parse error; the server suggests `math::log`) — the ORM keeps the `{ avg: 'field' }` API and emits `math::mean(field)`. `math::median/stddev/variance` exist.
24. **`GROUP BY` requires the key in the projection** (`Missing group idiom … in statement selection`): `aggregate` validates that every `groupBy` appears in the `select` (when the projection is statically analyzable) and teaches how to fix it. The key can be **the output alias OR the projected path** — the server accepts both spellings (3.3.4: `SELECT tenant AS t … GROUP BY t` and `… GROUP BY tenant`), so `select: { customerName: "customer.name" }` + `groupBy: ["customerName"]` is valid and no longer rejected.
25. **Writes (M2)**: singular targets = `id`, a single-field UNIQUE index, **or a COMPOSITE UNIQUE index whose ALL fields are in the `where`** (M17 — `[tenant_id, email]` is the multi-tenant unique target; a partial `where` is still rejected because it matches several rows, and the message names the group); `update` never creates (`[]` → `null`); `delete` only `before`/`none`; `deleteMany` requires `all: true` without `where`; `updateEach`/`skipDuplicates` = 1 statement per item (and `skipDuplicates` generates an id per row when the item has no `id`); `upsertMany.conflict` requires a UNIQUE index; `RETURN DIFF` is flattened on decode (`[[ops]]` → `ops`) and **summed across the statements** of the batch (`update` data+unset, `createMany`, …); `INSERT/upsert RETURN BEFORE` returns the previous state — the type is `App | null`; string `id` becomes `RecordId` in the payload. `upsert` is **STRICT by default** (`onMissing:"throw"`): `UPDATE ONLY t:id` / `UPDATE t … WHERE uniq`, miss → `ResultNotFound` (never creates, never resolves `null`); `onMissing:"create"` restores create-or-update. Target: `where` (id/UNIQUE) > inferred `data.id` > **no target = plain `CREATE`** (id by `idStrategy`); explicit `onMissing:"throw"` without a target, distinct branches without a target and a target-less `mode` are `ValidationError` (guards shared with `upsertDelta`, `resolveUpsertTarget` + `assertTargetlessCreate`).
26. **Records in `where`**: a `"table:id"` string in a record column (including `id`) is converted to `RecordId` by the compiler — otherwise the value would become a string and match nothing (silent no-match).
27. **Link `include`**: `FETCH` is the last clause, the link must be in the selection (the compiler adds it when needed), a projected alias survives FETCH, and the include filter is the edge/target split (`->(edge WHERE …)->(target WHERE …)`).
28. **Edge `include`**: target records only via subquery; `in` direction flips both arrows (`<-edge<-target`) and materializes `in.*`; `edge`+`target` uses `out.*`+`WHERE out.<field>` and is remounted as `{ edge, target }` client-side. `both` direction: `<->edge<->target` works for the target and `<->edge` for the edges, but `edge`+`target` is rejected (there's no single target alias; `?.*` is a parse error).
29. **`include._count`**: `count(->edge)`/`count(<-edge)`/`count(->edge[WHERE …])` for edges and `count(field)`/`count(field[WHERE …])` for array links (`array::len` errors on `NONE`); remounted as `_count: { <key>: n }`.
30. **Relational `where`**: `is`/`isNot` for a `one` link (true negation at `NONE`), `some`/`none`/`every` for edges and array links; `every` by count equality; `NOT` in a traversal filter requires parentheses.
31. **Graph `include` rejects** `value`/`groupBy`/`groupAll`/`split` and `orderBy` outside the target projection (the server requires the order idiom).
32. **Projected link without `id`**: the compiler always projects the link's `id` (a presence leaf, hidden from the result) — without it a missing link would be indistinguishable from an object of null fields. A missing link decodes to `null`; a missing array, `[]`.
33. **Wildcard edge filter**: `->(? WHERE score > 4)` (emitted form) and `->?[WHERE score > 4]` filter; the keyed form `->?` without a filter returns the edges.
34. **Relational `where` in writes**: `updateMany`/`deleteMany`/`unrelateMany` compile the SAME lowering as reads (`SchemaIndex` flows into the write compiler). Singular `update`/`delete`/`patch`/`upsert` still require `id` or a UNIQUE index.
39. **Transactions**: only `mode: 'sdk'` (SDK's `beginTransaction`/`commit`/`cancel`) — `mode: 'sql'` fails fast with `UnsupportedCapability` (BEGIN doesn't survive across RPCs); batch wrappers skip the implicit `BEGIN` inside the tx; nested = same tx; re-entry from the root client → `TransactionAlreadyActive`; write conflict is retryable (`WriteConflict`); `timeout` is a client-side deadline with `cancel`.
40. **HTTP vs WebSocket**: the transaction requires the WebSocket engine; over HTTP the error normalizes to `UnsupportedCapability`.
41. **Context (`$withContext`)**: `USE NS … DB …;` prefixed on the SAME operation scopes without touching the session; the missing side (NS or DB) is inherited from the session (`conn.namespace`/`database`) and the absence of both is `ValidationError`; the per-call override (`context: { database }`) wins over the clone. Session-bound operations (`api`/`auth`/`export`) fail fast with `UnsupportedCapability` on a prefix clone; `$withContext({ auth })` forks a session (Promise) to scope those operations.
42. **Raw**: `$raw` (1 statement — a script with N statements is **rejected** with `ValidationError` pointing at `$query`, instead of returning the first result and silently discarding the rest; an initial `LET` used to become `null` without error) and `$query` (N) parameterize `${…}` via `renderValue` (a fragment composes, a value binds); `$query({ throwOnError: false })` returns `StatementResult[]`; `$unsafe` requires `raw.unsafe: true` (`UnsafeDisabled`); `raw.requireComment` requires `meta.comment` in a write script; `raw.timeoutMs` applies only to a single statement with a compatible verb.
43. **`fn`/`api`/`auth`/admin**: `fn.call` compiles `RETURN fn::x($p…)` (name validated, never spliced) + a typed shortcut per `defineFunction` (NAMED args → positional) + `fn.expr` (M17), the **fragment form** of the same catalog (`fn::<name>($p0, …)` as `Surql`, with binds merged into the composing statement) — that's what lets a repo's own `fn::` (`fn::jw`, `search::rrf`) enter a typed `where`/`select`/`orderBy` instead of `$query`; `search::rrf` joined the `fn.ts` catalog (the RRF half of a hybrid search, whose other half is already `where: { name: { matchesFullText } }`); `api.*` unwraps `body` and throws `DatabaseError` with `status`/`details` on `>= 400`; `auth.*` is a session passthrough (`record()` without record access → `NotAuthenticated`); `info` compiles `INFO FOR …`, `ping` does `RETURN true`, `import` replays the dump via `query()`.
44. **`extends`**: helpers are re-applied on clones (`$withContext`/`forkSession`) and on the transaction client; a name collision with the client surface = fail-fast `PluginError`.
45. **Per-table id strategy (`idStrategy`)**: the ORM generates the id on the SERVER — `create`/`createMany`/`create.relate` via target `type::record(s"t", rand::ulid()|rand::uuid())` (or a simple table for `rand`, the server default); `insert`/`insertMany`/`skipDuplicates` via an expression `id` field; `upsert`/`upsertMany` by single field via a target-expression (subquery `?? type::record(…)`). Default `ulid`; explicit `id` and singleton always win; `id: s.uuid()/s.ulid()` infers the strategy and an incompatible `.idStrategy` is `SchemaInvalid` in the `schema`; a resolved uuid v4/v6 `id` becomes `"none"` (explicit-only) and a create without an `id` fails at compile time with a teaching error. **No DDL** (migrations never differ) and raw SQL/`sc pull` keep/revert to the server default.
46. **`upsertDelta` (strict update by default, with delta)**: target by the SAME resolution as `upsert` (`resolveUpsertTarget`: `where` id/UNIQUE, inferred from `data.id`, or no target = `CREATE` with id by `idStrategy`); the `RETURN VALUE { before: $before, after: $after }` envelope accompanies EVERY lowering (`UPSERT` id/single field/generated subquery, strict `UPDATE`, `CREATE`, and per branch in `LET`/`IF` — with per-branch `TIMEOUT`); `onMissing: "throw"` (the DEFAULT) compiles `UPDATE ONLY t:id` or `UPDATE t … WHERE uniq` and a result without the envelope becomes `ResultNotFound`, with the message classified by the PLAN (`strictMiss` — a target-less create filtered by permission does NOT assert `onMissing:"throw"`); `onMissing: "create"` restores create-or-update; the delta compares **decoded** values (`Date`/`RecordId`/`Decimal`/… via `.equals()`, never wire strings), only changed fields, in the key order of `after`; distinct branches (`create`+`update`) always use `LET`/`IF`, never `INSERT … ON DUPLICATE` (and require `onMissing:"create"`).
47. **Strict upsert (the default of both)**: a target that doesn't exist **or is filtered by permission/scope** rejects `ResultNotFound` — it never creates silently nor resolves `null`; the classification comes from the compiled PLAN (`strictMiss`, set only by the strict lowerings `UPDATE ONLY t:id`/`UPDATE … WHERE uniq`), never from `args.onMissing` — the message differs between strict ("it never creates; pass onMissing: create") and non-strict ("wrote no row — check access/$withoutPlugins"), and a target-less filtered create uses the second even with the default `"throw"`. Strict `return:"none"` compiles WITHOUT `RETURN NONE` (the miss must be observable) and decode discards the row; strict `return:"diff"` is `ReturnNotSupported` (an empty diff can't distinguish "didn't match" from "didn't change"); `create`+`update` require `onMissing:"create"`. `upsertMany` remains insert-style (no change).
48. **Hostile identifiers (`⟩`/`\`)**: the SDK's `escapeIdent` emits `\⟩`, which SurrealDB 3.2 **rejects** ("Invalid escape sequence") and which, with `\` before `⟩` (`x\⟩ OR true OR ⟨y`), becomes `⟨x\\⟩ OR true OR ⟨y⟩` — the identifier closes early and the rest executes as SQL (live-probed injection). The driver now uses `escapeIdentSafe` (`src/surreal/ident.ts`): names with `⟩` or `\` are **backtick-quoted** (with `\` and the backtick escaped); others keep the SDK's canonical output (`⟨…⟩`/bare).

---

## 11. Logger & `EXPLAIN` plans (M9)

The forms the logger renders (the **plan shape is informational and may change
between versions** — the renderer degrades to `JSON.stringify` instead of throwing):

| Form                                    | Result                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `EXPLAIN SELECT …` (prefix)             | indented **string** (`SelectProject [ctx: Db] [projections: *]\n    TableScan […]`) — that's what `.explain()` emits; `SELECT` only |
| `EXPLAIN FORMAT JSON SELECT …`           | **object** `{ operator, context, attributes, children[], metrics? }` (no metrics)                                            |
| `EXPLAIN ANALYZE [FORMAT JSON] SELECT …` | same + `metrics: { elapsed_ns, output_rows, output_batches }` and `total_rows` (re-executes the query)                              |
| `SELECT … EXPLAIN [FULL]` (suffix)       | the same structured **object** (`FULL` brings the metrics)                                                                       |
| `EXPLAIN UPDATE/…`                       | `Invalid statement: EXPLAIN is only supported with the new execution model` → `ParseError`                                     |

The logger observes the **executor** (`runScript`), not hooks: it covers reads/writes/`$raw`/`fn`/admin/
`.explain()` **without** violating the "explain fires no hooks" contract. Auto-`EXPLAIN`
(`explain: "slow" | "all" | "analyze"`) reuses the forms above and never logs itself.

---

## 12. String ids — codec and comparisons (M15)

String-id mode changes only the APP: the schema becomes a codec whose **wire** is `string | RecordId`
and whose **app** value is a bare string. Nothing new is emitted in the DDL (`record<…>` unchanged),
but value encoding has live-probed facts that justify it:

| Fact (server 3.2.0)                                         | Result                                                                 | Lowering consequence                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `CREATE t:01MABCDEFGHJKMNPQRSTVWXYZ` (ULID-like, unescaped) | accepted; the id is the STRING `01M…` and the server renders it `t:⟨01M…⟩`        | the codec can emit `new RecordId(t, bare)` (the SDK doesn't escape ULIDs)             |
| `WHERE ref = $p` with `$p` a string (`"o1"`)                   | **does not match** (type-vs-type comparison)                                    | `where`/cursor ALWAYS coerce to `RecordId` before binding                       |
| `WHERE ref = $p` with `$p = new RecordId(t, bare)`           | matches                                                                      | the codec's encode direction (`RecordId(table, bare)`)                             |
| `WHERE id > $p` with `$p = RecordId(t, bare)`                | filters correctly (ULIDs sort like strings; numerics sort before) | cursor keyset with bare `after`                                                |
| `WHERE id > $p` with `$p` a raw string                         | **not** the keyset (doesn't filter / filters wrong)                           | `cursorValues` coerces per column (`record` → `RecordId`, `datetime` → `DateTime`) |
| `ORDER BY id`                                               | ints before strings; chronological ULIDs among themselves                        | chronological id-only cursor with the default `rand::ulid()`                          |
| `record::id(id)`                                            | the raw id part (string/int/uuid)                                      | the codec's decode uses `RecordId.id` + `bareIdValue` (never re-parses)               |
| `u"…"` in the id part                                           | uuid                                                                      | unescape accepts `u"…"` (string-id wire)                                          |
