/**
 * Coverage gate — enforce the MC/DC-equivalent thresholds (statements, branches, functions, lines and
 * logical-condition truthiness) for every in-scope source file, with a per-file ratchet.
 *
 *   bun run scripts/coverage/check.ts            # enforce (fails on any file below its bar)
 *   bun run scripts/coverage/check.ts --update   # record the CURRENT numbers as the new floor
 *
 * `coverage.config.json` carries the include roots, excludes, global thresholds, a `critical` list
 * and per-file waivers (the ratchet floor). Two tiers:
 *
 *  - `critical` files — the core algorithms — must reach **100%** on every metric.
 *  - every other file only has to clear the global `thresholds` (a green run can never regress).
 *
 * `--update` rewrites the waivers to the current numbers, capped at the tier's floor, so a near-100%
 * non-critical file settles at the global threshold instead of being driven to 100%.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FileMetrics, fileMetrics, fmt, inScope, mergeFragments } from "./lib";

const root = resolve(import.meta.dir, "../..");
const configPath = join(root, "coverage.config.json");
const fragments = process.env.COVERAGE_DIR ?? join(root, ".coverage");
const update = process.argv.includes("--update");

interface Config {
  include: string[];
  exclude: string[];
  thresholds: Record<keyof FileMetrics | string, number>;
  /** Core algorithms pinned at 100% on every metric (the `critical` tier). */
  critical?: string[];
  waivers: Record<string, Partial<Record<keyof FileMetrics, number>>>;
  /** Global tolerance (percentage points) to absorb timing-dependent live-path flake. */
  tolerance?: number;
  /** Per-file tolerance overrides (percentage points). */
  tolerances?: Record<string, number>;
}

const config: Config = JSON.parse(readFileSync(configPath, "utf8"));
const metricKeys: (keyof FileMetrics)[] = [
  "statements",
  "branches",
  "functions",
  "lines",
  "conditions",
];
const critical = new Set(config.critical ?? []);

/** The floor for one file: the critical tier is 100 across the board, others the global bar. */
const requiredFor = (
  rel: string,
): Record<keyof FileMetrics | string, number> =>
  critical.has(rel)
    ? { statements: 100, branches: 100, functions: 100, lines: 100, conditions: 100 }
    : { ...config.thresholds, ...(config.waivers[rel] ?? {}) };

const roots = config.include.map((p) => join(root, p));
const map = mergeFragments(fragments);

interface Row {
  rel: string;
  m: FileMetrics;
}
const rows: Row[] = [];
for (const file of map.files()) {
  if (!inScope(file, roots)) continue;
  const rel = file.replace(`${root}/`, "");
  if (config.exclude.some((ex) => rel.includes(ex))) continue;
  let source: string | undefined;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    source = undefined;
  }
  rows.push({ rel, m: fileMetrics(map.fileCoverageFor(file) as never, source) });
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));

if (update) {
  const waivers: Config["waivers"] = {};
  for (const { rel, m } of rows) {
    // Critical files have a FIXED 100% floor — a recorded measurement is meaningless (and could look
    // like a lowered bar), so they get no waiver entry.
    if (critical.has(rel)) continue;
    const w: Partial<Record<keyof FileMetrics, number>> = {};
    for (const k of metricKeys) {
      const measured = Math.floor(m[k] * 100) / 100;
      // Cap at the global floor so a near-100% file settles there instead of ratcheting upward
      // toward the old drive-to-100% everywhere.
      w[k] = Math.min(measured, config.thresholds[k] ?? 100);
    }
    waivers[rel] = w;
  }
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, waivers }, null, 2)}\n`,
  );
  console.log(`updated ratchet floor for ${rows.length} files`);
  process.exit(0);
}

const failures: string[] = [];
for (const { rel, m } of rows) {
  const required = requiredFor(rel);
  const tol = config.tolerances?.[rel] ?? config.tolerance ?? 0;
  for (const k of metricKeys) {
    const need = required[k] ?? 100;
    if (m[k] + tol + 1e-9 < need) {
      failures.push(
        `${rel}: ${k} ${m[k].toFixed(2)}% < ${need}%${k === "conditions" && m.uncoveredConditions.length ? ` (uncovered ${m.uncoveredConditions.slice(0, 6).join(", ")}${m.uncoveredConditions.length > 6 ? "…" : ""})` : ""}`,
      );
    }
  }
}

console.log(
  `${"file".padEnd(56)} ${"%stmts".padStart(6)} ${"%brnch".padStart(6)} ${"%funcs".padStart(6)} ${"%lines".padStart(6)} ${"%cond".padStart(6)}`,
);
for (const { rel, m } of rows) {
  console.log(
    `${rel.padEnd(56)} ${fmt(m.statements)} ${fmt(m.branches)} ${fmt(m.functions)} ${fmt(m.lines)} ${fmt(m.conditions)}`,
  );
}

if (failures.length > 0) {
  console.error(`\ncoverage gate FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\ncoverage gate OK — ${rows.length} files at or above their floor`);
