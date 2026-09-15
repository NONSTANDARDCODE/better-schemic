# Changelog — better-schemic

All notable changes to the better-schemic packages (`@better-schemic/core`, `@better-schemic/cli`,
`@better-schemic/surrealdb`, `create-better-schemic`, `better-schemic`) are recorded here. The packages release
**in lockstep** (one version across all five), so this is a single changelog.

> **Fork notice.** better-schemic is a **SurrealDB-only** fork of
> [Schemic](https://github.com/NONSTANDARDCODE/better-schemic), forked from schemic commit
> [`720ada2`](https://github.com/NONSTANDARDCODE/better-schemic/commit/720ada27d3995ac96bd2000289bacb895bd9c06e).
> The pre-fork history is preserved frozen in [`CHANGELOG_OLD.md`](./CHANGELOG_OLD.md) for
> reference — no new entries go there. Versioning continues the schemic numbering.
> The `Unreleased` section below carries over everything that was unreleased in the OLD
> changelog at the fork commit, plus the fork's own changes.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Changes **accumulate** under
**Unreleased** and are stamped into a version section on release cut. Entries are tagged by package
(**core** / **cli** / **surrealdb** / **setup**).

## [Unreleased]

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
  sqlite `instr()>0`). BREAKING (alpha, unreleased — query P1 is post-`alpha.24`): surreal renamed its
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

### Fixed
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
