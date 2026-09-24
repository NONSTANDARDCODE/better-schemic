/**
 * Coverage preload — instruments in-scope sources on load and flushes the Istanbul `__coverage__`
 * object to `$COVERAGE_DIR` on exit. Loaded two ways:
 *
 *   - tests:  `bunfig.toml` `[test].preload` (driver + core packages)
 *   - e2e:    `BUN_OPTIONS="--preload <abs>/scripts/coverage/preload.ts"` on the spawned CLI child
 *
 * NO-OP unless `COVERAGE=1`, so the hot gate pays nothing. Uses the native `oxc-coverage-instrument`
 * (Istanbul-compatible, strips TS in-process, tracks logical truthiness via `reportLogic`) — the
 * 8–48× faster instrumenter the plan chose for speed.
 *
 * Scope comes from `COVERAGE_INCLUDE` (colon-separated absolute roots). Only files UNDER a root and
 * OUTSIDE `node_modules`/`test`/`lib` are instrumented, so test helpers and generated output never
 * skew the numbers.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ENABLED = process.env.COVERAGE === "1";
const DIR = process.env.COVERAGE_DIR;

/** Resolve the configured scope roots once. */
const ROOTS = (process.env.COVERAGE_INCLUDE ?? "")
  .split(":")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => resolve(p));

/** A file is in scope when it lives under a root and is real product source (not test/lib). */
function inScope(path: string): boolean {
  if (ROOTS.length === 0) return false;
  if (path.includes("/node_modules/")) return false;
  if (path.includes("/lib/")) return false;
  if (path.includes("/dist/")) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return false;
  if (path.endsWith(".assert.ts") || path.endsWith(".bench.ts")) return false;
  if (path.includes("/test/")) return false;
  return ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Pick the parser source type from the extension (oxc infers too, but be explicit for TSX). */
function sourceType(path: string): "ts" | "tsx" | "jsx" | undefined {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  return undefined;
}

if (ENABLED && DIR) {
  // Dynamic import so the native binding is only loaded when coverage is actually on.
  const { instrument } = await import("oxc-coverage-instrument");

  /** Loader Bun should use for a pass-through file (its own default would be inferred from the ext). */
  function loaderFor(path: string): "ts" | "tsx" {
    return path.endsWith(".tsx") ? "tsx" : "ts";
  }

  Bun.plugin({
    name: "mcdc-coverage",
    // ONLY `.ts`/`.tsx`: matching `.cjs`/`.mjs` and returning a forced `loader` changes their module
    // type and breaks CommonJS default exports (e.g. jiti.cjs). In-scope sources are all TS.
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!inScope(args.path)) {
          // Returning `undefined` here breaks the test loader (no module), so pass the source through
          // explicitly with its natural loader.
          return { contents: source, loader: loaderFor(args.path) };
        }
        const result = instrument(source, args.path, {
          compat: "istanbul",
          stripTypescript: true,
          reportLogic: true,
          sourceType: sourceType(args.path),
        });
        return { contents: result.code, loader: "js" };
      });
    },
  });

  let flushed = false;
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    const cov = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__;
    if (process.env.COVERAGE_DEBUG === "1")
      console.error(
        `[coverage] flush pid=${process.pid} files=${cov ? Object.keys(cov).length : 0}`,
      );
    if (!cov || Object.keys(cov).length === 0) return;
    try {
      mkdirSync(DIR, { recursive: true });
      // Deterministic per-process name: a later flush OVERWRITES (never double-counts on merge).
      writeFileSync(join(DIR, `${process.pid}.json`), JSON.stringify(cov));
    } catch {
      // Never let coverage collection fail a test run.
    }
  };

  // `bun test` does NOT fire `process.on("exit")`/`beforeExit`; its root `afterAll` hook does. A
  // spawned CLI child (`bun run`, e2e) is not a test, so `afterAll` throws there and `exit` fires.
  // Register BOTH: exactly one path runs in each context.
  try {
    const { afterAll } = await import("bun:test");
    afterAll(flush);
  } catch {
    process.on("exit", flush);
    process.on("beforeExit", flush);
  }
}
