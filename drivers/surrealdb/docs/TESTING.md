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

## Real DB, minimal mocks

- **Live/parity suites always run.** `test/preload-server.ts` boots **one** ephemeral SurrealDB per
  run (the local `surreal` binary) and exports `SURREAL_URL`, so every `tryConnect()`-based suite
  executes instead of skipping. The ORM live suites still boot their own isolated servers.
- **e2e CLI coverage.** `test/e2e/harness.ts` passes the same preload to the spawned CLI child
  (`bun run --preload … run <cli>`), so `commands.ts` / `cli/introspect.ts` / `driver/surreal.ts`
  contribute fragments keyed by pid; the runner merges them.
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
| `drivers/surrealdb/test/preload-server.ts` | shared ephemeral SurrealDB for live/parity |
| `coverage.config.json` | include roots, excludes, thresholds, per-file waivers (the floor) |

## Workflow

1. `bun run test:coverage` (or a focused run) → `bun run test:coverage:gaps <file>`.
2. Write tests that close the listed statements/arms/conditions.
3. `bun run test:coverage` → green.
4. `bun run test:coverage:update` to lock the new floor, then commit.

> The `coverage.config.json` waivers are a **temporary** floor, not a target: every waiver is a TODO
> to delete once the file is at 100%.
