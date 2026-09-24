/**
 * Mutation gate — run StrykerJS against the scoped pure compilers, then enforce the per-file score
 * ratchet in `mutation.config.json`.
 *
 *   bun run test:mutation                        # full scoped run + gate
 *   bun run test:mutation -- --mutate <glob>     # narrow the run
 *   bun run test:mutation -- --concurrency 8     # parallel test-runner workers (default: CPU count, ≤8)
 *   bun run test:mutation -- --update            # record current scores as the new floor
 *
 * WHY CONCURRENCY (not shards): Stryker's worker pool schedules every mutant **dynamically** across
 * `concurrency` test-runner workers, and each worker spawns its own `bun test` child. Static mutants
 * (`coverageAnalysis: "off"` makes every mutant static) are activated per-process by
 * `__STRYKER_ACTIVE_MUTANT__`, never by mutating shared files — so workers run in parallel safely,
 * and a finished worker immediately picks up the next mutant (no file-shard imbalance: the old
 * size-round-robin split left its heaviest shard ~1.9x the lightest). One process also copies the
 * sandbox, dry-runs and reports once. Stryker runs UNDER BUN so the worker can import the `.ts`
 * runner plugin directly. See docs/TESTING.md.
 */
import { mkdirSync, rmSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const strykerBin = join(
  root,
  "node_modules/@stryker-mutator/core/bin/stryker.js",
);
const outDir = join(root, ".mutation");
const configPath = join(root, "stryker.config.json");

const argv = process.argv.slice(2);
const update = argv.includes("--update");
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const defaultConcurrency = Math.max(1, Math.min(cpus().length, 8));
const concurrency = Math.max(
  1,
  Number(
    flag("--concurrency") ??
      process.env.MUTATION_CONCURRENCY ??
      defaultConcurrency,
  ),
);
const mutateArg = flag("--mutate");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const logPath = join(outDir, "stryker.log");
const errPath = join(outDir, "stryker.err.log");

const proc = Bun.spawn(
  [
    "bun",
    strykerBin,
    "run",
    configPath,
    "--concurrency",
    String(concurrency),
    // Quiet by design: Stryker writes its JSON report and `ratchet.ts` prints the table. (A direct
    // `stryker run` still gets the progress/clear-text reporters from `stryker.config.json`.)
    "--reporters",
    "json",
    ...(mutateArg ? ["--mutate", mutateArg] : []),
  ],
  {
    cwd: root,
    stdout: Bun.file(logPath),
    stderr: Bun.file(errPath),
    env: { ...process.env, FORCE_COLOR: "0" },
  },
);

const code = await proc.exited;

// A low score is not a crash (the ratchet owns failure). Anything else is: surface the log and stop
// before the ratchet can mistake a partial report for a green run.
if (code !== 0 && code !== 1) {
  console.error(`\n--- mutation run exited ${code} ---`);
  console.error(await Bun.file(logPath).text());
  console.error(await Bun.file(errPath).text());
  process.exit(code ?? 1);
}

const gate = Bun.spawnSync(
  ["bun", join(import.meta.dir, "ratchet.ts"), ...(update ? ["--update"] : [])],
  { cwd: root, stdout: "inherit", stderr: "inherit", env: process.env },
);
process.exit(gate.exitCode ?? 1);
