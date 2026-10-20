#!/usr/bin/env bun
import { join } from "node:path";
/**
 * Lockstep release for the better-schemic packages.
 *
 *   bun scripts/release.ts <version|next> [--dry-run]
 *
 * `next` auto-bumps the trailing prerelease number from the current version (0.1.0-alpha.10 ->
 * 0.1.0-alpha.11), skipping versions already published to npm — the continuous-deployment path
 * (see scripts/land.ts / AGENTS.md).
 *
 * TWO published packages:
 *  - `better-schemic` — the runtime (authoring surface + engine + CLI);
 *  - `create-better-schemic` — the scaffolder. It has NO dependency on `better-schemic` (it only
 *    scaffolds the version string), so it is published last and bumped in lockstep — a fresh project
 *    always gets a matching pair.
 *
 * Encapsulates the publish gotchas we have hit (see memory: publish-pin-gotcha):
 *  - `next` skips versions already on npm — the local manifests can lag the registry (a release cut
 *    from another checkout), and npm refuses to republish a version.
 *  - `bun publish` rewrites `workspace:*` deps using bun.lock, and a bare version bump does NOT
 *    refresh that recorded version. So we REBUILD the lockfile (rm + install).
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
// The runtime package first; the scaffolder last — it has NO dependency on `better-schemic` (it only
// scaffolds the version string), so it is bumped in lockstep and published last: a fresh project always
// gets a matching pair.
const ORDER = ["better-schemic", "create-better-schemic"];
const pkgDir = (p: string) => join(ROOT, "packages", p);
const displayName = (p: string) => p;

// `next` -> bump the trailing .N of the current version (0.1.0-alpha.10 -> 0.1.0-alpha.11),
// skipping any candidate already published to npm (local manifests can lag the registry, and a
// republish is impossible).
function bump(v: string): string {
  const m = v.match(/^(.*[-.])(\d+)$/);
  if (!m) {
    console.error(
      `cannot auto-bump "${v}" — no trailing .N to increment; pass an explicit version.`,
    );
    process.exit(1);
  }
  return `${m[1]}${Number(m[2]) + 1}`;
}

async function publishedVersions(name: string): Promise<Set<string>> {
  const res = await fetch(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
  );
  if (!res.ok) {
    console.error(
      `cannot list ${name} on npm (HTTP ${res.status}) — refusing to guess a version; pass one explicitly.`,
    );
    process.exit(1);
  }
  const body = (await res.json()) as { versions?: Record<string, unknown> };
  return new Set(Object.keys(body.versions ?? {}));
}

async function resolveVersion(arg: string): Promise<string> {
  if (arg !== "next") return arg;
  const cur = JSON.parse(
    await Bun.file(join(pkgDir("better-schemic"), "package.json")).text(),
  ).version as string;
  const published = await publishedVersions("better-schemic");
  let next = bump(cur);
  while (published.has(next)) {
    console.log(`skipping ${next} — already published on npm`);
    next = bump(next);
  }
  return next;
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

// 3. pack-verify both packages carry the new version BEFORE publishing anything (a wrong version
// can't be fixed without burning the version).
for (const p of ORDER) {
  // `bun pm pack` names the tarball after the package: `<name>-<version>.tgz`.
  const tgz = `${p}-${version}.tgz`;
  await $`bun pm pack`.cwd(pkgDir(p)).quiet();
  const manifest = JSON.parse(
    await $`tar -xzf ${tgz} -O package/package.json`.cwd(pkgDir(p)).text(),
  );
  await $`rm -f ${tgz}`.cwd(pkgDir(p));
  if (manifest.version !== version) {
    await abort(
      `ABORT: ${p} packs version ${manifest.version}, expected ${version}.`,
    );
  }
  console.log(`verified ${p}@${manifest.version}`);
}

if (dryRun) {
  await restore(before);
  console.log(
    `dry-run: ${version} verified; package.json + bun.lock restored, nothing published.`,
  );
  process.exit(0);
}

// 4. publish the runtime first, then the scaffolder (prepack builds each)
for (const p of ORDER) {
  console.log(`publishing ${displayName(p)}@${version}...`);
  await $`bun publish`.cwd(pkgDir(p));
}
console.log(
  `\nReleased better-schemic + create-better-schemic ${version}. Verify: bun pm view better-schemic version`,
);
