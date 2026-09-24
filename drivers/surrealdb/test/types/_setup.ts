// Shared attest bootstrap for this package's `test/types/` suites. The runner executes every
// `.assert.ts` in ONE node process (`--experimental-test-isolation=none`) so attest's TypeScript
// program is built once; `setup()` is memoized here to keep it that way — it type-checks the whole
// project, so calling it per file would undo the consolidation.
//
// `tsconfig.attest.json` narrows attest's program to `test/types/` + `src/`, keeping the package's
// other test suites (live/e2e/unit) out of the project-wide type-check — the driver's setup drops
// from ~100s to ~33s locally. See packages/core/docs/TYPE-PERF-TESTING.md.
import { fileURLToPath } from "node:url";
import { setup, teardown } from "@ark/attest";

const TSCONFIG = fileURLToPath(
  new URL("./tsconfig.attest.json", import.meta.url),
);

let initialized = false;

/** `before(setupTypes)` — idempotent: the first assert file pays attest's setup, the rest reuse it. */
export function setupTypes(): void {
  if (initialized) return;
  initialized = true;
  setup({ tsconfig: TSCONFIG });
}

/** `after(teardownTypes)` — flushes attest's snapshot updates on exit (idempotent). */
export function teardownTypes(): void {
  teardown();
}
