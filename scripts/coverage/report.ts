/**
 * Coverage report — merge the Istanbul fragments from `.coverage/` and write HTML/LCOV/JSON reports
 * to `coverage/`, plus a text table that includes the logical-condition (`bT`) metric.
 *
 *   bun run scripts/coverage/report.ts
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import { fileMetrics, fmt, inScope, mergeFragments } from "./lib";

const root = resolve(import.meta.dir, "../..");
const fragments = process.env.COVERAGE_DIR ?? join(root, ".coverage");
const out = join(root, "coverage");
mkdirSync(out, { recursive: true });

const map = mergeFragments(fragments);
const include = [
  join(root, "drivers/surrealdb/src"),
  join(root, "packages/core/src"),
];

// Istanbul's own reports (HTML/LCOV/JSON) — text is replaced by ours (it can't show `bT`).
const context = createContext({ dir: out, coverageMap: map });
for (const name of ["html", "lcov", "json-summary"]) {
  reports.create(name as "html").execute(context);
}

const files = map.files().filter((f) => inScope(f, include)).sort();
const totals = { s: [0, 0], b: [0, 0], f: [0, 0], l: [0, 0], c: [0, 0] };
const rows: string[] = [];
for (const file of files) {
  let source: string | undefined;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    source = undefined;
  }
  const m = fileMetrics(map.fileCoverageFor(file) as never, source);
  const rel = file.replace(`${root}/`, "");
  rows.push(
    `${rel.padEnd(58)} ${fmt(m.statements)} ${fmt(m.branches)} ${fmt(m.functions)} ${fmt(m.lines)} ${fmt(m.conditions)}`,
  );
}
console.log(
  `${"file".padEnd(58)} ${"%stmts".padStart(6)} ${"%brnch".padStart(6)} ${"%funcs".padStart(6)} ${"%lines".padStart(6)} ${"%cond".padStart(6)}`,
);
console.log(rows.join("\n"));
console.log(`\n${files.length} in-scope files · fragments: ${fragments}`);
