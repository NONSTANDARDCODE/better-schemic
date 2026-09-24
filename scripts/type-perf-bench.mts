// Shared TYPE-PERF bench aggregator — imports every `.bench.ts` passed as argv in ONE node process.
//
// Why one process: each attest `bench(...).types()` drives a TypeScript program plus an isolated
// counting env; a fresh `node` per bench file rebuilds both every time. Importing the files in
// sequence reuses `TsServer.instance` and the isolated env, so N bench files pay that cost once.
// A budget overrun still fails the run: `bench().types()` throws during import, so the await below
// rejects and node exits non-zero. Spawned by scripts/type-perf.ts (cwd = the package dir) — not
// meant to be run directly. The `.mts` extension keeps this file ESM (top-level await) regardless
// of the root package.json, which has no `"type": "module"`.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

for (const file of process.argv.slice(2)) {
  await import(pathToFileURL(resolve(file)).href);
}
