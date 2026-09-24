/**
 * MC/DC decision RECONCILE — the driver-agnostic guard that keeps the decision inventory honest.
 *
 * For every in-scope source file, enumerate its decisions (`scripts/mcdc/inventory.ts`, TypeScript
 * AST) and require each be classified:
 *   • **auto**  — the current coverage run proves it (Tier-1 `bT` condition coverage for compound
 *                 decisions, both-arms-hit for guards);
 *   • **table** — listed in `mcdc-manifest.json`, mapped to a `describeMcdc` label that a real test
 *                 exercises (Tier-2 unique-cause proof);
 *   • **unknown** — neither. These are the backlog; `mcdc.config.json` ratchets the per-file count so
 *                 a NEW unclassified decision fails the gate (and a pruned one must drop the floor).
 *
 *   bun run scripts/mcdc/reconcile.ts            # enforce the ratchet
 *   bun run scripts/mcdc/reconcile.ts --update   # record the CURRENT unknowns as the floor
 *   bun run scripts/mcdc/reconcile.ts --list     # print every unknown decision
 *
 * Needs a coverage run first (`.coverage/` fragments); `scripts/coverage/run.ts` invokes it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { coveredDecisionKeys, mergeFragments } from "../coverage/lib";
import { inScopeFiles, inventoryFile } from "./inventory";

const root = resolve(import.meta.dir, "../..");
const coverageDir = process.env.COVERAGE_DIR ?? join(root, ".coverage");
const coverageConfig = JSON.parse(
  readFileSync(join(root, "coverage.config.json"), "utf8"),
) as { include: string[]; exclude: string[] };
const manifestPath = join(root, "mcdc-manifest.json");
const ratchetPath = join(root, "mcdc.config.json");

const argv = process.argv.slice(2);
const update = argv.includes("--update");
const list = argv.includes("--list");

interface Ratchet {
  tolerance?: number;
  files?: Record<
    string,
    { total: number; auto: number; table: number; unknown: number }
  >;
}
interface Manifest {
  /** `${relPath}:${line}:${column}` → the `describeMcdc` label proving this decision. */
  table?: Record<string, string>;
}

const ratchet: Ratchet = existsSync(ratchetPath)
  ? JSON.parse(readFileSync(ratchetPath, "utf8"))
  : {};
const manifest: Manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { table: {} };

/** Labels of every `describeMcdc({ label: "…" })` call in the test suites. */
function mcdcLabels(): Set<string> {
  const labels = new Set<string>();
  const re = /describeMcdc\(\s*\{\s*label:\s*(["'`])([^"'`]+)\1/g;
  const scan = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (existsSync(abs) && name.endsWith(".ts")) {
        for (const m of (readFileSync(abs, "utf8") ?? "").matchAll(re))
          labels.add(m[2] as string);
      } else if (!name.includes(".")) {
        try {
          scan(abs);
        } catch {
          /* not a dir */
        }
      }
    }
  };
  for (const base of ["drivers/surrealdb/test", "packages/core/test"])
    scan(join(root, base));
  return labels;
}
const labels = mcdcLabels();

const roots = coverageConfig.include.map((p) => join(root, p));
const files = inScopeFiles(roots).filter(
  (f) => !coverageConfig.exclude.some((ex) => f.includes(ex)),
);

if (!existsSync(coverageDir)) {
  console.error(
    `no coverage fragments in ${coverageDir} — run \`bun run test:coverage\` first.`,
  );
  process.exit(1);
}
const map = mergeFragments(coverageDir);

interface Row {
  rel: string;
  total: number;
  auto: number;
  table: number;
  unknown: { key: string; kind: string }[];
}
const rows: Row[] = [];
const manifestFailures: string[] = [];

for (const file of files) {
  let fc: ReturnType<typeof map.fileCoverageFor>;
  try {
    fc = map.fileCoverageFor(file);
  } catch {
    continue; // not instrumented / never loaded
  }
  const source = readFileSync(file, "utf8");
  const autos = coveredDecisionKeys(fc as never, source);
  const rel = file.replace(`${root}/`, "");
  const row: Row = { rel, total: 0, auto: 0, table: 0, unknown: [] };
  for (const d of inventoryFile(file)) {
    row.total++;
    const key = `${d.line}:${d.column}`;
    const manifestKey = `${rel}:${key}`;
    const label = manifest.table?.[manifestKey];
    if (label !== undefined) {
      if (!labels.has(label))
        manifestFailures.push(
          `${manifestKey} → describeMcdc "${label}" — no test declares that label`,
        );
      row.table++;
    } else if (autos.get(key) === true) {
      row.auto++;
    } else {
      row.unknown.push({ key, kind: d.kind });
    }
  }
  if (row.total > 0) rows.push(row);
}

rows.sort(
  (a, b) => b.unknown.length - a.unknown.length || a.rel.localeCompare(b.rel),
);

if (update) {
  const files: Ratchet["files"] = {};
  for (const r of rows)
    files[r.rel] = {
      total: r.total,
      auto: r.auto,
      table: r.table,
      unknown: r.unknown.length,
    };
  writeFileSync(
    ratchetPath,
    `${JSON.stringify({ ...ratchet, tolerance: ratchet.tolerance ?? 0, files }, null, 2)}\n`,
  );
  console.log(`updated mcdc ratchet for ${rows.length} files`);
  for (const f of manifestFailures) console.error(`  manifest: ${f}`);
  process.exit(manifestFailures.length ? 1 : 0);
}

const tol = ratchet.tolerance ?? 0;
const failures: string[] = [...manifestFailures];
const totals = { total: 0, auto: 0, table: 0, unknown: 0 };
for (const r of rows) {
  totals.total += r.total;
  totals.auto += r.auto;
  totals.table += r.table;
  totals.unknown += r.unknown.length;
  const floor = ratchet.files?.[r.rel]?.unknown ?? 0;
  if (r.unknown.length > floor + tol)
    failures.push(
      `${r.rel}: ${r.unknown.length} unclassified decision(s) > floor ${floor}`,
    );
}

console.log(
  `${"file".padEnd(58)} ${"dec".padStart(5)} ${"auto".padStart(5)} ${"table".padStart(6)} ${"unk".padStart(5)}`,
);
for (const r of rows)
  console.log(
    `${r.rel.padEnd(58)} ${String(r.total).padStart(5)} ${String(r.auto).padStart(5)} ${String(r.table).padStart(6)} ${String(r.unknown.length).padStart(5)}`,
  );
console.log(
  `\n${totals.total} decisions — ${totals.auto} auto, ${totals.table} table, ${totals.unknown} unknown`,
);

if (list) {
  for (const r of rows)
    for (const u of r.unknown)
      console.log(`  unknown  ${r.rel}:${u.key}  (${u.kind})`);
}

if (failures.length > 0) {
  console.error(`\nmcdc gate FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nmcdc gate OK — no new unclassified decisions");
