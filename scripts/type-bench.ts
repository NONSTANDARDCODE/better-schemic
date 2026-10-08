#!/usr/bin/env bun
/**
 * Type-instantiation BUDGETS for the `.bench.ts` suites — the Bun/tsgo replacement for
 * `@ark/attest`'s `bench().types()` (no TypeScript compiler API, no node/tsx).
 *
 * Each `.bench.ts` file is compiled in ISOLATION by tsgo (`--extendedDiagnostics`) and its
 * program-wide `Instantiations` count is checked against `scripts/type-budgets.json` with the same
 * ±20% regression threshold attest used. The budget guards a **blow-up** in the file's generic
 * machinery; a program count includes the file's import floor (zod's type surface), exactly like
 * attest's per-expression counts did — watch the DELTA.
 *
 *   bun run scripts/type-bench.ts                  # enforce every budget
 *   bun run scripts/type-bench.ts --update         # (re)baseline the current counts
 *   bun run scripts/type-bench.ts packages/core    # enforce one package's benches
 */
import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { resolveTsgo } from "./tsgo";

export function bench(_name: string, fn: () => unknown): void {
  // The cost happens during TYPE CHECKING — the closure body is checked (and its types
  // instantiated) wherever the file is compiled. Runtime is a no-op: bench files are never executed.
  void fn;
}

const root = resolve(import.meta.dir, "..");
const budgetsPath = join(import.meta.dir, "type-budgets.json");
const TOLERANCE = 0.2;

interface Budgets {
  [benchFile: string]: number;
}

/** The bench files under one package dir (`<package>/test/types/*.bench.ts`). */
function benchFilesIn(packageDir: string): string[] {
  const dir = join(root, packageDir, "test/types");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".bench.ts"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function discover(packageFilter?: string): string[] {
  const packages = ["packages/core", "packages/cli", "drivers/surrealdb"];
  const selected = packageFilter
    ? packages.filter(
        (p) => p === packageFilter || p.endsWith(`/${packageFilter}`),
      )
    : packages;
  return selected.flatMap((p) => benchFilesIn(p));
}

/** Compile one bench file in isolation and return its program-wide Instantiations count. */
async function measure(file: string): Promise<number> {
  const packageDir = resolve(file, "../../.."); // <package>/test/types/<file> -> <package>
  const configPath = join(file, "..", ".tsconfig.bench.json");
  const config = {
    extends: "../../tsconfig.json",
    include: [`.${file.slice(file.lastIndexOf("/"))}`],
  };
  await Bun.write(configPath, JSON.stringify(config, null, 2));
  try {
    const tsgo = await resolveTsgo(packageDir);
    const proc = Bun.spawnSync(
      [tsgo, "--noEmit", "--extendedDiagnostics", "-p", configPath],
      {
        cwd: packageDir,
        stdio: ["inherit", "pipe", "inherit"],
      },
    );
    const stdout = proc.stdout.toString();
    if (proc.exitCode !== 0) {
      throw new Error(`tsgo failed on ${relative(root, file)}\n${stdout}`);
    }
    const match = stdout.match(/Instantiations:\s+(\d+)/);
    if (!match)
      throw new Error(
        `no Instantiations count in tsgo output for ${relative(root, file)}`,
      );
    return Number(match[1]);
  } finally {
    await rm(configPath, { force: true });
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const packageFilter = argv.find((a) => !a.startsWith("--"));

  const files = discover(packageFilter);
  if (files.length === 0) {
    console.error(
      `type-bench: no .bench.ts files found${packageFilter ? ` in ${packageFilter}` : ""}`,
    );
    process.exit(1);
  }

  const budgets: Budgets = update
    ? {}
    : ((await Bun.file(budgetsPath)
        .json()
        .catch(() => ({}))) as Budgets);

  let failed = false;
  for (const file of files) {
    const key = relative(root, file);
    const measured = await measure(file);
    if (update) {
      budgets[key] = measured;
      console.log(`[bench] ${key}: ${measured} instantiations (baseline)`);
      continue;
    }
    const budget = budgets[key];
    if (budget === undefined) {
      console.error(
        `[bench] ${key}: no budget — run \`bun run scripts/type-bench.ts --update\``,
      );
      failed = true;
      continue;
    }
    const ratio = measured / budget;
    const ok = Math.abs(ratio - 1) <= TOLERANCE;
    if (!ok) failed = true;
    console.log(
      `[bench] ${key}: ${measured} / ${budget} instantiations (${ratio >= 1 ? "+" : ""}${(
        (ratio - 1) * 100
      ).toFixed(1)}%)${ok ? "" : "  ✗ over budget"}`,
    );
  }

  if (update) {
    const sorted = Object.fromEntries(
      Object.entries(budgets).sort(([a], [b]) => a.localeCompare(b)),
    );
    await Bun.write(budgetsPath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`type-bench: wrote ${relative(root, budgetsPath)}`);
  } else if (failed) {
    process.exit(1);
  }
}

// `.bench.ts` files import `bench` from this module — never run the budgets on a bare import.
if (import.meta.main) await main();
