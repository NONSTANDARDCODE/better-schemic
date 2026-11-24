// SurrealDB driver-contributed CLI commands — `sc <kind> <verb> [args]`. Core's dispatch resolves the
// connection + hands `run(ctx, parsed)` a CommandContext; THIS file owns the SurrealDB logic. Authored
// against the landed DriverCommand contract (the engine's driver SDK). The driver validates positional
// arity itself; use `ctx.io` for all output (never stdio directly).

import { escapeIdent, type Surreal } from "surrealdb"

import { loadDefs } from "../core"
import type { CommandContext, DriverCommand, ParsedCommandArgs } from "../core/driver/sdk"

import { lowerAccess } from "./cli/lower"
import { introspectStructured, type StructAccess } from "./cli/structure"
import { accessBindings, emitDefStatement } from "./ddl"
import type { AccessDef, ParamDef } from "./pure"

type Ctx = CommandContext<Surreal>

/** Read a required positional by index, with a clear error naming the missing arg. */
function pos(a: ParsedCommandArgs, i: number, name: string): string {
  const v = a.positionals[i]
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- verificação defensiva: chamadores JS/SDK podem violar o tipo estático
  if (v === undefined || v === "") throw new Error(`missing <${name}>`)

  return v
}

/** A `surreal.query` returning the first statement's rows. */
async function rows<T = unknown>(
  conn: Surreal,
  sql: string,
  vars?: Record<string, unknown>,
): Promise<T[]> {
  const [first] = await conn.query<[T[]]>(sql, vars)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- verificação defensiva: chamadores JS/SDK podem violar o tipo estático
  return first ?? []
}

/** Type-guard for a standalone access def. Realm-safe + subclass-agnostic: every access builder
 *  (Record/Jwt/Bearer/Database/Namespace) tags `kind: "access"` — matched instead of `constructor.name`. */
function isAccessDef(d: unknown): d is AccessDef {
  return (
    (d as { kind?: string }).kind === "access" && (d as Partial<AccessDef>).config !== undefined
  )
}

/** Load the authored access defs from the schema (; access commands pay for it). */
async function loadAccessDefs(ctx: Ctx): Promise<AccessDef[]> {
  const { defs } = await loadDefs(ctx.config.schemaPath)
  return defs.filter(isAccessDef)
}

/** Type-guard + loader for authored `defineParam` defs (realm-safe: matched by `kind`). */
function isParamDef(d: unknown): d is ParamDef {
  return (d as { kind?: string }).kind === "param" && (d as Partial<ParamDef>).config !== undefined
}
async function loadParamDefs(ctx: Ctx): Promise<ParamDef[]> {
  const { defs } = await loadDefs(ctx.config.schemaPath)
  return defs.filter(isParamDef)
}

/** The live params (name -> canonical value text) via `INFO FOR DB STRUCTURE`. */
async function liveParams(ctx: Ctx): Promise<Map<string, string>> {
  const db = await introspectStructured(ctx.conn)
  return new Map(db.params.map((p) => [p.name, p.value]))
}

/** Resolve an access's `$param -> SecretRef` bindings to concrete values via the provider (empty when the
 * access has no env()/secret() keys). Values pass them as query bindings at apply — never spliced. */
async function resolveBindings(ctx: Ctx, def: AccessDef): Promise<Record<string, string>> {
  const bindings = accessBindings(def)
  const resolved: Record<string, string> = {}
  if (bindings) {
    // Independent resolutions (env/vault reads) — resolve them concurrently, not one by one.
    const entries = Object.entries(bindings)
    const values = await Promise.all(
      entries.map(([, ref]) => Promise.resolve(ctx.secrets.resolve(ref))),
    )
    entries.forEach(([param], i) => {
      resolved[param] = values[i]
    })
  }
  return resolved
}

/** Whitespace-collapse a body/expression so trivial reformatting (SurrealDB re-indents introspected
 * bodies) doesn't read as a change. */
function normBody(s: string | undefined): string {
  return (s ?? "").replaceAll(/\s+/gu, " ").trim()
}

/** Structurally compare an authored access ({@link lowerAccess}) against the live one (introspected),
 * returning a list of changed fields. **Keys exclud them** (SurrealDB redacts them — a key change is
 * invisible here; that's what `rotate` is for). RECORD's auto-generated JWT + materialized default
 * durations don't apply, so an unchanged access doesn't phantom-diff. */
function compareAccess(a: StructAccess, l: StructAccess): string[] {
  const out: string[] = []
  if (a.kind.kind !== l.kind.kind) return [`type ${l.kind.kind} -> ${a.kind.kind}`]

  const ak = a.kind
  const lk = l.kind
  if (ak.kind === "BEARER" && ak.subject !== lk.subject)
    out.push(`subject ${lk.subject} -> ${ak.subject}`)

  // Compare the JWT verify method for TYPE JWT always; for RECORD when the author set WITH JWT
  // (else we'd diff against SurrealDB's auto-generated record JWT).
  if (ak.kind !== "RECORD" || ak.jwt) {
    const av = ak.jwt?.verify
    const lv = lk.jwt?.verify
    if ((av?.url ?? "") !== (lv?.url ?? "")) out.push("jwt url")
    else if (!av?.url && (av?.alg ?? "") !== (lv?.alg ?? "")) out.push("jwt alg")
  }
  if (ak.kind === "RECORD") {
    if (normBody(ak.signup) !== normBody(lk.signup)) out.push("signup")

    if (normBody(ak.signin) !== normBody(lk.signin)) out.push("signin")

    if (normBody(ak.authenticate) !== normBody(lk.authenticate)) out.push("authenticate")

    if (Boolean(ak.refresh) !== Boolean(lk.refresh)) out.push("refresh")
  }
  if ((a.comment ?? "") !== (l.comment ?? "")) out.push("comment")

  // Durations: compare the ones the author explicitly set (SurrealDB materializes defaults on read).
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const key of ["grant", "token", "session"] as const)
    if (a.duration?.[key] && a.duration[key] !== l.duration?.[key]) out.push(`duration ${key}`)

  return out
}

export const surrealCommands: readonly DriverCommand<Surreal>[] = [
  // --- param ------------------------------------------------------------------------------------
  // Secret/declared params are OUT-OF-BAND (mirrors access): SurrealDB stores param values
  // READABLY (INFO returns them), so their values must never reach snapshots or migrations —
  // these verbs are how they deploy. Managed (inline-literal) params ride normal migrations.
  {
    args: {
      flags: [
        {
          help: "an explicit value (declared params)",
          name: "value",
          value: true,
        },
        {
          help: "read the value from this environment variable",
          name: "env",
          value: true,
        },
        {
          help: "print the DEFINE PARAM … statements (values REDACTED) without applying",
          name: "dry-run",
        },
      ],
      positionals: [
        {
          help: "a single param to push (default: all secret/declared params)",
          name: "name",
          required: false,
        },
      ],
    },
    kind: "param",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const only = a.positionals[0]
      const flagValue =
        typeof a.flags.value === "string"
          ? a.flags.value
          : // eslint-disable-next-line unicorn/no-nested-ternary -- Prettier remove os parênteses exigidos pela regra; a expressão encadeada é mais legível que if/else aqui
            typeof a.flags.env === "string"
            ? process.env[a.flags.env]
            : undefined
      if (typeof a.flags.env === "string" && flagValue === undefined)
        throw new Error(`environment variable ${a.flags.env} is not set`)

      const paramDefs = await loadParamDefs(ctx)
      const params = paramDefs.filter((d) => (only ? d.name === only : d.config.mode !== "value"))
      if (params.length === 0) {
        throw new Error(
          only
            ? `no defineParam named "${only}" in the schema`
            : "no secret/declared defineParam definitions in the schema",
        )
      }
      const dryRun = Boolean(a.flags["dry-run"])
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const def of params) {
        const stmt = emitDefStatement(def, { exists: "overwrite" })
        let vars: Record<string, unknown> | undefined
        if (def.config.mode === "secret" && def.config.secret)
          vars = { __value: await ctx.secrets.resolve(def.config.secret) }
        else if (def.config.mode === "declared") {
          if (flagValue === undefined) {
            throw new Error(
              `param "${def.name}" is declared without a value — pass --value or --env (or give it env()/secret() in the schema)`,
            )
          }
          vars = { __value: flagValue }
        }
        if (dryRun) {
          ctx.io.info(stmt.ddl) // the value is a $__value placeholder — nothing to redact
          continue
        }
        await ctx.conn.query(stmt.ddl, vars)
        ctx.io.ok(`pushed param "$${def.name}"`)
      }
      if (dryRun) ctx.io.ok(`dry-run — ${params.length} param(s) not applied`)
    },
    summary:
      "apply DEFINE PARAM out-of-band (all secret/declared params, or <name>) — values from env()/secret(), --value, or --env",
    verb: "push",
  },
  {
    args: { flags: [], positionals: [] },
    kind: "param",
    async run(ctx: Ctx) {
      const authored = await loadParamDefs(ctx)
      if (authored.length === 0) throw new Error("no defineParam definitions in the schema")

      const live = await liveParams(ctx)
      let bad = 0
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const def of authored) {
        const liveValue = live.get(def.name)
        if (liveValue === undefined) {
          ctx.io.fail(
            `missing  $${def.name} — not defined live (sc param push${def.config.mode === "value" ? " or sc push" : ""})`,
          )
          bad++
          continue
        }
        if (def.config.mode === "secret" && def.config.secret) {
          // Compare : the live value is readable to root, but never printed here.
          const want = await ctx.secrets.resolve(def.config.secret)
          const ok = liveValue === `'${want.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
          if (ok) {
            ctx.io.ok(
              `ok       $${def.name} (secret, matches ${def.config.secret.kind}:${def.config.secret.name})`,
            )
          } else {
            ctx.io.fail(
              `stale    $${def.name} — live value differs from ${def.config.secret.kind}:${def.config.secret.name} (sc param push ${def.name})`,
            )
            bad++
          }
        } else ctx.io.ok(`present  $${def.name}`)
      }
      if (bad) throw new Error(`${bad} param(s) need attention`)
    },
    summary:
      "compare authored params against the live database (presence; secret values verified without printing)",
    verb: "check",
  },
  {
    args: { flags: [], positionals: [] },
    kind: "param",
    async run(ctx: Ctx) {
      const authored = await loadParamDefs(ctx).catch(() => [] as ParamDef[])
      const secretNames = new Set(
        authored.filter((d) => d.config.mode !== "value").map((d) => d.name),
      )
      const db = await introspectStructured(ctx.conn)
      if (db.params.length === 0) {
        ctx.io.info("no params defined")
        return
      }

      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const p of db.params) {
        const value = secretNames.has(p.name) ? "<redacted>" : p.value
        ctx.io.info(`$${p.name} = ${value}${p.permissions === false ? "  [PERMISSIONS NONE]" : ""}`)
      }
    },
    summary: "list live DEFINE PARAMs (values of authored secret params are REDACTED)",
    verb: "list",
  },
  // --- access -----------------------------------------------------------------------------------
  {
    args: {
      flags: [
        {
          help: "print the DEFINE ACCESS … OVERWRITE without applying",
          name: "dry-run",
        },
      ],
      positionals: [{ help: "access definition name", name: "name", required: true }],
    },
    kind: "access",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const name = pos(a, 0, "name")
      const accessDefs = await loadAccessDefs(ctx)
      const def = accessDefs.find((d) => d.name === name)
      if (!def) throw new Error(`no defineAccess named "${name}" in the schema`)

      if (!accessBindings(def)) {
        throw new Error(
          `access "${name}" has no env()/secret() key to rotate (its key is inline or absent)`,
        )
      }
      // Re-emit as OVERWRITE; resolve each $param -> SecretRef -> value via the configured provider.
      const ddl = emitDefStatement(def, { exists: "overwrite" }).ddl
      const resolved = await resolveBindings(ctx, def)
      if (a.flags["dry-run"]) {
        ctx.io.info(ddl)
        ctx.io.ok(
          `dry-run — would rotate "${name}" (${Object.keys(resolved).length} secret(s) resolved, not applied)`,
        )
        return
      }
      await ctx.conn.query(ddl, resolved)
      ctx.io.ok(`rotated access "${name}"`)
    },
    summary:
      "re-apply DEFINE ACCESS <name> with its secret freshly resolved (env()/secret()) — for key rotation",
    verb: "rotate",
  },
  {
    args: {
      flags: [
        {
          help: "print the DEFINE ACCESS … OVERWRITE statements without applying",
          name: "dry-run",
        },
      ],
      positionals: [
        {
          help: "a single access to push (default: all authored accesses)",
          name: "name",
          required: false,
        },
      ],
    },
    kind: "access",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const only = a.positionals[0]
      const accessDefs = await loadAccessDefs(ctx)
      const accesses = accessDefs.filter((d) => !only || d.name === only)
      if (accesses.length === 0) {
        throw new Error(
          only
            ? `no defineAccess named "${only}" in the schema`
            : "no defineAccess definitions in the schema",
        )
      }
      const dryRun = Boolean(a.flags["dry-run"])
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const def of accesses) {
        // OVERWRITE so push is idempotent (create-or-replace); secrets resolve to bound params at apply.
        const ddl = emitDefStatement(def, { exists: "overwrite" }).ddl
        const resolved = await resolveBindings(ctx, def)
        if (dryRun) {
          ctx.io.info(ddl)
          continue
        }
        await ctx.conn.query(ddl, resolved)
        ctx.io.ok(`pushed access "${def.name}"`)
      }
      if (dryRun) ctx.io.ok(`dry-run — ${accesses.length} access(es) not applied`)
    },
    summary:
      "apply DEFINE ACCESS to the database (all, or <name>) — deploys access out-of-band from migrations",
    verb: "push",
  },
  {
    args: {
      flags: [
        { help: "the signin user/identifier", name: "user", value: true },
        {
          help: "the signin password (prompted, hidden, if omitted)",
          name: "password",
          value: true,
        },
      ],
      positionals: [{ help: "access definition name", name: "name", required: true }],
    },
    kind: "access",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const name = pos(a, 0, "name")
      const user = typeof a.flags.user === "string" ? a.flags.user : await ctx.io.prompt("user: ")
      // Never require a secret inline (shell-history leak) — prompt hidden when not passed.
      const pass =
        typeof a.flags.password === "string"
          ? a.flags.password
          : await ctx.io.prompt("password: ", { hidden: true })
      try {
        // The connection is already `.use()`d on its namespace/database (ResolvedConfig is
        // dialect-neutral and carries neither), so the access signin rides that context.
        await ctx.conn.signin({
          access: name,
          variables: { pass, user },
        })
        ctx.io.ok(`access "${name}" — signin OK`)
      } catch (error) {
        ctx.io.fail(
          `access "${name}" — signin FAILED: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    summary:
      "verify an access works: sign in as <name> with --user/--password (prompted if omitted)",
    verb: "check",
  },
  {
    args: {
      flags: [],
      positionals: [
        {
          help: "a single access to diff (default: all)",
          name: "name",
          required: false,
        },
      ],
    },
    kind: "access",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const only = a.positionals[0]
      const accessDefs = await loadAccessDefs(ctx)
      const defs = accessDefs.filter((d) => !only || d.name === only)
      if (only && defs.length === 0)
        throw new Error(`no defineAccess named "${only}" in the schema`)

      const structured = await introspectStructured(ctx.conn, new Set())
      const live = structured.accesses
      const liveByName = new Map(live.map((l) => [l.name, l]))
      const authoredNames = new Set(defs.map((d) => d.name))
      let differ = 0
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const def of defs) {
        const authored = lowerAccess(def)
        const l = liveByName.get(def.name)
        if (l) {
          const changed = compareAccess(authored, l)
          if (changed.length > 0) {
            ctx.io.info(`~ ${def.name}  changed: ${changed.join(", ")}`)
            differ++
          } else ctx.io.info(`= ${def.name}  in sync`)
        } else {
          ctx.io.info(`+ ${def.name}  new — not in database (sc access push ${def.name})`)
          differ++
        }
        // Keys redact them on read, so a key change is invisible to diff — flag the explicit path.
        if (accessBindings(def)) {
          ctx.io.info(
            `    (has secret key — key changes aren't detected here; use: sc access rotate ${def.name})`,
          )
        }
      }
      // Orphans: live accesses with no authored def (when diffing the whole set, not a single name).
      if (!only) {
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (const l of live) {
          if (!authoredNames.has(l.name)) {
            ctx.io.info(`- ${l.name}  orphan — in database, not in schema (not removed)`)
            differ++
          }
        }
      }
      ctx.io.ok(differ ? `${differ} access(es) differ` : "all accesses in sync")
    },
    summary:
      "compare authored DEFINE ACCESS vs the live database (structure only — keys are redacted)",
    verb: "diff",
  },
  // --- table ------------------------------------------------------------------------------------
  {
    args: {
      flags: [{ help: "max rows (default 100)", name: "limit", value: true }],
      positionals: [
        { help: "table name", name: "table", required: true },
        {
          help: "equality filter, e.g. id=123",
          name: "col=value",
          required: true,
        },
      ],
    },
    kind: "table",
    async run(ctx: Ctx, a: ParsedCommandArgs) {
      const table = pos(a, 0, "table")
      const kv = pos(a, 1, "col=value")
      const eq = kv.indexOf("=")
      if (eq < 1) throw new Error(`expected <col=value>, got "${kv}"`)

      const col = kv.slice(0, eq)
      const val = kv.slice(eq + 1)
      // eslint-disable-next-line @typescript-eslint/no-magic-numbers -- literal numérico é parte do contrato/formato da ferramenta (porta, timeout ou offset)
      const limit = Math.max(1, Math.floor(Number(a.flags.limit ?? 100)) || 100)
      // table + column are identifiers (escaped); the value is a BOUND param.
      const sql = `SELECT * FROM type::table($tbl) WHERE ${escapeIdent(col)} = $val LIMIT ${limit}`
      const found = await rows(ctx.conn, sql, { tbl: table, val })
      ctx.io.ok(`${found.length} row(s)`)
      // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
      for (const r of found) ctx.io.info(JSON.stringify(r))
    },
    summary: "SELECT * FROM <table> WHERE <col=value> [--limit N]",
    verb: "find",
  },
]
