// Shared TYPE-PERF runner — runs a package's `test/types/` suite under node/tsx (NOT bun).
//
// Why node, not bun: @ark/attest measures type instantiations + checks type assertions by driving a
// TypeScript program and locating the running source file via the node call stack. Under bun that
// frame reads as `native`, so attest throws "TypeScript was unable to resolve expected file at native".
// Running the suite in a separate node process (TS via tsx) sidesteps it entirely. See
// packages/core/docs/TYPE-PERF-TESTING.md.
//
// One TypeScript program per PACKAGE, not per file: `--experimental-test-isolation=none` runs every
// `.assert.ts` in a single process (attest's TsServer + assertion cache are per-process), and the
// bench files are imported sequentially by scripts/type-perf-bench.ts in another. Building attest's
// program costs ~50s, so per-file processes used to dominate CI (11 assert files = ~10min).
// `--experimental-test-isolation=none` needs node >= 22.8 (CI pins node 24).
//
// `--conditions=bun` resolves workspace packages (`@better-schemic/core`) from `src/`, exactly like
// the local bun run and attest's own tsconfig (`customConditions: ["bun"]`) — so no `lib/` build is
// needed before the suites run.
//
// Usage: bun run scripts/type-perf.ts [packageDir...]   (default: every workspace with a test/types/)
//   - test/types/*.assert.ts → attest type assertions, via node's test runner (one process/package)
//   - test/types/*.bench.ts  → instantiation budgets, batched into one process/package
//
// NOTE the `.assert.ts` (not `.test.ts`) suffix: it keeps these files OUT of `bun test` (which would
// run them under bun and hit the `native` error), while `node --test` runs them fine when passed
// explicitly. `.bench.ts` is likewise unmatched by bun.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BENCH_RUNNER = join(ROOT, "scripts", "type-perf-bench.mts");

/** Workspace package dirs that actually have a type-suite. */
function packagesWithTypeSuites(): string[] {
  const out: string[] = [];
  for (const group of ["packages", "drivers"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (existsSync(join(base, name, "test/types")))
        out.push(join(group, name));
    }
  }
  return out;
}

function typeFiles(pkgDir: string, suffix: string): string[] {
  const dir = join(ROOT, pkgDir, "test/types");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort()
    .map((f) => join("test/types", f));
}

function run(cwd: string, args: string[]): boolean {
  // `--max-old-space-size`: one attest program needs well over node's default ~2 GB heap.
  // `--conditions=bun`: workspace packages resolve to `src/` (no build step — see header).
  const r = spawnSync(
    "node",
    [
      "--max-old-space-size=6144",
      "--import",
      "tsx",
      "--conditions",
      "bun",
      ...args,
    ],
    {
      cwd: join(ROOT, cwd),
      stdio: "inherit",
    },
  );
  return r.status === 0;
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : packagesWithTypeSuites();

if (!targets.length) {
  console.log("type-perf: no test/types/ suites found — nothing to check.");
  process.exit(0);
}

let failed = false;
for (const pkg of targets) {
  const asserts = typeFiles(pkg, ".assert.ts");
  const benches = typeFiles(pkg, ".bench.ts");
  if (!asserts.length && !benches.length) {
    console.log(
      `type-perf: ${pkg} has a test/types/ dir but no *.assert.ts / *.bench.ts — skipping.`,
    );
    continue;
  }
  console.log(
    `\n=== type-perf: ${pkg} (${asserts.length} assertion file(s), ${benches.length} bench file(s)) ===`,
  );
  const startedAt = Date.now();
  // ONE process for every `.assert.ts`: attest's setup() builds a full TypeScript program (~50s),
  // and per-file processes would pay that per file. `test/types/_setup.ts` memoizes setup() so the
  // files share the program even though each registers its own before/after hooks.
  if (
    asserts.length &&
    !run(pkg, ["--test", "--experimental-test-isolation=none", ...asserts])
  )
    failed = true;
  // ONE process for every `.bench.ts` (see scripts/type-perf-bench.ts), same program-reuse reason.
  if (benches.length && !run(pkg, [BENCH_RUNNER, ...benches])) failed = true;
  console.log(
    `type-perf: ${pkg} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

if (failed) {
  console.error(
    "\ntype-perf: FAILED (type assertion mismatch or instantiation budget exceeded).",
  );
  process.exit(1);
}
console.log("\ntype-perf: all suites passed.");
