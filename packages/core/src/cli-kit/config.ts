import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { BetterSchemicConfig } from "@better-schemic/core/config";
import { createJiti } from "jiti";
import type { ConnectionConfigBase, ResolveContext } from "../connection";

// `better-schemic.ts` is the scaffolded name (the config IS the app's DB module — `betterSchemic.connect()`);
// the legacy `schemic.config.*` / `schemic.ts` spellings keep working. Checked LAST + shape-guarded, so an unrelated
// `./better-schemic.ts` helper module in a project never shadows a real `better-schemic.config.ts`.
const CONFIG_NAMES = [
  "better-schemic.config.ts",
  "better-schemic.config.mjs",
  "better-schemic.config.js",
  "better-schemic.ts",
  // Legacy aliases (pre-rename) — still discovered, after the canonical names.
  "schemic.config.ts",
  "schemic.config.mjs",
  "schemic.config.js",
  "schemic.ts",
];

/**
 * Is the schema path a single file (vs a directory of schema modules)? Determined by `stat` when
 * it exists, else inferred from a `.ts`/`.js`-ish extension.
 */
function schemaIsFilePath(path: string): boolean {
  if (existsSync(path)) return statSync(path).isFile();
  return /\.[mc]?[jt]s$/.test(path);
}

/**
 * Load `.env(.local)` from the project root into `process.env` so the config's own explicit
 * `process.env.X` reads resolve when run under node (bun loads `.env` itself). Does not override
 * already-set variables, so shell env still wins; load `.env.local` first so it beats `.env`.
 */
function loadDotEnv(dir: string): void {
  const proc = process as typeof process & {
    loadEnvFile?: (path: string) => void;
  };
  if (typeof proc.loadEnvFile !== "function") return;
  for (const name of [".env.local", ".env"]) {
    const file = resolve(dir, name);
    if (!existsSync(file)) continue;
    try {
      proc.loadEnvFile(file);
    } catch {
      // ignore a malformed .env file
    }
  }
}

/**
 * A resolved, per-CONNECTION config — the dialect-NEUTRAL shape every command operates on (one
 * connection at a time). `params` are the driver-specific connection params (opaque to core; the
 * driver's `connect` reads them). Built by resolving one entry of `config.connections`.
 */
export interface ResolvedConfig {
  /** Resolved connection name (e.g. `default`, or `tenants:abc` within a collection). */
  connection: string;
  /** The driver this connection uses (the package the CLI dynamically loads). */
  driver: string;
  /** Project root (the directory containing the config file). */
  root: string;
  /** Absolute schema path — a single `.ts` module, or a directory of them. */
  schemaPath: string;
  /** Whether `schemaPath` is a single file (vs a directory of schema modules). */
  schemaIsFile: boolean;
  /** Absolute migrations directory (per connection's schema). */
  migrationsDir: string;
  /** Absolute migration meta directory (the snapshot). */
  metaDir: string;
  /** Name of the table that records applied migrations. */
  migrationsTable: string;
  /** Driver-specific connection params (url/namespace/… or whatever the driver defines). Opaque to core. */
  params: Record<string, unknown>;
  /** Optional seed script (project-level). */
  seed?: string;
}

/**
 * A jiti instance for loading the project's TS/ESM modules. Caches are off so `--watch` re-reads
 * edited schema files. (Bare deps like `@better-schemic/core` are native-imported, so registries stay shared.)
 */
export function makeJiti() {
  return createJiti(import.meta.url, {
    interopDefault: true,
    fsCache: false,
    moduleCache: false,
  });
}

/** Find + load `better-schemic.ts` / `better-schemic.config.ts` (legacy `schemic.*` aliases included) into the dialect-neutral {@link BetterSchemicConfig}. */
export async function loadProject(opts?: {
  config?: string;
  cwd?: string;
}): Promise<{ config: BetterSchemicConfig; root: string }> {
  const cwd = opts?.cwd ?? process.cwd();
  const candidates = opts?.config
    ? [resolve(cwd, opts.config)]
    : CONFIG_NAMES.map((n) => resolve(cwd, n)).filter((p) => existsSync(p));
  if (!candidates.length || !existsSync(candidates[0])) {
    throw new Error(
      "No better-schemic.ts / better-schemic.config.ts found — run `better-schemic init` first.",
    );
  }
  const jiti = makeJiti();
  for (const path of candidates) {
    const root = dirname(path);
    loadDotEnv(root); // populate process.env before the config module's explicit reads
    const loaded = (await jiti.import(path)) as {
      default?: BetterSchemicConfig;
      betterSchemic?: BetterSchemicConfig;
      schemic?: BetterSchemicConfig;
    } & BetterSchemicConfig;
    // Accept a default export OR the named `betterSchemic` export (legacy: `schemic`) — the scaffolded
    // form is the NAMED one (`export const betterSchemic = defineConfig(...)`), so app code auto-imports
    // a deterministic identifier (`import { betterSchemic } from "./better-schemic.config"` ->
    // `betterSchemic.connect()`). Selected by SHAPE, not presence: jiti's interopDefault makes
    // `loaded.default` a truthy proxy even when the module has no real default export, so a presence
    // chain would shadow the named export.
    const config = [
      loaded.default,
      loaded.betterSchemic,
      loaded.schemic,
      loaded,
    ].find(
      (c): c is BetterSchemicConfig =>
        !!c && typeof c === "object" && "connections" in c,
    );
    if (config?.connections && Object.keys(config.connections).length > 0) {
      return { config, root };
    }
    // An AUTO-discovered bare `better-schemic.ts` (or legacy `schemic.ts`) without a connections map is
    // an unrelated helper module, not a config — skip it (an explicitly-passed or `*.config.*` file
    // still errors loudly).
    if (
      !opts?.config &&
      (basename(path) === "better-schemic.ts" ||
        basename(path) === "schemic.ts")
    )
      continue;
    throw new Error(`Invalid config at ${path}: expected a "connections" map.`);
  }
  throw new Error(
    'No Better-schemic config found — ./better-schemic.ts exists but doesn\'t export a config with a "connections" map. Run `better-schemic init`, or export one via defineConfig.',
  );
}

/**
 * Build the {@link ResolvedConfig} for one connection of the project. `ctx` carries the lazy
 * cross-connection proxy + CLI `--arg`s (the CLI provides the real one; a static connection ignores
 * it). A resolver returning a COLLECTION yields one ResolvedConfig per keyed entry.
 *
 * NOTE (WIP — multi-connection): the full resolution engine (lazy proxy DAG, `--connection`/`--all`
 * addressing, collection fan-out) lives in `@better-schemic/cli`; this builder handles a single resolved
 * connection config. See docs/MULTI-CONNECTION.md.
 */
export function resolveConnectionConfig(
  config: BetterSchemicConfig,
  connection: string,
  conn: ConnectionConfigBase,
  driver: string,
  root: string,
): ResolvedConfig {
  const { schema, migrations, key, ...params } = conn;
  const schemaPath = resolve(root, schema);
  // Default migrations dir is RELATIVE TO THE SCHEMA (the documented contract): the sibling
  // `migrations` dir next to the schema dir (or next to a single-file schema). For the standard
  // scaffold (`schema: "./database/schema"`) that is `./database/migrations`, unchanged; a nested
  // schema (`./src/database/schema`) correctly gets `./src/database/migrations` instead of a
  // root-fixed default that split state across two locations.
  const migrationsDir = migrations
    ? resolve(root, migrations)
    : resolve(schemaPath, "..", "migrations");
  return {
    connection: key ? `${connection}:${key}` : connection,
    driver,
    root,
    schemaPath,
    schemaIsFile: schemaIsFilePath(schemaPath),
    migrationsDir,
    metaDir: resolve(migrationsDir, "meta"),
    migrationsTable: config.migrationsTable ?? "_migrations",
    params: params as Record<string, unknown>,
    seed: config.seed,
  };
}

/**
 * Load the project and resolve the DEFAULT connection to a {@link ResolvedConfig} — the single-
 * connection convenience path. (Multi-connection addressing + resolver context are added by the CLI;
 * here a static default connection is resolved with an empty context.)
 */
export async function loadConfig(opts?: {
  config?: string;
  cwd?: string;
}): Promise<ResolvedConfig> {
  const { config, root } = await loadProject(opts);
  const names = Object.keys(config.connections);
  const name =
    config.defaultConnection ?? (names.length === 1 ? names[0] : "default");
  const entry = config.connections[name];
  if (!entry) {
    throw new Error(
      `No connection named "${name}". Set "defaultConnection" or pass --connection. Known: ${names.join(", ")}.`,
    );
  }
  const ctx: ResolveContext = { connections: {}, env: process.env };
  const resolved = await entry.resolve(ctx);
  if (resolved.length !== 1) {
    throw new Error(
      `Connection "${name}" resolved to ${resolved.length} connections (a collection); pass --connection ${name}:<key>.`,
    );
  }
  return resolveConnectionConfig(config, name, resolved[0], entry.driver, root);
}

/** Per-command connection flag overrides (CLI args, applied by the driver over `params`). */
export interface ConnectionOverrides {
  url?: string;
  namespace?: string;
  database?: string;
  username?: string;
  password?: string;
  authLevel?: string;
}
