// The SURREAL driver — a SET OF KINDS on the core-v2 registry (see docs/kind-registry-flip-plan.md).
//
// Everything dialect-specific lives here: the kind `registry` (table/index/event/function/access), the
// authoring -> kinded `explode`, the single-read `introspectAll`, the connection lifecycle, and the
// SurrealDB command capabilities. Core orchestrates schema ops (lower/diff/emit/order) GENERICALLY over
// `registry` — it never names a kind. The Struct-IR (`DbStructured`) + `diffSnapshots` stay the driver's
// INTERNAL clause-level engine (the kinds delegate to them); the field/type substrate stays core.

import { escapeIdent, type Surreal } from "surrealdb"

import type {
  ApplyOptions,
  ConnectionOverrides,
  Driver,
  MigrationRecord,
  MigrationStore,
  ResolvedConfig,
  ShadowCapability,
} from "../../core"
import { connectEmbedded, spawnEphemeralServer, surrealBinaryAvailable } from "../cli/engine"
import {
  applyStatements,
  diffAgainstDb,
  shadowStructured,
  syncPlan,
  tsStructsAgainstDb,
  verifyMigrations,
} from "../cli/introspect"
import { planPull, renderPerFile, renderSchemaToTS } from "../cli/pull"
import { initScaffold, scaffoldEntity } from "../cli/scaffold"
import { normalizeDb } from "../cli/struct"
import type { DbStructured } from "../cli/structure"
import { fmtDiff, renderMigration } from "../cli/surreal-diff"
import { filterStructured } from "../cli/surreal-filter"
import { surrealCommands } from "../commands"
import type { SurrealParams } from "../config"
import { connect as surrealConnect, redactUrl } from "../connect"
import { FN_NAME } from "../fn-name"
import {
  explodeSchema,
  fromStructured,
  introspectAll as introspectAllKinds,
  toStructured,
} from "../kinds/explode"
import type { SurrealPortable } from "../kinds/portable"
import { surrealKinds } from "../kinds/registry"
import type { Shape, StandaloneDef, TableDef } from "../pure"

const shadow: ShadowCapability<Surreal> = {
  // Apply DDL to a throwaway database, read it back via INFO STRUCTURE, drop it — the live-side
  // canonicalizer. Delegates to `shadowStructured`, then to per-kind portable objects (== lowering).
  roundTrip: async (conn, config, ddl) =>
    fromStructured(normalizeDb(await shadowStructured(conn, config, ddl))),
  // `ephemeral` (full isolated instance for `sz check` replay) is intentionally not wired here —
  // `check` still uses its existing path. A later milestone routes it through this capability.
}

// --- migration bookkeeping (the apply-time SurrealQL, moved behind the driver) -------------------

/** Record one applied migration: a `_migrations` row keyed by tag, with file + checksum + time. */
const RECORD_SQL =
  "CREATE type::record($tbl, $tag) CONTENT { tag: $tag, file: $file, checksum: $sum, applied_at: time::now() }"
const recordVars = (
  table: string,
  r: MigrationRecord,
): { file: string; sum: string; tag: string; tbl: string } => ({
  file: r.file,
  sum: r.checksum,
  tag: r.tag,
  tbl: table,
})

/** `DEFINE TABLE … SCHEMALESS` for an internal tracking table (migrations or its lock). */
async function ensureTrackTable(conn: Surreal, table: string): Promise<void> {
  await conn.query(
    `DEFINE TABLE IF NOT EXISTS ${escapeIdent(table)} TYPE NORMAL SCHEMALESS PERMISSIONS NONE;`,
  )
}

const lockTableOf = (table: string): string => `${table}_lock`

const migrations: MigrationStore<Surreal> = {
  async applied(conn, table) {
    const [rows] = await conn.query<[{ checksum: string; tag: string }[]]>(
      "SELECT tag, checksum FROM type::table($tbl)",
      { tbl: table },
    )
    const result = rows as undefined | { checksum: string; tag: string }[]
    return new Map((result ?? []).map((r) => [r.tag, r.checksum]))
  },
  // SurrealDB is natively transactional — run the migration program + its bookkeeping write in one
  // BEGIN/COMMIT so the record writes it iff the DDL applied. `$direction` drives the up/down branch.
  async apply(conn, table, { content, direction, record }) {
    const bookkeep =
      direction === "up"
        ? { sql: RECORD_SQL, vars: recordVars(table, record) }
        : {
            sql: "DELETE type::record($tbl, $tag)",
            vars: { tag: record.tag, tbl: table },
          }
    await conn.query(`BEGIN;\n${content}\n${bookkeep.sql};\nCOMMIT;`, {
      direction,
      ...bookkeep.vars,
    })
  },
  async clear(conn, table) {
    await conn.query("DELETE type::table($tbl)", { tbl: table })
  },

  ensure: ensureTrackTable,

  // SurrealDB migrations are SurrealQL scripts.
  extension: ".surql",

  async lock(conn, table) {
    const tbl = lockTableOf(table)
    await ensureTrackTable(conn, tbl)
    try {
      await conn.query("CREATE type::record($tbl, 'lock') CONTENT { at: time::now() }", { tbl })
    } catch {
      throw new Error(
        "Migrations are locked — another run is in progress. If it's stale, run `better-schemic unlock`.",
      )
    }
  },

  async record(conn, table, record) {
    await ensureTrackTable(conn, table)
    await conn.query(RECORD_SQL, recordVars(table, record))
  },

  render: (tag, diff) => renderMigration(tag, diff),

  async unlock(conn, table) {
    await conn.query("DELETE type::record($tbl, 'lock')", {
      tbl: lockTableOf(table),
    })
  },
}

/**
 * Render a structured schema to per-file source: one combined module under `single`, else one file
 * per object via `fileFor`. Shared by `renderSchema` (offline `diff --ts`) and `diffTsLive`.
 */
function renderFiles(
  struct: DbStructured,
  fileFor: (kind: string, name: string) => string,
  single?: string,
): Map<string, string> {
  return single ? new Map([[single, renderSchemaToTS(struct)]]) : renderPerFile(struct, fileFor)
}

export const surrealDriver: Driver<Surreal, TableDef<string, Shape>, StandaloneDef> = {
  async apply(conn: Surreal, statements: string[], opts?: ApplyOptions): Promise<void> {
    if (statements.length === 0) return

    if (opts?.transactional === false) {
      await statements.reduce<Promise<void>>(async (prev, s) => {
        await prev
        await conn.query(s)
      }, Promise.resolve())

      return
    }
    // SurrealDB is natively transactional — one BEGIN/COMMIT around the batch (matches applyStatements).
    await applyStatements(conn, statements)
  },
  // (B) DB-functions-as-code — invoke a defined function by name with already-encoded args and return
  // its RAW result. SurrealQL function calls are POSITIONAL, so the args (in param order) bind them to
  // generic `$a0, $a1, …` vars and passed positionally: `RETURN fn::name($a0, $a1)`. The caller
  // (`FunctionDef.call` / core's `callFunction`) decodes the raw value through `.returns(R)`.
  callable: {
    async invoke(conn: Surreal, name: string, args: Record<string, unknown>): Promise<unknown> {
      const values = Object.values(args)
      const placeholders = values.map((_, i) => `$a${i}`).join(", ")
      const vars = Object.fromEntries(values.map((v, i) => [`a${i}`, v]))
      // The name splics it, not bound — check with the shared grammar (a name like
      // `x; REMOVE TABLE user` must never reach the query text). Preserve the historical
      // `fn::` prefixing (`math::add` -> `fn::math::add`).
      const bare = name.replace(/^fn::/u, "")
      if (!FN_NAME.test(bare)) {
        throw new Error(
          `fn: "${name}" is not a valid function name — use letters, digits, _ and :: segments.`,
        )
      }
      const fn = `fn::${bare}`
      const out = await conn.query(`RETURN ${fn}(${placeholders})`, vars)
      return out[0]
    },
  },

  // `check`: replay every migration into a throwaway engine and diff the result against the schema.
  // Owns ephemeral-engine selection — an embedded @surrealdb/node instance, an ephemeral server from
  // the local `surreal` binary, or a configured scratch server — and the replay never touches the
  // real database. Progress lines go to `log`; the empty/non-empty diff reports it by the caller.
  async checkReplay(config, over, filter, log) {
    const params = config.params as unknown as SurrealParams
    const check = params.check
    const engine = check?.engine ?? "auto"
    const useBinary =
      engine === "binary" || (engine === "auto" && surrealBinaryAvailable(check?.binary))
    if (engine === "binary" && !useBinary) {
      throw new Error(
        'check.engine "binary" needs the `surreal` CLI on PATH (or set `check.binary`). Run `better-schemic check --schema` to skip the replay.',
      )
    }

    let db: Surreal
    let checkCfg: ResolvedConfig
    let cleanup: () => Promise<void>
    if (typeof engine === "object") {
      const embedded = await connectEmbedded(engine, "check", "check")
      db = embedded.db
      checkCfg = {
        ...config,
        params: {
          authLevel: "root",
          database: "check",
          namespace: "check",
          url: embedded.url,
        } satisfies SurrealParams,
      }
      cleanup = embedded.stop
      log(
        `  replaying on an ${embedded.url} SurrealDB (@surrealdb/node) — no server, your data untouched`,
      )
    } else if (useBinary) {
      const server = await spawnEphemeralServer(check?.binary)
      checkCfg = {
        ...config,
        params: {
          authLevel: "root",
          database: "check",
          namespace: "check",
          password: server.password,
          url: server.url,
          username: server.username,
        } satisfies SurrealParams,
      }
      db = await surrealConnect(checkCfg, {})
      cleanup = async (): Promise<void> => {
        await db.close().catch(() => {
          /* ignore close errors */
        })
        await server.stop()
      }
      log(
        "  replaying on an ephemeral in-memory SurrealDB (local `surreal` binary) — your server is untouched",
      )
    } else {
      // Scratch connection for the `remote` engine: check.db merged over the connection's own params.
      const remote: SurrealParams = { ...params, ...check?.db }
      checkCfg = {
        ...config,
        params: remote,
      }
      try {
        db = await surrealConnect(checkCfg, over)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n  (run \`better-schemic check --schema\` to skip the replay, install the \`surreal\` CLI for an in-memory engine, or set \`check.db\` to point the replay at a scratch server)`,
          { cause: error },
        )
      }
      cleanup = async (): Promise<void> => {
        await db.close().catch(() => {
          /* ignore close errors */
        })
      }
      log(
        `  replaying on ${redactUrl(remote.url)} (${remote.namespace}) — isolated scratch databases; your data is untouched`,
      )
    }

    try {
      return await verifyMigrations(db, checkCfg, filter, (tag) => {
        log(`  ${tag}`)
      })
    } finally {
      await cleanup()
    }
  },
  async close(conn: Surreal): Promise<void> {
    await conn.close()
  },

  // --- execution -----------------------------------------------------------------------------

  // Driver-contributed CLI commands — `sc access rotate/check`, `sc table find`.
  commands: surrealCommands,

  connect(config: ResolvedConfig, over?: ConnectionOverrides): Promise<Surreal> {
    // The driver's portable `ConnectionOverrides` is a structural superset of the SDK's; the
    // soft field is `authLevel` (a string here vs. the SDK's `AuthLevel` union) — pass it through.
    return surrealConnect(config, over ?? {})
  },

  diffLive: async (conn, config, filter) => fmtDiff(await diffAgainstDb(conn, config, filter)),

  // Live `diff --ts`: both sides normalized through SurrealDB, then rendered per file.
  async diffTsLive(conn, config, filter, fileFor, single) {
    const { current, desired } = await tsStructsAgainstDb(conn, config, filter)
    return {
      current: renderFiles(current, fileFor, single),
      desired: renderFiles(desired, fileFor, single),
    }
  },

  // --- kind registry (the schema engine) -----------------------------------------------------
  // Authoring -> kinded definables (the driver-side explode: one inline-authored table fans out into
  // [table, ...index, ...event], db-level functions/accesses alongside). Core lowers via
  // `lowerSchema(registry, explode(...))`, then diffs/emits/orders GENERICALLY — it never names a kind.
  explode: (tables, defs) => explodeSchema(tables, defs),

  // The files `better-schemic init` scaffolds for a fresh SurrealDB project (connections-config + sample
  // s.* schema + seed + .env.example); the CLI writes them and adds the neutral migration snapshot.
  initScaffold,
  // Live DB -> all portable objects: ONE `INFO … STRUCTURE` read fanned per kind, canonicalized
  // IDENTICALLY to lowering (a clean apply round-trips to a zero diff) and complete (every kind).
  introspectAll: (conn, exclude) => introspectAllKinds(conn, exclude),

  migrations,

  // --- command capabilities (thin adapters over the existing surreal cli functions) ----------

  name: "surrealdb",
  planPull: (conn, config, opts) => planPull(conn, config, opts),

  /**
   * Raw READ query -> rows, for connection resolvers (`ctx.connections.<name>.query(...)`) and seed.
   * SurrealQL returns one result per statement; we hand back the LAST statement's rows (the payload of
   * a `… ; SELECT …` resolver), wrapping a scalar/`RETURN` result and treating none as an empty set.
   */
  async query<T = unknown>(
    conn: Surreal,
    sql: string,
    vars?: Record<string, unknown>,
  ): Promise<T[]> {
    const results = await conn.query(sql, vars)
    if (results.length === 0) return []

    const last = results.at(-1)
    if (Array.isArray(last)) return last as T[]
    if (last == null) return []
    return [last as T]
  },

  registry: surrealKinds,

  // Offline `diff --ts` / `pull`: reconstruct the structured form from the portable objects (no DDL
  // re-parse — the normalized struct rides on them), filter, render to per-file `s.*` source.
  renderSchema(objects, filter, fileFor, single) {
    return renderFiles(
      filterStructured(toStructured(objects as SurrealPortable[]), filter),
      fileFor,
      single,
    )
  },

  // `better-schemic new <kind> <name>`: the starter `s.*`/`define*` module for one entity (table/relation/
  // view/function/access/event/analyzer); throws for inline-(index/field) or unknown kinds.
  scaffoldEntity,

  async serverInfo(conn) {
    let v = "unknown"
    try {
      const version = await conn.version()
      v = version.version
    } catch {
      // server version unavailable
    }
    return `SurrealDB ${v}`
  },

  shadow,

  syncPlan: (diff, prune) => syncPlan(diff, prune),
}
