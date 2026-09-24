/**
 * Mutation gate — run StrykerJS against the scoped pure compilers, then enforce the per-file score
 * ratchet in `mutation.config.json`.
 *
 *   bun run test:mutation                       # full scoped run + gate
 *   bun run test:mutation -- --mutate <glob>    # narrow the run
 *   bun run test:mutation -- --shards 8         # parallel Stryker processes (default: CPU count, ≤8)
 *   bun run test:mutation -- --update           # record current scores as the new floor
 *
 * WHY SHARDS: with `coverageAnalysis: "off"` every mutant is a **static** mutant, which Stryker runs
 * one-at-a-time (it can't hot-swap a static mutant), so a single Stryker process uses ~1 core. We
 * partition the file list across N independent Stryker processes (each with its own sandbox and JSON
 * report); the ratchet merges the reports. Stryker itself runs UNDER BUN so the child worker can
 * import the `.ts` runner plugin directly. See docs/TESTING.md.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const root = resolve(import.meta.dir, "../..");
const strykerBin = join(
  root,
  "node_modules/@stryker-mutator/core/bin/stryker.js",
);
const outDir = join(root, ".mutation");
const configPath = join(root, "stryker.config.json");

interface StrykerConfig {
  mutate: string[];
  [key: string]: unknown;
}

const argv = process.argv.slice(2);
const update = argv.includes("--update");
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const defaultShards = Math.max(1, Math.min(cpus().length, 8));
const shards = Math.max(
  1,
  Number(flag("--shards") ?? process.env.MUTATION_SHARDS ?? defaultShards),
);
const mutateArg = flag("--mutate");

const base = JSON.parse(await Bun.file(configPath).text()) as StrykerConfig;

/** Expand the configured mutate globs (e.g. `include/*.ts`) to concrete, existing files. */
function expand(patterns: string[]): string[] {
  const files = new Set<string>();
  for (const p of patterns) {
    if (p.includes("*")) {
      for (const f of new Glob(p).scanSync({ cwd: root })) files.add(f);
    } else files.add(p);
  }
  return [...files].sort();
}

const targets = expand(
  mutateArg
    ? mutateArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : base.mutate,
);

if (targets.length === 0) {
  console.error(
    "mutation: no files to mutate (check `mutate` in stryker.config.json).",
  );
  process.exit(1);
}

/** Round-robin the files (largest first) so each shard gets a comparable amount of work. */
function partition(files: string[], n: number): string[][] {
  const bySize = [...files].sort(
    (a, b) => statSync(join(root, b)).size - statSync(join(root, a)).size,
  );
  const buckets: string[][] = Array.from({ length: n }, () => []);
  bySize.forEach((f, i) => {
    buckets[i % n]?.push(f);
  });
  return buckets.filter((b) => b.length > 0);
}

const buckets = partition(targets, Math.min(shards, targets.length));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/** Write one shard's Stryker config: same base options, own mutate list, sandbox and report. */
function shardConfig(files: string[], i: number): string {
  const cfg = {
    ...base,
    mutate: files,
    concurrency: 1, // Stryker serializes static mutants anyway; extra workers would idle.
    tempDirName: `.stryker-tmp/shard-${i}`,
    reporters: ["json"],
    jsonReporter: { fileName: `.mutation/shard-${i}.json` },
    thresholds: { high: 100, low: 100, break: 0 },
  };
  const p = join(outDir, "configs", `shard-${i}.stryker.json`);
  mkdirSync(join(outDir, "configs"), { recursive: true });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  return p;
}

const procs = buckets.map((files, i) =>
  Bun.spawn(["bun", strykerBin, "run", shardConfig(files, i)], {
    cwd: root,
    stdout: Bun.file(join(outDir, `shard-${i}.log`)),
    stderr: Bun.file(join(outDir, `shard-${i}.err.log`)),
    env: { ...process.env, FORCE_COLOR: "0" },
  }),
);

const codes = await Promise.all(procs.map((p) => p.exited));

// A shard exits 1 on a low score (expected; the ratchet owns failure). Print its log so a real crash
// (or the Stryker summary) is visible, but never abort the other shards.
for (const [i, code] of codes.entries()) {
  if (code !== 0 && code !== 1) {
    console.error(`\n--- mutation shard ${i} exited ${code} ---`);
    console.error(await Bun.file(join(outDir, `shard-${i}.log`)).text());
    console.error(await Bun.file(join(outDir, `shard-${i}.err.log`)).text());
  }
}

const gate = Bun.spawnSync(
  ["bun", join(import.meta.dir, "ratchet.ts"), ...(update ? ["--update"] : [])],
  { cwd: root, stdout: "inherit", stderr: "inherit", env: process.env },
);
process.exit(gate.exitCode ?? 1);
