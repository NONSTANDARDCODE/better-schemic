/**
 * Coverage runner — run the whole workspace test suite under the Istanbul/oxc instrumenter, then
 * report and gate. One `bun test` process from the repo root, so every source file is instrumented
 * exactly once and the e2e CLI children (spawned with the same preload) contribute their fragments.
 *
 *   bun run scripts/coverage/run.ts            # full run + report + gate
 *   bun run scripts/coverage/run.ts test/unit  # pass extra args through to `bun test`
 *
 * Env set for the child test process:
 *   COVERAGE=1              enable instrumentation (preload no-ops otherwise)
 *   COVERAGE_DIR            where `<pid>.json` fragments land (`.coverage/`)
 *   COVERAGE_INCLUDE        colon-separated absolute roots to instrument (driver + core src)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const dir = join(root, ".coverage");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const include = [
  join(root, "drivers/surrealdb/src"),
  join(root, "packages/core/src"),
].join(":");

const env = {
  ...process.env,
  COVERAGE: "1",
  COVERAGE_DIR: dir,
  COVERAGE_INCLUDE: include,
};

const tests = spawnSync("bun", ["test", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env,
});

spawnSync("bun", ["run", join(import.meta.dir, "report.ts")], {
  cwd: root,
  stdio: "inherit",
  env,
});
const check = spawnSync("bun", ["run", join(import.meta.dir, "check.ts")], {
  cwd: root,
  stdio: "inherit",
  env,
});

process.exit((tests.status ?? 1) || (check.status ?? 1));
