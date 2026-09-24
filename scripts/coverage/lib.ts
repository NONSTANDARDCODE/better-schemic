/**
 * Shared coverage helpers — fragment merge, per-file metrics (including logical-condition truthiness
 * from `bT`), and a text table. Used by `report.ts` and `check.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createCoverageMap, type CoverageMap } from "istanbul-lib-coverage";

/** Raw Istanbul file coverage, as it appears in a fragment. */
interface RawFileCoverage {
  path: string;
  statementMap: Record<string, { start: { line: number } }>;
  fnMap: Record<string, unknown>;
  branchMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  bT?: Record<string, number[]>;
}

/**
 * Merge every `<pid>.json` Istanbul fragment in `dir` into one map.
 *
 * Deliberately NOT `CoverageMap.merge`: that re-keys `branchMap` while `bT` keeps its original keys,
 * which misaligns (and nulls) the truthiness arrays. Fragments for the SAME file always share ids
 * (same source + instrumenter), so a direct per-id sum is both correct and simpler.
 */
export function mergeFragments(dir: string): CoverageMap {
  const files = new Map<string, RawFileCoverage>();
  let fragments = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let data: Record<string, RawFileCoverage>;
    try {
      data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue; // truncated fragment (process killed mid-write)
    }
    fragments++;
    for (const [path, fc] of Object.entries(data)) {
      const acc = files.get(path);
      if (!acc) {
        files.set(path, {
          ...fc,
          s: { ...fc.s },
          f: { ...fc.f },
          b: Object.fromEntries(
            Object.entries(fc.b).map(([k, v]) => [k, [...v]]),
          ),
          bT: fc.bT
            ? Object.fromEntries(
                Object.entries(fc.bT).map(([k, v]) => [k, [...v]]),
              )
            : undefined,
        });
        continue;
      }
      for (const [k, v] of Object.entries(fc.s)) acc.s[k] = (acc.s[k] ?? 0) + v;
      for (const [k, v] of Object.entries(fc.f)) acc.f[k] = (acc.f[k] ?? 0) + v;
      for (const [k, v] of Object.entries(fc.b)) {
        const cur = (acc.b[k] ??= []);
        v.forEach((n, i) => {
          cur[i] = (cur[i] ?? 0) + n;
        });
      }
      if (fc.bT) {
        acc.bT ??= {};
        for (const [k, v] of Object.entries(fc.bT)) {
          const cur = (acc.bT[k] ??= []);
          v.forEach((n, i) => {
            cur[i] = (cur[i] ?? 0) + n;
          });
        }
      }
    }
  }
  if (fragments === 0) throw new Error(`no coverage fragments in ${dir}`);
  return createCoverageMap(Object.fromEntries(files));
}

/** One file's coverage, in percent (0–100). `conditions` is the logical-truthiness metric. */
export interface FileMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  conditions: number;
  /** Uncovered logical conditions, as `branchId:leafIdx` (for the failure message). */
  uncoveredConditions: string[];
}

const pct = (hit: number, total: number): number =>
  total === 0 ? 100 : (hit / total) * 100;

/** Byte offsets of each line start (1-based line → 0-based offset), for location slicing. */
function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

interface Loc {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/** The source text a coverage location spans. */
function sliceLoc(src: string, starts: number[], loc: Loc): string {
  const off = (p: { line: number; column: number }) =>
    (starts[p.line - 1] ?? 0) + p.column;
  return src.slice(off(loc.start), off(loc.end));
}

/**
 * Whether a logical operand is a CONSTANT literal (`x || {}`, `a ?? "d"`, `flag && true`). MC/DC
 * covers every NON-constant condition; a literal can never take both outcomes, so it must not count
 * against the condition denominator.
 */
function isConstantOperand(text: string): boolean {
  let t = text.trim();
  // Strip balanced wrapping parens.
  while (t.startsWith("(") && t.endsWith(")")) t = t.slice(1, -1).trim();
  if (/^(?:true|false|null|undefined|NaN|Infinity)$/.test(t)) return true;
  if (/^-?(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?|0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?)$/.test(t))
    return true;
  // String / template literal (a template with interpolation is not constant).
  if (/^(['"])[\s\S]*\1$/.test(t)) return true;
  if (t.startsWith("`") && t.endsWith("`") && !t.includes("${")) return true;
  // Object / array / regex literal.
  if (t.startsWith("{") || t.startsWith("[")) return true;
  if (t.startsWith("/")) return true;
  return false;
}

/** Compute all metrics for one file. `source` (optional) enables constant-operand exclusion. */
export function fileMetrics(
  fc: {
    data: RawFileCoverage;
    getLineCoverage(): Record<string, number>;
  },
  source?: string,
): FileMetrics {
  const d = fc.data;
  const sTotal = Object.keys(d.statementMap).length;
  const sHit = Object.values(d.s).filter((n) => n > 0).length;
  const fTotal = Object.keys(d.fnMap).length;
  const fHit = Object.values(d.f).filter((n) => n > 0).length;

  let bTotal = 0;
  let bHit = 0;
  for (const arms of Object.values(d.b)) {
    if (!arms) continue;
    bTotal += arms.length;
    bHit += arms.filter((n) => n > 0).length;
  }

  const lines = fc.getLineCoverage();
  const lTotal = Object.keys(lines).length;
  const lHit = Object.values(lines).filter((n) => n > 0).length;

  const starts = source ? lineStarts(source) : undefined;
  let cTotal = 0;
  let cHit = 0;
  const uncoveredConditions: string[] = [];
  for (const [id, truths] of Object.entries(d.bT ?? {})) {
    if (!truths) continue;
    const evaluated = d.b[id] ?? [];
    const locs = (
      d.branchMap[id] as { locations?: Loc[] } | undefined
    )?.locations;
    truths.forEach((truthy, leaf) => {
      // Skip constant operands: they are not "conditions" under MC/DC.
      if (source && starts && locs?.[leaf]) {
        if (isConstantOperand(sliceLoc(source, starts, locs[leaf]))) return;
      }
      cTotal++;
      const seen = evaluated[leaf] ?? 0;
      // A leaf is condition-covered only when it was evaluated BOTH truthy and falsy.
      if (truthy > 0 && seen - truthy > 0) cHit++;
      else uncoveredConditions.push(`${id}:${leaf}`);
    });
  }

  return {
    statements: pct(sHit, sTotal),
    branches: pct(bHit, bTotal),
    functions: pct(fHit, fTotal),
    lines: pct(lHit, lTotal),
    conditions: pct(cHit, cTotal),
    uncoveredConditions,
  };
}

/** Keep only files under one of `roots`. */
export function inScope(file: string, roots: string[]): boolean {
  return roots.some((r) => file === r || file.startsWith(`${r}/`));
}

/** Format one metric as a fixed-width percent. */
export const fmt = (n: number): string => `${n.toFixed(2).padStart(6)}%`;
