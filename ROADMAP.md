# Better-schemic — roadmap

The **typed-query/ORM arc**: replacing the old fluent builder with the repository-style `/orm` layer.
The design + execution plan is **[`PLANO-QUERYS-TIPADAS.md`](./PLANO-QUERYS-TIPADAS.md)** (milestones
M0–M7 with a point-by-point API checklist); the live-verified SurrealQL ground truth the compiler must
emit against is `drivers/surrealdb/docs/orm-syntax-map.md`.

Packages release **in lockstep**; see `CHANGELOG.md` for what's shipped vs accumulating.

Legend: ✅ done · 🚧 in progress · 🟡 partial · ⏳ not started

---

## M0 — fundação + substituição do legado ✅ *(complete)*

- ✅ **M0.1** live syntax map (`docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`, 77 probes) —
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
  NONE-safe, FETCH needs the link selected, subquery `ORDER BY` needs the order idiom.
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

Typed end to end: `S` flows through `Delegate`/`ReadArgs`/`Where`/`ResultOf`, with
`types/{include,relations}.ts` deriving links, edges, targets and `_count` from the authored schema.
New modules: `orm/compiler/{include,relations}.ts`, `orm/types/{include,relations}.ts`; hydration in
`orm/decode.ts`. Live: `test/live/orm-relations.test.ts` (9 e2e) + 7 new syntax probes (77 total).

## M4 — transações, live e changefeeds ⏳ *(next)*

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
