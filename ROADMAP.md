# Better-schemic — roadmap

The **typed-query/ORM arc**: replacing the old fluent builder with the repository-style `/orm` layer.
The design + execution plan is **[`PLANO-QUERYS-TIPADAS.md`](./PLANO-QUERYS-TIPADAS.md)** (milestones
M0–M7 with a point-by-point API checklist); the live-verified SurrealQL ground truth the compiler must
emit against is `drivers/surrealdb/docs/orm-syntax-map.md`.

Packages release **in lockstep**; see `CHANGELOG.md` for what's shipped vs accumulating.

Legend: ✅ done · 🚧 in progress · 🟡 partial · ⏳ not started

---

## M0 — fundação + substituição do legado ✅ *(complete)*

- ✅ **M0.1** live syntax map (`docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`, 51 probes) —
  every statement the ORM emits, verified against server 3.2.0, with the prototype divergences recorded.
- ✅ **M0.2** `defineSchema` + `SchemaIndex` (columns/families, record links, graph adjacency,
  singletons, functions, schemaless entries; fail-fast `SchemaInvalid`).
- ✅ **M0.3** result wrappers (`ThrowingResult`/`BatchResult`/`StatementResult`) + `BetterSchemicError`
  catalog, SDK-error normalization and predicates.
- ✅ **M0.4** executor: one `conn.query` round-trip for N statements, per-statement status via
  `responses()`, atomic `BEGIN/COMMIT` batches, unique-binds guardrail.
- ✅ **M0.5** `/orm` bootstrap (`betterSchemic`/`createBetterSchemic`, delegates, `repository`,
  `tables`, `extends`, `forkSession`, BYO-managed lifecycle) + **the legacy surface removed** (fluent
  builder, `/client`, `@better-schemic/core/query`; `/query` keeps `block()`).

## M1 — leitura ⏳

Compiler (object-based `where`/`select`/clauses) + `findMany`/`findFirst`/`findUnique`/`count`/
`exists`/`aggregate`/`paginate`/`cursor` + `.throw()`/`.explain()` + read result typing.

## M2 — escritas ⏳

`create`/`insert` (+`onDuplicate`)/`update` modes (`merge|set|content|replace|patch`)/`patch`/`upsert`
(+by unique)/`delete`/`updateEach`/`relate`/`unrelate` + `RETURN` semantics + batch envelopes.

## M3 — relações e grafos ⏳

`include` (`FETCH`/traversal/`edge`/`target`/`_count`), relational `where`
(`is`/`isNot`/`some`/`every`/`none`), traversal/recursion sugar over `surql`.

## M4 — transações, live e changefeeds ⏳

`client.transaction` (sdk/sql, retries on write conflict, `afterCommit`/`afterRollback`), `live()` +
subscriptions, `changes()` (`SHOW CHANGES`).

## M5 — escape hatches, admin e contexto ⏳

`$raw`/`$query`/`$unsafe`, `fn.call`/`api`/`auth`, `info`/`version`/`ping`/`export`/`import`,
`$withContext` (NS/DB/session), project helpers/state.

## M6 — plugins e hooks ⏳

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
