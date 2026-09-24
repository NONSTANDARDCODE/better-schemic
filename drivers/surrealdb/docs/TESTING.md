# Testing & MC/DC coverage — `@better-schemic/surrealdb` (+ `@better-schemic/core`)

better-schemic aims for **SQLite-grade test rigor**: 100% decision/condition coverage and a strong
mutation score, exercised against a **real** SurrealDB, with as few mocks as possible. This doc is the
how-to and the honest statement of what the metrics mean.

## The commands

```bash
bun run test:coverage          # whole workspace under the instrumenter + report + gate
bun run test:coverage:report   # re-render the report from the last run's fragments
bun run test:coverage:check    # enforce the per-file ratchet (coverage.config.json)
bun run test:coverage:update   # record the CURRENT numbers as the new floor (ratchet)
bun run test:coverage:gaps     # print every uncovered line / branch arm / condition (mechanical)
bun run test:coverage:gaps drivers/surrealdb/src/orm/compiler   # …filtered

bun run test:mutation          # Stryker mutation gate over the scoped pure compilers + ratchet
bun run test:mutation:update   # record the CURRENT scores as the new floor (ratchet)
```

`bun run test:coverage` is a **separate, slower** pass (instrumentation overhead); the normal
`bun test` / `land.ts` gate is untouched (the preload is a no-op unless `COVERAGE=1`).

## What "MC/DC" means here (and its honest limit)

No mainstream JS/TS tool computes **true** MC/DC (independence pairs). JS `&&`/`||` short-circuit,
so **100% branch coverage + 100% condition (truthiness) coverage** is the practical equivalent —
exactly the point SQLite makes about C ("MC/DC and branch coverage are very nearly the same thing").

- **Tier 1 — measured.** `oxc-coverage-instrument` (`reportLogic: true`) emits, per file:
  statements, functions, branch arms, and `bT` — each logical operand's **truthy count**. A condition
  is covered only when it was evaluated **both truthy and falsy**. Constant operands (`x || {}`,
  `a ?? "d"`, `flag && true`) are excluded from the denominator: MC/DC covers every **non-constant**
  condition. The gate enforces all five metrics per file via `coverage.config.json` (a ratchet — a
  green run can never regress).
- **Tier 2 — independence pairs (implemented).** `analyzeMcdc`/`describeMcdc` in
  `@better-schemic/core/testing` compute **real** MC/DC: for a decision, every condition must have a
  **unique-cause independence pair** — two assignments that differ *only* in that condition and flip
  the outcome. The helper enumerates the full truth table (or the explicit `cases` a suite exercises,
  for real coverage) and fails a **named** test when a condition has no pair (a redundant operand
  like `a && a`, or a masked one). Use it on the pure, decision-dense predicates; the `bT` metric
  proves an operand was seen true *and* false, but never that it *independently* changes the outcome.

  ```ts
  import { describeMcdc } from "@better-schemic/core/testing";
  import { isNotFound } from "../src/orm/errors";

  describeMcdc({
    label: "isNotFound",
    conditions: ["isError", "ResultNotFound", "RecordNotFound"],
    evaluate: ({ isError, ResultNotFound, RecordNotFound }) =>
      isNotFound(errOf(/* map the assignment to a real input */)),
  });
  ```

  > **Deferred:** the AST **decision inventory** (enumerate every `src` decision and require each be
  > Tier-1 `auto` or Tier-2 `table`) needs a TS/oxc parser dependency the repo doesn't ship; until
  > then, `describeMcdc` is applied per decision, by name.

Because Tier 1 runs the real suites, the conditions are exercised through the public API, not by
calling private predicates — which is the point.

## MC/DC decision inventory

Tier 1 tells you how a decision *scored*; the inventory tells you every decision *exists* and how it
is proven. `scripts/mcdc/{inventory,reconcile}.ts` enumerate every MC/DC-relevant decision in the
in-scope sources with the **TypeScript compiler API** (already a devDependency) and classify each:

- **auto** — the current coverage run proves it (Tier-1 `bT` condition coverage for a compound
  decision; both-arms-hit for a guard);
- **table** — listed in `mcdc-manifest.json`, mapped to a `describeMcdc` label that a real test
  declares (Tier-2 unique-cause proof);
- **unknown** — neither. These are the backlog; `mcdc.config.json` ratchets the **per-file** unknown
  count so a NEW unclassified decision fails the gate (and a pruned one must drop the floor).

The inventory is the deferred M8.3 AST-reconcile item — no parser dependency was needed after all.

```bash
bun run test:coverage:mcdc          # reconcile + gate (needs a coverage run)
bun run test:coverage:mcdc -- --list   # print every unknown decision
bun run test:coverage:mcdc:update   # record the current unknowns as the floor
```

A "decision" is a logical operator (`&&`/`||`/`??`), a conditional expression, or an `if` guard.
Nested operators in one chain are flattened to the outermost (matching the instrumenter's single
branch); loop guards (`while`/`for`) and `switch` are excluded (no MC/DC independence, and no
instrumenter branch). `scripts/coverage/run.ts` runs the reconcile after the coverage gate, so the
coverage CI job enforces both.

## Mutation testing

Coverage proves a line/decision *ran*; mutation proves the tests actually *assert behavior*. The
gate runs StrykerJS against the **scoped pure compilers** (the `orm/compiler/*` modules,
`surql-type-expr`, `driver/surql-type`, `checks`-adjacent string logic and core `cli-kit/filter`) and
fails on any **per-file mutation-score** regression below `mutation.config.json` (`floors`, a ratchet
recorded with `bun run test:mutation:update`).

- **Engine.** StrykerJS core + `scripts/mutation/bun-runner.ts` — a local plugin that
  implements Stryker's `TestRunner` by shelling `bun test` (Stryker ships no Bun runner). Stryker runs
  **under Bun** (`bun <stryker bin>`) so the worker can import the `.ts` plugin directly. The runner
  maps a nonzero exit to **Killed**, a zero exit to **Survived**, and a hard timeout to **Timeout**.
- **Offline.** `coverageAnalysis: "off"`; the runner forces `COVERAGE=0` and uses a **server-less**
  bunfig (`scripts/mutation/bunfig.mutation.toml` drops the live preload), so mutants never boot a
  SurrealDB. Only the offline unit suites are run.
- **Per-mutant test selection.** `mutation.config.json.testFilesByFile` maps each mutated source to the
  test file(s) that cover it (falling back to `testFiles` — the whole unit suite). Narrowing the test
  set keeps a mutant's run honest *and* fast; a mutant that only an unrelated suite would kill is a
  survivor here, which is the signal to write a direct test.
- **Concurrency.** With `coverageAnalysis: "off"` every mutant is **static**: it must run in a fresh
  process (activated by `__STRYKER_ACTIVE_MUTANT__`), because a static mutant can't be hot-swapped in
  a loaded environment. Static-ness forces a *reload*, not *serialization* — Stryker's worker pool
  schedules mutants dynamically across `concurrency` workers, each spawning its own `bun test` child,
  so they run in parallel. `run.ts` sizes the pool at the CPU count (capped at 8); tune with
  `--concurrency <n>` (or `MUTATION_CONCURRENCY`). Dynamic scheduling also load-balances: unlike the
  old static file shards, no worker can end up the straggler.
- **Equivalent mutants** (a mutation no test *could* distinguish, e.g. reordering a commutative
  build) are disabled inline with `// Stryker disable next-line <Mutator> -- <reason>` — the reason is
  reviewable, unlike a silent survivor.

| Path | Role |
| --- | --- |
| `scripts/mutation/run.ts` | run Stryker (dynamic worker pool) → ratchet |
| `scripts/mutation/bun-runner.ts` | the `TestRunner` plugin (spawns `bun test`, maps results) |
| `scripts/mutation/bunfig.mutation.toml` | server-less bunfig for mutant runs |
| `scripts/mutation/ratchet.ts` | per-file mutation-score gate |
| `stryker.config.json` | Stryker options + the scoped `mutate` list |
| `mutation.config.json` | per-file test selection + the score floors (ratchet) |

## Property-based testing

The pure compilers/parsers take generated, adversarial inputs and assert **invariants** — not golden
strings — with [fast-check](https://fast-check.dev). These catch whole classes of escaping/binding/
round-trip bugs that hand-picked examples miss (and they have: see the type-bridge fixes below).

| Path | Covers |
| --- | --- |
| `drivers/surrealdb/test/property/compilers.pbt.test.ts` | `compileWhere` (injection safety, bind totality, purity), paths/`joinAnd`, record ids, the `SurqlType` bridge, the check/duration/datetime/int bridges |
| `packages/core/test/property/filter.pbt.test.ts` | `parseFilter` (defaults, token splitting, determinism) + `inCat` |

Invariants asserted:

- **Injection safety** — an adversarial field name is escaped (`⟨…⟩`) and a runtime value is ALWAYS
  bound (`$pN`), never spliced into the SQL text.
- **Bind totality** — every `$pN` in the compiled SQL exists in `vars`, and vice-versa.
- **Purity** — identical args → identical `{ sql, vars }`.
- **Round-trips** — `splitRecordId`↔`recordIdParts`, `parseSurqlType`↔`emitSurqlType` (the lossless
  claim), `formatAssert`↔`formatForAssert`, the duration/datetime bridges, `pathSegments`, `joinAnd`.

Budget is `PBT_RUNS` (default 100) cases per property; `PBT_SEED` pins a reproducible run. CI and the
**mutation gate** pin both (`PBT_SEED=20240101`, `PBT_RUNS=50`) so a mutant's kill/survival is
deterministic against a zero-tolerance ratchet. fast-check prints the failing counterexample + seed,
so any red run is replayable.

> Found via PBT (all fixed): `parseSurqlType`/`normalizeType` tested the greedy `option<…>` wrapper
> BEFORE the top-level union, so `option<int> | string` was mis-parsed; `emitSurqlType` emitted
> `option<none>` for `option<never>` (re-parsing to `option<option<never>>`); and a nullable union of
> >1 member sorted `null` last instead of as a flat member.

## Fuzzing

The hand-written string scanners are fuzzed against arbitrary bytes, deep nesting, quotes/backslashes,
huge unions and a committed seed corpus, asserting the two properties that matter at a boundary:
**never throw** (or only a documented error) and **never hang** (no catastrophic backtracking), plus
the claimed idempotence/round-trips.

| Path | Targets |
| --- | --- |
| `drivers/surrealdb/test/fuzz/parsers.fuzz.test.ts` | `splitTopUnion`/`topLevelSplitOnce`, `parseSurqlType`/`emitSurqlType`/`normalizeType`, `formatForAssert`, `stripOuterParens`/`toFragment` (bind namespacing), `hasTopLevelSemi` |
| `packages/core/test/fuzz/filter.fuzz.test.ts` | `parseFilter` at scale (200-token lists, arbitrary bytes) |

A hang is detected by Bun's own per-test timeout (sync code can't be interrupted cooperatively); a
time-bounded corpus asserts each call finishes well under budget. Budget is `FUZZ_RUNS` (falls back to
`PBT_RUNS`, default 300). The suites run inside the normal `bun test` gate — no separate job.

## Real DB, minimal mocks

- **Live/parity suites always run.** `test/preload-server.ts` boots **one** ephemeral SurrealDB per
  run (the local `surreal` binary) and exports `SURREAL_URL`, so every `tryConnect()`-based suite
  executes instead of skipping. The ORM live suites still boot their own isolated servers.
- **e2e CLI coverage.** `test/e2e/harness.ts` passes the same preload to the spawned CLI child
  (`bun run --preload … run <cli>`), so `commands.ts` / `cli/introspect.ts` / `driver/surreal.ts`
  contribute fragments keyed by pid; the runner merges them. **NOTE:** a built `lib/` makes the child
  resolve `@better-schematic/*` to `lib/…js` instead of the instrumented `src/*.ts`, silently
  collapsing e2e coverage — the CI coverage job never builds, and `run.ts` warns if `lib/` exists.
- **Mocks are a last resort.** Only the offline unit suites use the small `fakeConn` harness; the
  rest hit a real server.

## Files

| Path | Role |
| --- | --- |
| `scripts/coverage/preload.ts` | Bun plugin: instruments in-scope sources, flushes `__coverage__` per pid |
| `scripts/coverage/lib.ts` | fragment merge (custom, `bT`-safe), per-file metrics incl. conditions |
| `scripts/coverage/run.ts` | run the suite under coverage → report → gate |
| `scripts/coverage/report.ts` | merge + HTML/LCOV/JSON + text table |
| `scripts/coverage/check.ts` | per-file ratchet gate |
| `scripts/coverage/gaps.ts` | print uncovered lines/arms/conditions with snippets |
| `scripts/mcdc/inventory.ts` | enumerate MC/DC decisions via the TypeScript compiler API |
| `scripts/mcdc/reconcile.ts` | classify decisions auto/table/unknown + per-file ratchet |
| `mcdc-manifest.json` | decisions proven by a `describeMcdc` table test |
| `mcdc.config.json` | per-file unknown-decision floor (ratchet) |
| `drivers/surrealdb/test/preload-server.ts` | shared ephemeral SurrealDB for live/parity |
| `coverage.config.json` | include roots, excludes, thresholds, per-file waivers (the floor) |

## Workflow

1. `bun run test:coverage` (or a focused run) → `bun run test:coverage:gaps <file>`.
2. Write tests that close the listed statements/arms/conditions.
3. `bun run test:coverage` → green.
4. `bun run test:coverage:update` to lock the new floor, then commit.

> The `coverage.config.json` waivers are a **temporary** floor, not a target: every waiver is a TODO
> to delete once the file is at 100%.

## CI

`.github/workflows/ci.yml` keeps the hot gate fast and puts the heavy, slower gates in separate jobs:

| Job | Runs | Notes |
| --- | --- | --- |
| `gate` | build · typecheck · test | includes the PBT + fuzz suites (they're normal `bun test` files) |
| `coverage` | `bun run test:coverage` | installs the pinned `surreal` binary so live/parity never skip; also enforces the MC/DC reconcile |
| `mutation` | `bun run test:mutation` | offline (no DB), parallel test-runner workers |
| `type-perf` | `bun run scripts/type-perf.ts` | attest type-completeness + instantiation budgets |

All heavy gates are **separate jobs**: `land.ts` and the `gate` job stay quick, and a regression fails
the specific job (coverage, mutation or MC/DC) with the per-file detail.
