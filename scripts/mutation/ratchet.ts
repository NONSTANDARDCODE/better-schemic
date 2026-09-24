/**
 * Mutation-score ratchet — the mutation analogue of `scripts/coverage/check.ts`.
 *
 * Read Stryker's JSON report (`.mutation/mutation.json`), compute each file's mutation score, and
 * fail when any file drops below the floor recorded in `mutation.config.json` (`floors`). A green run
 * therefore can never regress, exactly like the coverage ratchet.
 *
 *   bun run scripts/mutation/ratchet.ts            # enforce
 *   bun run scripts/mutation/ratchet.ts --update   # record the CURRENT scores as the new floor
 *
 * Score = (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage + RuntimeError), matching
 * Stryker's own metric. `CompileError` (unparseable mutant) and `Ignored` are excluded.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const reportDir = join(root, ".mutation");
const configPath = join(root, "mutation.config.json");
const update = process.argv.includes("--update");

interface Counts {
  Killed: number;
  Timeout: number;
  Survived: number;
  NoCoverage: number;
  RuntimeError: number;
  CompileError: number;
  Ignored: number;
}

interface MutantReport {
  status?: string;
}

interface MutationReport {
  files?: Record<string, { mutants?: MutantReport[] }>;
}

interface Config {
  tolerance?: number;
  tolerances?: Record<string, number>;
  floors?: Record<string, number>;
}

const emptyCounts = (): Counts => ({
  Killed: 0,
  Timeout: 0,
  Survived: 0,
  NoCoverage: 0,
  RuntimeError: 0,
  CompileError: 0,
  Ignored: 0,
});

/** Mutation score (0–100) for one file's mutants; `null` when there is nothing to score. */
function score(counts: Counts): number | null {
  const detected = counts.Killed + counts.Timeout;
  const valid =
    detected + counts.Survived + counts.NoCoverage + counts.RuntimeError;
  if (valid === 0) return null;
  return (detected / valid) * 100;
}

if (!existsSync(reportDir)) {
  console.error(
    `no mutation reports in ${reportDir} — run \`bun run test:mutation\` first.`,
  );
  process.exit(1);
}

/** Merge every Stryker JSON report in `.mutation/` (one per shard) into a single mutant list per file. */
function loadReports(): MutationReport {
  const files: NonNullable<MutationReport["files"]> = {};
  let found = 0;
  for (const name of readdirSync(reportDir)) {
    if (!name.endsWith(".json")) continue;
    let report: MutationReport;
    try {
      report = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
    } catch {
      continue;
    }
    found++;
    for (const [file, data] of Object.entries(report.files ?? {})) {
      if (!files[file]) files[file] = { mutants: [] };
      files[file]?.mutants?.push(...(data.mutants ?? []));
    }
  }
  if (found === 0) {
    console.error(`no Stryker JSON reports in ${reportDir}.`);
    process.exit(1);
  }
  return { files };
}

const report = loadReports();
const config = JSON.parse(readFileSync(configPath, "utf8")) as Config;

const rows: { rel: string; score: number | null; counts: Counts }[] = [];
const totals = emptyCounts();
for (const [file, data] of Object.entries(report.files ?? {})) {
  const counts = emptyCounts();
  for (const mutant of data.mutants ?? []) {
    const status = (mutant.status ?? "") as keyof Counts;
    if (status in counts) counts[status]++;
  }
  for (const k of Object.keys(totals) as (keyof Counts)[])
    totals[k] += counts[k];
  rows.push({ rel: file, score: score(counts), counts });
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));

const fmt = (n: number | null) =>
  n === null ? "   n/a" : `${n.toFixed(2).padStart(6)}%`;

if (update) {
  const floors: Record<string, number> = {};
  for (const { rel, score: s } of rows)
    if (s !== null) floors[rel] = Math.floor(s * 100) / 100;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, floors }, null, 2)}\n`,
  );
  console.log(
    `updated mutation-score floor for ${Object.keys(floors).length} files`,
  );
  process.exit(0);
}

const floors = config.floors ?? {};
const failures: string[] = [];
for (const { rel, score: s, counts } of rows) {
  if (s === null) continue;
  const need = floors[rel] ?? 0;
  const tol = config.tolerances?.[rel] ?? config.tolerance ?? 0;
  if (s + tol + 1e-9 < need)
    failures.push(
      `${rel}: mutation ${s.toFixed(2)}% < ${need}% (survived ${counts.Survived}, no-coverage ${counts.NoCoverage})`,
    );
}

console.log(
  `${"file".padEnd(64)} ${"%score".padStart(7)} ${"killed".padStart(7)} ${"surv".padStart(6)} ${"timeout".padStart(7)}`,
);
for (const { rel, score: s, counts } of rows)
  console.log(
    `${rel.padEnd(64)} ${fmt(s).padStart(7)} ${String(counts.Killed).padStart(7)} ${String(counts.Survived).padStart(6)} ${String(counts.Timeout).padStart(7)}`,
  );

const total = score(totals);
console.log(
  `\noverall mutation score: ${total === null ? "n/a" : `${total.toFixed(2)}%`} (${totals.Killed + totals.Timeout}/${totals.Killed + totals.Timeout + totals.Survived + totals.NoCoverage + totals.RuntimeError})`,
);

if (failures.length > 0) {
  console.error(`\nmutation gate FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `\nmutation gate OK — ${rows.length} files at or above their floor`,
);
