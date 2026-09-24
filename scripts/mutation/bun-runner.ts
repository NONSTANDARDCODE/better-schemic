/**
 * A StrykerJS `TestRunner` plugin that delegates to **Bun's own** test runner.
 *
 * Stryker ships runners for Jest/Vitest/Mocha/… but none for Bun, so this plugin implements the
 * public `TestRunner` contract (`dryRun`/`mutantRun`) by spawning
 * `bun --config <server-less bunfig> test <files>` inside the mutant sandbox (the child worker's cwd
 * IS the sandbox root — see Stryker's `child-process-proxy-worker`). A nonzero exit means at least
 * one test failed, i.e. the mutant was **killed**; a zero exit means it **survived**; a hard kill past
 * the timeout is a **timeout**.
 *
 * `coverageAnalysis` is `off` (see `stryker.config.json`): this runner reports a single synthetic
 * test per run rather than per-test coverage, which is exactly what `toMutantRunResult` needs and
 * keeps the integration small and robust.
 *
 * Which tests to run per mutant is read from `mutation.config.json` at the sandbox root
 * (`testFilesByFile[<mutated file>]`, matched by repo-relative path or suffix, else `testFiles`).
 * See `drivers/surrealdb/docs/TESTING.md`.
 *
 * Run Stryker **under Bun** (`bun node_modules/@stryker-mutator/core/bin/stryker.js run`) so the
 * worker subprocess can import this `.ts` module directly.
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declareFactoryPlugin, PluginKind } from "@stryker-mutator/api/plugin";
import {
  type DryRunOptions,
  type DryRunResult,
  DryRunStatus,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
  type TestRunner,
  type TestRunnerCapabilities,
  TestStatus,
  toMutantRunResult,
} from "@stryker-mutator/api/test-runner";

/** The per-connection knobs the runner reads from `mutation.config.json` (at the sandbox root). */
interface MutationConfig {
  /** Bun config the child tests run with — a *server-less* bunfig (no live preload). */
  bunfig?: string;
  /** Default test targets (paths/globs `bun test` accepts) when no per-file mapping matches. */
  testFiles?: string[];
  /** Per-mutated-source test targets, keyed by repo-relative path (matched by suffix). */
  testFilesByFile?: Record<string, string[]>;
}

const CONFIG_FILE = "mutation.config.json";
const DEFAULT_BUNFIG = "scripts/mutation/bunfig.mutation.toml";
const DEFAULT_TEST_FILES = [
  "drivers/surrealdb/test/unit",
  "packages/core/test/unit",
];

/** One `bun test` process outcome. */
interface ExecResult {
  /** Exit code (`null` when killed by a signal). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Whether our own timeout SIGKILLed the child. */
  timedOut: boolean;
  /** A spawn-level failure (`bun` missing, …) — distinct from a failing test run. */
  spawnError?: string;
}

/** Read `mutation.config.json` from the sandbox root; empty defaults when absent. */
function loadConfig(): MutationConfig {
  try {
    return JSON.parse(
      readFileSync(join(process.cwd(), CONFIG_FILE), "utf8"),
    ) as MutationConfig;
  } catch {
    return {};
  }
}

/** A short, human-readable tail of a failed run (what Stryker surfaces as the failure message). */
function outputTail(r: ExecResult): string {
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-15).join("\n") || "(no output)";
}

export class BunTestRunner implements TestRunner {
  private readonly config = loadConfig();

  capabilities(): TestRunnerCapabilities {
    // Process-per-run: a fresh `bun test` sees the mutated source, so the environment can reload.
    return { reloadEnvironment: true };
  }

  async dryRun(options: DryRunOptions): Promise<DryRunResult> {
    const files =
      options.testFiles && options.testFiles.length > 0
        ? options.testFiles
        : (this.config.testFiles ?? DEFAULT_TEST_FILES);
    const r = await this.exec(files, options.timeout, false);
    if (r.timedOut)
      return {
        status: DryRunStatus.Timeout,
        reason: reason(r, options.timeout),
      };
    if (r.spawnError)
      return { status: DryRunStatus.Error, errorMessage: r.spawnError };
    if (r.code !== 0)
      return { status: DryRunStatus.Error, errorMessage: outputTail(r) };
    return {
      status: DryRunStatus.Complete,
      tests: [successTest("bun test")],
    };
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const files = this.filesForMutant(options);
    const r = await this.exec(
      files,
      options.timeout,
      !options.disableBail,
      options.activeMutant.id,
    );

    let dry: DryRunResult;
    if (r.timedOut) {
      dry = {
        status: DryRunStatus.Timeout,
        reason: reason(r, options.timeout),
      };
    } else if (r.spawnError) {
      dry = { status: DryRunStatus.Error, errorMessage: r.spawnError };
    } else if (r.code === 0) {
      dry = { status: DryRunStatus.Complete, tests: [successTest("bun test")] };
    } else {
      dry = {
        status: DryRunStatus.Complete,
        tests: [failedTest(options.activeMutant.fileName, outputTail(r))],
      };
    }
    // `reportAllKillers: false` — one synthetic test, so a single id is enough.
    return toMutantRunResult(dry, false);
  }

  /** The test targets for one mutant: an explicit `testFilter`, else the per-file map, else defaults. */
  private filesForMutant(options: MutantRunOptions): string[] {
    if (options.testFilter && options.testFilter.length > 0)
      return options.testFilter;
    const mapped = this.lookupTestFiles(options.activeMutant.fileName);
    const files =
      mapped && mapped.length > 0
        ? mapped
        : (this.config.testFiles ?? DEFAULT_TEST_FILES);
    if (process.env.MUTATION_DEBUG === "1")
      appendFileSync(
        process.env.MUTATION_DEBUG_FILE ?? "/tmp/mutation-debug.log",
        `[mutation] ${options.activeMutant.fileName} -> ${files.length} file(s)${mapped ? " (mapped)" : " (default)"}\n`,
      );
    return files;
  }

  /**
   * Resolve the configured test targets for a mutated source. Stryker hands the ORIGINAL (often
   * absolute) `fileName`, while the config keys are repo-relative — so match exactly first, then by
   * path suffix (`…/drivers/surrealdb/src/x.ts` ends with `drivers/surrealdb/src/x.ts`).
   */
  private lookupTestFiles(fileName: string): string[] | undefined {
    const byFile = this.config.testFilesByFile ?? {};
    const normalized = fileName.split("\\").join("/");
    if (byFile[normalized]) return byFile[normalized];
    for (const [key, files] of Object.entries(byFile))
      if (normalized === key || normalized.endsWith(`/${key}`)) return files;
    return undefined;
  }

  /** Spawn `bun test` with the server-less config, honoring a hard timeout. */
  private exec(
    files: string[],
    timeoutMs: number,
    bail: boolean,
    activeMutant?: string,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      const bunfig = this.config.bunfig ?? DEFAULT_BUNFIG;
      const args = [
        `--config=${bunfig}`,
        "test",
        ...(bail ? ["--bail=1"] : []),
        ...files,
      ];
      const child = spawn("bun", args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          COVERAGE: "0", // never instrument mutants (would also load the coverage preload)
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          // Pin the property tests so a mutant's kill/ survival is DETERMINISTIC across runs (a random
          // fast-check seed would make the mutation score wobble against a zero-tolerance ratchet).
          PBT_SEED: process.env.PBT_SEED ?? "20240101",
          PBT_RUNS: process.env.PBT_RUNS ?? "50",
          // Runtime mutants are activated by the instrumented code reading this env var (the
          // instrumenter's `ACTIVE_MUTANT_ENV_VARIABLE`); an empty string means "no active mutant".
          __STRYKER_ACTIVE_MUTANT__: activeMutant ?? "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (r: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
        },
        Math.max(1, timeoutMs),
      );

      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (e: Error) =>
        finish({ code: null, stdout, stderr, timedOut, spawnError: e.message }),
      );
      child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    });
  }
}

function reason(r: ExecResult, timeoutMs: number): string {
  return `${r.timedOut ? "timed out after " : "exited "}${timeoutMs}ms\n${outputTail(r)}`;
}

function successTest(name: string): TestResult {
  return { id: name, name, status: TestStatus.Success, timeSpentMs: 0 };
}

function failedTest(name: string, failureMessage: string): TestResult {
  return {
    id: name,
    name,
    status: TestStatus.Failed,
    timeSpentMs: 0,
    failureMessage,
  };
}

/** Register the plugin under the name `bun` (`testRunner: "bun"`). */
export const strykerPlugins = [
  declareFactoryPlugin(PluginKind.TestRunner, "bun", () => new BunTestRunner()),
];
