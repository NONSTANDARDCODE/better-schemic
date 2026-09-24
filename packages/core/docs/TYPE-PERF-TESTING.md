# Type-completeness & instantiation-budget testing (@ark/attest)

The shared standard for **type-level test suites** across the monorepo — core, cli, and every driver.
Two guarantees, both enforced in CI:

1. **Type completeness** — `attest<Expected, Actual>()` asserts a type utility produces *exactly* the
   type it should. A generic that silently drifts (a wrapper it stops unwrapping, a flag it drops)
   turns a suite red instead of surfacing later as a mystery inference bug at a call site.
2. **Instantiation budgets** — `bench(...).types([N, "instantiations"])` caps how many type
   instantiations a hot generic costs. A change that makes inference materially more expensive blows
   the budget and fails, guarding the `tsc` instantiation-depth / autocomplete-latency ceiling that
   heavy generic machinery (Flags, `CreateShape`, `Row`/`FieldRef`, the connection typing) runs into.

Worked reference: **`packages/core/test/types/`** (`authoring-types.assert.ts` + `authoring-types.bench.ts`).

## The one rule that matters: run under node, NOT bun

attest measures instantiations and checks assertions by driving a TypeScript program and locating the
running source file **via the node call stack**. Under bun that frame reads as `native`, so attest
throws:

```
@ark/attest: TypeScript was unable to resolve expected file at native
    at getSourceFileOrThrow (.../cache/ts.js)
    at getContributedInstantiations (.../bench/type.js)
```

So type-suites run in a **separate node process with TS via `tsx`**, never `bun test`. The shared
runner `scripts/type-perf.ts` does this for you — do not run these files with `bun`.

## Layout & runner

```
<package>/test/types/
  _setup.ts             # shared, memoized attest setup — imported by every *.assert.ts
  tsconfig.attest.json  # narrows attest's program to test/types/ + src/
  *.assert.ts           # attest type assertions, run via node's test runner
  *.bench.ts            # instantiation budgets, batched into one process (exits non-zero if over budget)
```

The `.assert.ts` suffix (not `.test.ts`) is deliberate: it keeps these files OUT of `bun test` — which
would run them under bun and hit the `native` error — while `node --test` runs them fine. `.bench.ts`
is likewise unmatched by bun. So you never have to scope your package's bun `test` script around them.

Each package wires one script (mirrors `packages/core`):

```jsonc
// package.json
"scripts": { "test:types": "bun run ../../scripts/type-perf.ts <group>/<name>" }
```

`bun run scripts/type-perf.ts` (no args) runs **every** workspace package that has a `test/types/`.
CI runs it as a **separate `type-perf` job** — deliberately OUT of the hot `land.ts` gate, because
attest's own TS program is slower and needs node/tsx.

### One TypeScript program per package

Building attest's program and type-checking the project costs ~50s, and the cost is **per process**.
Running one process per file made CI take ~10 minutes for 11 files, so the runner consolidates:

- **Asserts:** one `node --test` per package with **`--experimental-test-isolation=none`** (node ≥ 22.8;
  CI pins node 24). Every `.assert.ts` shares one process, one `TsServer`, one assertion cache.
  `test/types/_setup.ts` memoizes `setup()` so the shared program is built exactly once even though
  each file registers its own `before`/`after` hooks.
- **Benches:** `scripts/type-perf-bench.mts` imports every `.bench.ts` sequentially in one process,
  reusing the same program and isolated counting env.
- **Narrow program:** `test/types/tsconfig.attest.json` includes only `test/types/` + `src/`, so the
  project-wide type-check attest runs during `setup()` skips the package's other suites (live/e2e/
  unit). The driver's setup drops from ~100s to ~33s locally; instantiation counts are unaffected
  (they only use the config's `compilerOptions`).

The runner also passes **`--conditions=bun`**, so `@better-schemic/core/*` (and any workspace package)
resolves from **`src/`** at runtime — exactly like the local bun run and attest's tsconfig
(`customConditions: ["bun"]`). **No `lib/` build is needed before running the suites**, locally or in
CI, and a stale `lib/` can't skew a run. (attest's *type* pass reads `src` either way, so instantiation
counts stay src-based.)

## Adding a suite to a driver

1. `bun add -d @ark/attest tsx` in your package (pin the same attest version core uses — instantiation
   counts are tied to it and to the `typescript` version).
2. Add the `test:types` script above.
3. Create `test/types/`, copy `tsconfig.attest.json` + `_setup.ts` (below), then copy the two suite
   file shapes.

> **Toolchain note.** attest drives the classic JS compiler API, so every package pins
> `typescript@5.9.3` — do NOT bump it without re-baselining the budgets (`ATTEST_updateSnapshots=1`).
> The native TypeScript 7 (Go) compiler is only used for `typecheck` (`tsgo --noEmit`, via
> `@typescript/native-preview`) and never feeds attest; `typecheck:legacy` keeps the classic `tsc`
> pass available for parity debugging.

### `*.assert.ts` — type assertions

```jsonc
// test/types/tsconfig.attest.json — copy once per package
{
  "extends": "../../tsconfig.json",
  "include": ["./**/*.ts", "../../src/**/*.ts"]
}
```

```ts
// test/types/_setup.ts — copy once per package (memoized: one TS program per process)
import { fileURLToPath } from "node:url";
import { setup, teardown } from "@ark/attest";

const TSCONFIG = fileURLToPath(new URL("./tsconfig.attest.json", import.meta.url));

let initialized = false;
export function setupTypes(): void {
  if (initialized) return;
  initialized = true;
  setup({ tsconfig: TSCONFIG });
}
export function teardownTypes(): void {
  teardown();
}
```

```ts
// test/types/*.assert.ts
import { after, before, describe, it } from "node:test";
import { attest } from "@ark/attest";
import type { InnerOf } from "../../src/authoring";
import type * as z from "zod";
import { setupTypes, teardownTypes } from "./_setup";

before(setupTypes);
after(teardownTypes);

describe("InnerOf", () => {
  it("unwraps ZodOptional", () => {
    attest<z.ZodString, InnerOf<z.ZodOptional<z.ZodString>>>();
  });
});
```

`attest<Expected, Actual>()` fails to **compile** if `Actual` isn't exactly `Expected`, and attest
re-checks it at runtime.

### `*.bench.ts` — instantiation budgets

```ts
import { bench } from "@ark/attest";
import type { InnerOf } from "../../src/authoring";
import type * as z from "zod";

bench("InnerOf unwraps one wrapper level", () => {
  return {} as InnerOf<z.ZodOptional<z.ZodString>>;
}).types([76415, "instantiations"]);
```

## Baselines

- **Measure first, then pin.** Set the budget to `[0, "instantiations"]`, run once, and copy the
  reported count. Counts are **deterministic per TypeScript version**, so they're stable across
  machines and CI.
- **The default threshold is ±20%** — small refactors stay green; a real blow-up fails.
- **Watch the DELTA, not the magnitude.** Any zod-coupled generic carries the imported type surface
  (~76k instantiations of floor cost), so absolute numbers look large; the budget's job is to catch a
  *regression* against the pinned baseline. Include one import-free generic too (see core's tuple bench)
  for a clean low-count signal.
- **Re-baseline intentionally.** When a change's added cost is known and justified, update the number
  in the same commit (run with `ATTEST_updateSnapshots=1` to rewrite, or edit by hand) — never bump a
  budget to silence a regression you haven't understood.

## What to cover

Prioritise the generics most at risk of silent drift or instantiation blow-up: the `Flags` →
create/update optionality channel, derived `.create`/`.update` shapes, the query builder's `Row`/
`FieldRef` inference and graph-traversal recursion, and the typed `connect(name, args)` resolution.
List the utility, assert its exact output, and pin a budget — so a future refactor can't quietly break
inference or 10× its cost.
