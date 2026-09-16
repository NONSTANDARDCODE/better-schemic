#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Lockstep release for all @better-schemic packages.
 *
 *   bun scripts/release.ts <version|next> [--dry-run]
 *
 * `next` auto-bumps the trailing prerelease number from core's current version (0.1.0-alpha.10 ->
 * 0.1.0-alpha.11) — the continuous-deployment path (see scripts/land.ts / AGENTS.md).
 *
 * Encapsulates the publish gotchas we have hit (see memory: publish-pin-gotcha):
 *  - `bun publish` rewrites each dependent's `@better-schemic/core: workspace:*` using bun.lock, and a bare
 *    version bump does NOT refresh that recorded version. So we REBUILD the lockfile (rm + install).
 *  - We then PACK-VERIFY every dependent actually pins core@<version> BEFORE publishing anything (a
 *    wrong pin can't be fixed without burning the version).
 *  - core is published FIRST, since the dependents pin it.
 *
 * Auth: an npm Automation token in ~/.npmrc (the account is 2FA auth-and-writes, so a normal publish
 * token would prompt for an OTP and hang). `npm` itself is broken under WSL — we use `bun publish`.
 */
import { $ } from "bun";

const versionArg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!versionArg || versionArg.startsWith("-")) {
  console.error("usage: bun scripts/release.ts <version|next> [--dry-run]");
  process.exit(1);
}

const ROOT = join(import.meta.dir, "..");
// core first (dependents pin it); create-better-schemic last — it has NO @better-schemic deps (it scaffolds version
// strings), so it isn't pin-verified, just bumped + published lockstep so it scaffolds matching versions.
const ORDER = [
  "core",
  "cli",
  "surrealdb",
  "create-better-schemic",
  "better-schemic",
];
const DEPENDENTS = ["cli", "surrealdb"];
// driver packages live in drivers/, everything else in packages/
const DRIVERS = new Set(["surrealdb"]);
const pkgDir = (p: string) =>
  join(ROOT, DRIVERS.has(p) ? "drivers" : "packages", p);
// Display name: scoped packages vs the two unscoped aliases.
const displayName = (p: string) =>
  p === "better-schemic" || p === "create-better-schemic"
    ? p
    : `@better-schemic/${p}`;

// `next` -> bump the trailing .N of core's current version (0.1.0-alpha.10 -> 0.1.0-alpha.11).
async function resolveVersion(arg: string): Promise<string> {
  if (arg !== "next") return arg;
  const cur = JSON.parse(
    await Bun.file(join(pkgDir("core"), "package.json")).text(),
  ).version as string;
  const m = cur.match(/^(.*[-.])(\d+)$/);
  if (!m) {
    console.error(
      `cannot auto-bump "${cur}" — no trailing .N to increment; pass an explicit version.`,
    );
    process.exit(1);
  }
  return `${m[1]}${Number(m[2]) + 1}`;
}
const version = await resolveVersion(versionArg);
if (versionArg === "next") console.log(`auto-bumped -> ${version}`);

// --dry-run is a PREVIEW: mutating package.json + bun.lock would leave the tree bumped, so the
// next `next` run would skip the version we just verified (0.1.0-alpha.1 -> alpha.2). Snapshot the
// six files it touches and restore them before exiting.
const LOCK = join(ROOT, "bun.lock");
const snapshot = async () => {
  const files = new Map<string, string>();
  for (const p of ORDER) {
    const path = join(pkgDir(p), "package.json");
    files.set(path, await Bun.file(path).text());
  }
  files.set(LOCK, await Bun.file(LOCK).text());
  return files;
};
const restore = async (files: Map<string, string> | null) => {
  if (!files) return;
  for (const [path, text] of files) await Bun.write(path, text);
};
const before = dryRun ? await snapshot() : null;
const abort = async (msg: string): Promise<never> => {
  await restore(before);
  console.error(msg);
  process.exit(1);
};

// 1. set every package's version (targeted edit — don't reformat the file)
for (const p of ORDER) {
  const path = join(pkgDir(p), "package.json");
  const txt = await Bun.file(path).text();
  await Bun.write(
    path,
    txt.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`),
  );
  console.log(
    `${dryRun ? "would set" : "set"} ${displayName(p)} -> ${version}`,
  );
}

// 2. rebuild the lockfile so `workspace:*` rewrites to the NEW version (a bare bump won't refresh it)
console.log("rebuilding lockfile...");
await $`rm -f ${join(ROOT, "bun.lock")}`;
await $`bun install`.cwd(ROOT).quiet();

// 3. pack-verify each dependent pins core@<version> BEFORE publishing anything
for (const p of DEPENDENTS) {
  const tgz = `better-schemic-${p}-${version}.tgz`;
  await $`bun pm pack`.cwd(pkgDir(p)).quiet();
  const manifest = JSON.parse(
    await $`tar -xzf ${tgz} -O package/package.json`.cwd(pkgDir(p)).text(),
  );
  await $`rm -f ${tgz}`.cwd(pkgDir(p));
  const pin = manifest.dependencies?.["@better-schemic/core"];
  if (pin !== version) {
    await abort(
      `ABORT: @better-schemic/${p} pins core@${pin}, expected ${version} — lockfile not refreshed.`,
    );
  }
  console.log(`verified @better-schemic/${p} -> core@${pin}`);
}

if (dryRun) {
  await restore(before);
  console.log(
    `dry-run: ${version} verified (dependents pin core correctly); ` +
      "package.json + bun.lock restored, nothing published.",
  );
  process.exit(0);
}

// 4. publish core first, then the dependents (prepack builds each)
for (const p of ORDER) {
  console.log(`publishing ${displayName(p)}@${version}...`);
  await $`bun publish`.cwd(pkgDir(p));
}
console.log(
  `\nReleased @better-schemic/* ${version}. Verify: bun pm view @better-schemic/cli version`,
);
