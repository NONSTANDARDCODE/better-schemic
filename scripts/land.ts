#!/usr/bin/env bun
/**
 * Land a green, backward-compatible PR branch onto `main`. This is the one-command merge step
 * (see AGENTS.md "Landing + releases"):
 *
 *   1. rebase <branch> onto origin/main (in its worktree) so the merge is a clean fast-forward
 *   2. fast-forward-merge it into the local main checkout (NOT pushed yet)
 *   3. GATE: typecheck + test the whole workspace — if red, undo the merge and abort (never ship red)
 *   4. push main, then remove the branch's worktree + delete the branch (local + remote)
 *
 * Landing ACCUMULATES — it does NOT deploy. Releases are cut explicitly on Manuel's confirmation
 * (`bun scripts/release.ts next`). Pass --deploy to land+ship in one step (the old CD behavior).
 *
 * Usage:
 *   bun scripts/land.ts <branch> [--remote origin] [--no-test] [--deploy]
 *
 *   --no-test    skip the gate (rare; e.g. a docs/scripts-only branch)
 *   --deploy     also cut+publish a release after landing (default: accumulate, don't deploy)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const branch = argv.find((a) => !a.startsWith("-"));
const flag = (n: string) => argv.includes(n);
const opt = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (!branch) {
  console.error(
    "usage: bun scripts/land.ts <branch> [--remote origin] [--no-test] [--no-deploy]",
  );
  process.exit(1);
}

const ROOT = join(import.meta.dir, "..");
const remote = opt("--remote", "origin");
const main = `${remote}/main`;
/**
 * The GATE runs the MERGED version of this script — the tree it tests (the package list, the
 * scripts it calls) comes from the merge, so the pre-merge copy would test packages that no longer
 * exist. After the merge we RE-EXEC ourselves with this flag set: the fresh copy on disk is the
 * merged one, and it only runs the gate + the push.
 */
const GATE_PHASE = process.env.BS_LAND_GATE === "1";

const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();
const gitIO = (...a: string[]) => execFileSync("git", a, { cwd: ROOT, stdio: "inherit" });
const run = (cmd: string, a: string[]) =>
  execFileSync(cmd, a, { cwd: ROOT, stdio: "inherit" });
const die = (msg: string): never => {
  console.error(`land: ${msg}`);
  process.exit(1);
};

// --- preflight: a clean main checkout ----------------------------------------------------------
// (the gate phase re-execs AFTER the merge, so the preflight runs only in the first phase)
if (!GATE_PHASE) {
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main")
    die("the main checkout must be on `main` (this script integrates into it).");
  // tracked changes block the merge; untracked scratch files are fine.
  if (
    git("status", "--porcelain")
      .split("\n")
      .some((l) => l && !l.startsWith("??"))
  )
    die("main has uncommitted tracked changes — commit or stash them first.");

  git("fetch", remote, "-q");

  // Bring local main up to origin/main (fast-forward only).
  const behind = Number(git("rev-list", "--count", `HEAD..${main}`));
  if (behind) {
    if (Number(git("rev-list", "--count", `${main}..HEAD`)))
      die(`local main has diverged from ${main} — reconcile manually.`);
    gitIO("merge", "--ff-only", main);
  }
}

// --- locate + rebase the branch --------------------------------------------------------------
function worktreeOf(b: string): string | null {
  for (const block of git("worktree", "list", "--porcelain").split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (block.match(/^branch refs\/heads\/(.+)$/m)?.[1] === b) return path ?? null;
  }
  return null;
}

const wt = worktreeOf(branch);
const isFF = (() => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", main, branch], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

if (!isFF && !GATE_PHASE) {
  if (!wt) die(`${branch} is behind ${main} and has no worktree to rebase in.`);
  console.log(`rebasing ${branch} onto ${main}...`);
  try {
    execFileSync("git", ["-C", wt, "fetch", remote, "-q"]);
    execFileSync("git", ["-C", wt, "rebase", main], { stdio: "inherit" });
  } catch {
    try {
      execFileSync("git", ["-C", wt, "rebase", "--abort"], { stdio: "ignore" });
    } catch {}
    die(`rebase of ${branch} onto ${main} conflicted — resolve it in ${wt}, then re-run.`);
  }
}

if (!GATE_PHASE) {
  const ahead = Number(git("rev-list", "--count", `HEAD..${branch}`));
  if (ahead === 0) die(`${branch} has no commits beyond main — nothing to land.`);

  // --- ff-merge into main locally (not pushed) -----------------------------------------------
  console.log(`merging ${branch} -> main (${ahead} commit(s))...`);
  gitIO("merge", "--ff-only", branch);
  // RE-EXEC for the gate: the copy on disk is now the MERGED script, so the gate tests the tree we
  // just merged (the pre-merge copy would test packages that no longer exist).
  console.log(
    `[debug] re-exec: ${process.execPath} ${join(ROOT, "scripts/land.ts")} ${process.argv.slice(2).join(" ")}`,
  );
  const reexec = Bun.spawnSync({
    cmd: [process.execPath, join(ROOT, "scripts/land.ts"), ...process.argv.slice(2)],
    env: { ...process.env, BS_LAND_GATE: "1" },
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log(`[debug] re-exec exit: ${reexec.exitCode}`);
  process.exit(reexec.exitCode ?? 1);
}

// --- gate: never ship red --------------------------------------------------------------------
if (!flag("--no-test")) {
  console.log("gate: install + build + typecheck + test workspace...");
  try {
    // INSTALL FIRST: the merged branch may add/bump deps (package.json + bun.lock), so refresh
    // node_modules before build/typecheck — else a new dependency reads as "cannot find module" and
    // the gate false-fails. `--frozen-lockfile` installs EXACTLY the committed lockfile (keeps the
    // surrealdb 2.0.3 pin, matches CI) and fails loud if package.json and bun.lock have drifted.
    run("bun", ["install", "--frozen-lockfile"]);
    // BUILD NEXT: the e2e suites load each driver from its compiled `lib/` (the CLI loader picks the
    // `import`/`default` export, not `bun`->src), so a stale lib would let the gate test old code. lib/
    // is gitignored, so this doesn't dirty the tree.
    run("bun", ["run", "--filter", "*", "build"]);
    run("bun", ["run", "--filter", "*", "typecheck"]);
    // Tests run SEQUENTIALLY per package: --filter '*' runs them in parallel, and CPU contention
    // (surreal's live-server e2e boots) starves the e2e beforeAll
    // hooks into timeouts — repeated false gate failures. Sequential costs wall-clock, never truth.
    for (const dir of ["packages/better-schemic", "packages/create-better-schemic"]) {
      run("bun", ["run", "--cwd", dir, "test"]);
    }
  } catch {
    console.error("gate FAILED — rolling main back, nothing pushed.");
    gitIO("reset", "--hard", main);
    process.exit(1);
  }
}

// --- push + clean up the worktree/branch -----------------------------------------------------
gitIO("push", remote, "main");
if (wt) {
  gitIO("worktree", "remove", "--force", wt);
  console.log(`removed worktree ${wt}`);
}
try {
  execFileSync("git", ["branch", "-D", branch], { cwd: ROOT, stdio: "ignore" });
} catch {}
try {
  execFileSync("git", ["push", remote, "--delete", branch], {
    cwd: ROOT,
    stdio: "ignore",
  });
} catch {}
console.log(`landed ${branch}.`);

// --- deploy (OPT-IN) -------------------------------------------------------------------------
// Default is ACCUMULATE: landing does NOT deploy. Releases are cut explicitly on Manuel's confirm
// (`bun scripts/release.ts next`). Pass --deploy to land+ship in one step (the old CD behavior).
if (!flag("--deploy")) {
  console.log("landed (accumulating, not deployed). Cut a release when ready to ship.");
  process.exit(0);
}
console.log("deploying (release next)...");
run("bun", ["scripts/release.ts", "next"]);
const newVer = JSON.parse(
  readFileSync(join(ROOT, "packages/better-schemic/package.json"), "utf8"),
).version as string;
gitIO(
  "add",
  ...["better-schemic", "create-better-schemic"].map(
    (p) => `packages/${p}/package.json`,
  ),
  "bun.lock",
);
gitIO("commit", "-q", "-m", `chore: release ${newVer} (${branch})`);
gitIO("push", remote, "main");
console.log(`deployed ${newVer}.`);
