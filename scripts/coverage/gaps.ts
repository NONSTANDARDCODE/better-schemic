/**
 * Coverage GAPS — print, per in-scope file, the exact uncovered statements, branch arms and logical
 * conditions (with source snippets + line numbers), so writing the tests that close them is mechanical.
 *
 *   bun run scripts/coverage/gaps.ts [path-substring]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileMetrics, inScope, mergeFragments } from "./lib";

const root = resolve(import.meta.dir, "../..");
const fragments = process.env.COVERAGE_DIR ?? join(root, ".coverage");
const filter = process.argv[2];
const roots = [
  join(root, "drivers/surrealdb/src"),
  join(root, "packages/core/src"),
];

const map = mergeFragments(fragments);

const lineStarts = (src: string): number[] => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
};
const slice = (src: string, starts: number[], loc: { start: { line: number; column: number }; end: { line: number; column: number } }) =>
  src
    .slice(
      (starts[loc.start.line - 1] ?? 0) + loc.start.column,
      (starts[loc.end.line - 1] ?? 0) + loc.end.column,
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

for (const file of map.files().sort()) {
  if (!inScope(file, roots)) continue;
  const rel = file.replace(`${root}/`, "");
  if (filter && !rel.includes(filter)) continue;
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const starts = lineStarts(src);
  const fc = map.fileCoverageFor(file) as never as {
    data: {
      statementMap: Record<string, { start: { line: number } }>;
      s: Record<string, number>;
      branchMap: Record<string, { locations?: { start: { line: number; column: number }; end: { line: number; column: number } }[] }>;
      b: Record<string, number[]>;
      bT?: Record<string, number[]>;
    };
  };
  const d = fc.data;
  const m = fileMetrics(fc as never, src);
  if (
    m.statements === 100 &&
    m.branches === 100 &&
    m.functions === 100 &&
    m.lines === 100 &&
    m.conditions === 100
  )
    continue;

  const gaps: string[] = [];
  for (const [id, count] of Object.entries(d.s))
    if (count === 0)
      gaps.push(`  stmt  L${d.statementMap[id]?.start.line}: ${slice(src, starts, d.statementMap[id] as never)}`);
  for (const [id, arms] of Object.entries(d.b)) {
    const locs = d.branchMap[id]?.locations ?? [];
    arms.forEach((n, i) => {
      if (n === 0 && locs[i])
        gaps.push(`  arm   L${locs[i].start.line}: ${slice(src, starts, locs[i])}`);
    });
  }
  for (const [id, truths] of Object.entries(d.bT ?? {})) {
    if (!truths) continue;
    const evaluated = d.b[id] ?? [];
    const locs = d.branchMap[id]?.locations ?? [];
    truths.forEach((truthy, leaf) => {
      const seen = evaluated[leaf] ?? 0;
      if (!(truthy > 0 && seen - truthy > 0) && locs[leaf]) {
        const kind = truthy === 0 ? "never-true" : "never-false";
        gaps.push(`  cond  L${locs[leaf].start.line} (${kind}): ${slice(src, starts, locs[leaf])}`);
      }
    });
  }
  if (gaps.length === 0) continue;
  console.log(
    `\n${rel}  [s ${m.statements.toFixed(1)} b ${m.branches.toFixed(1)} f ${m.functions.toFixed(1)} l ${m.lines.toFixed(1)} c ${m.conditions.toFixed(1)}]`,
  );
  console.log([...new Set(gaps)].join("\n"));
}
