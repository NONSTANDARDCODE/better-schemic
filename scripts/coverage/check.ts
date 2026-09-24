/**
 * Coverage gate — enforce the MC/DC-equivalent thresholds (statements, branches, functions, lines and
 * logical-condition truthiness) for every in-scope source file, with a per-file ratchet.
 *
 *   bun run scripts/coverage/check.ts            # enforce (fails on any file below its bar)
 *   bun run scripts/coverage/check.ts --update   # record the CURRENT numbers as the new floor
 *
 * `coverage.config.json` carries the include roots, excludes, global thresholds and per-file waivers
 * (the ratchet floor). A file with no waiver must meet the global threshold. `--update` rewrites the
 * waivers to the current numbers, so a green run can never regress.
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
    const w: Partial<Record<keyof FileMetrics, number>> = {};
    for (const k of metricKeys) w[k] = Math.floor(m[k] * 100) / 100;
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
  const required = { ...config.thresholds, ...(config.waivers[rel] ?? {}) };
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
