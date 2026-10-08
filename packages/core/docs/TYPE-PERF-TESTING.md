# Type-completeness & instantiation-budget testing (bun check + tsgo budgets)

The shared standard for **type-level test suites** across the monorepo — core, cli, and every driver.
Two guarantees, both enforced in CI:

1. **Type completeness** — `assertType<Expected, Actual>()` fails to compile unless the two types
   agree in **both directions** (and `Actual` isn't `any`/`never`). A generic that silently drifts
   (a wrapper it stops unwrapping, a flag it drops) turns the package's `bun check` red instead
   of surfacing later as a mystery inference bug at a call site.
2. **Instantiation budgets** — each `.bench.ts` file is compiled in isolation by tsgo and its
   program-wide `Instantiations` count is checked against a pinned budget (±20% threshold). A change
   that makes a generic materially more expensive blows the budget and fails, guarding the
   autocomplete-latency ceiling that heavy generic machinery (Flags, `CreateShape`, `Row`/`FieldRef`,
   the connection typing) runs into.

There is **no runtime, no TypeScript compiler API and no node/tsx**: the compile-time asserts ride the
same `bun check` every package already runs (`typecheck`), and the budget runner is a Bun script
around tsgo (`--extendedDiagnostics`). The old `@ark/attest` + `typescript@6` + `tsx` pipeline was
retired with the tsup build — see `scripts/type-assert.ts`, `scripts/type-bench.ts`.

## Layout & runner

```
<package>/test/types/
  *.assert.ts   # compile-time assertions — checked by `bun check` as part of `typecheck` (never executed)
  *.bench.ts    # budgeted expressions — measured by scripts/type-bench.ts, one tsgo program per file
```

The `.assert.ts` / `.bench.ts` suffixes (not `.test.ts`) keep these files out of `bun test` — they are
not runtime tests. Asserts are enforced by the package's own typecheck; budgets run separately:

```bash
bun run scripts/type-bench.ts                  # enforce every budget
bun run scripts/type-bench.ts --update         # (re)baseline the current counts
bun run scripts/type-bench.ts packages/core    # one package only
```

Each package exposes the convenience script `test:types` (`bun run ../../scripts/type-bench.ts <pkg>`).
CI runs the root `test:types` as a **separate `type-bench` job** — deliberately OUT of the hot
`land.ts` gate, because compiling one tsgo program per bench file costs a couple of minutes.

## `*.assert.ts` — type assertions

```ts
import { describe, it } from "node:test";
import { assertType } from "../../../../scripts/type-assert";

describe("InnerOf", () => {
  it("unwraps ZodOptional", () => {
    assertType<z.ZodString, InnerOf<z.ZodOptional<z.ZodString>>>();
  });
});
```

`assertType` (in `scripts/type-assert.ts`) evaluates
`Actual extends Expected ? Expected extends Actual ? (not any) : never : never` in the **call's
argument tuple**: a mismatch makes the call require one argument and `bun check` reports
`Expected 1 arguments, but got 0` on that line. Presentation-only differences (a `readonly` modifier,
an intersection alias like `Row & { score: number }` written out longhand) compare equal — exactly as
they did under attest, whose compile-time gate was extends-only. The two extra guards reject the
silent-degradation shapes an extends-only check lets through: `actual = any` and `actual = never`.

The `describe`/`it` wrappers are kept for readability only; nothing executes them.

## `*.bench.ts` — instantiation budgets

```ts
import { bench } from "../../../../scripts/type-bench";

bench("InnerOf unwraps one wrapper level", () => {
  return {} as InnerOf<z.ZodOptional<z.ZodString>>;
});
```

`bench` marks an expression: its type work happens during **checking**, so the budget runner compiles
the file with tsgo and reads the program's `Instantiations` count. Budgets live in
`scripts/type-budgets.json` (keyed by bench-file path) — the runner never parses the source.

**One program per file, not per expression.** A file's count includes its import floor (zod's type
surface, ~4.5M for the driver benches), exactly like attest's per-expression counts did — watch the
**DELTA**, not the magnitude. Keep import-free benches in their own file (see core's
`authoring-pure.bench.ts`) for a clean low-count signal.

## Baselines

- **Measure first, then pin.** Run `bun run scripts/type-bench.ts --update` and commit the updated
  `scripts/type-budgets.json`.
- **The threshold is ±20%** — small refactors stay green; a real blow-up fails.
- **Counts are deterministic per tsgo version** (the pinned `@typescript/native-preview`), so they're
  stable across machines and CI. A compiler bump re-baselines them.
- **Re-baseline intentionally.** When a change's added cost is known and justified, update the budget
  in the same commit — never bump a budget to silence a regression you haven't understood.

## What to cover

Prioritise the generics most at risk of silent drift or instantiation blow-up: the `Flags` →
create/update optionality channel, derived `.create`/`.update` shapes, the query builder's `Row`/
`FieldRef` inference and graph-traversal recursion, and the typed `connect(name, args)` resolution.
List the utility, assert its exact output, and pin a budget — so a future refactor can't quietly break
inference or 10× its cost.
