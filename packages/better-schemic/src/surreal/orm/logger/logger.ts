/**
 * The query logger runtime — the engine behind the `logger` client option and
 * `better-schemic/logger`.
 *
 * It renders the round-trip events the executor emits (`src/orm/execute.ts`) into a framed terminal
 * box (`pretty`), a one-line summary (`compact`) or a JSON object (`json`), colours SurrealQL and
 * bound values, humanizes timing and draws `EXPLAIN` plans as an operator tree.
 *
 * The engine is pure and synchronous (rendering never awaits); the executor decides whether to build
 * an event, so a disabled logger costs nothing. Auto-explain is the ONE async decision: the executor
 * asks {@link QueryLogger.planStatement} for an `EXPLAIN …` and runs it without a logger (no recursion).
 */

import { BoundQuery, Decimal, Duration, Geometry, RecordId, Table, Uuid } from "surrealdb"

import { stringCoerce, stringifyJson, stringifyOpaque } from "../text"
import type {
  LogFormat,
  LoggerOption,
  LoggerOptions,
  QueryLogEvent,
  QueryLogger,
  ResolvedLoggerOptions,
} from "../types/logger"

import { createPalette, padEnd, type Palette, visibleWidth } from "./colors"
import { sqlLines } from "./highlight"
import { resolveLoggerOptions } from "./options"
import { renderPlan } from "./plan"

/** The default inner width of a pretty box. */
const MIN_BOX_WIDTH = 48
/** Time-format thresholds and precision (milliseconds). */
const MS_PER_SECOND = 1000
const MS_LONG = 100
const MS_MID = 10
const DECIMALS_ONE = 1
const DECIMALS_TWO = 2
const CLOCK_START = 11
const CLOCK_END = 23
const BOX_GUTTER = 2
const STACK_LINES = 6

/** The operation → emoji map (falling back to the statement verb; overridable off via `icons:false`). */
const ICON_BY_OPERATION: Record<string, string> = {
  $query: "⚡",
  $raw: "⚡",
  $unsafe: "⚡",
  aggregate: "📊",
  changes: "🔁",
  count: "🔢",
  create: "➕",
  createMany: "➕",
  cursor: "📄",
  delete: "🗑️",
  deleteMany: "🗑️",
  exists: "🔍",
  export: "📤",
  findFirst: "🔍",
  findMany: "🔍",
  findOne: "🔍",
  findUnique: "🔍",
  "fn.call": "ƒ",
  import: "📥",
  info: "ℹ️",
  insert: "➕",
  insertMany: "➕",
  kill: "📡",
  live: "📡",
  paginate: "📄",
  patch: "🩹",
  ping: "🏓",
  relate: "🔗",
  relateMany: "🔗",
  transaction: "🔒",
  unrelate: "🔗",
  unrelateMany: "🔗",
  update: "✏️",
  updateEach: "✏️",
  updateMany: "✏️",
  upsert: "✏️",
  upsertDelta: "🧾",
  upsertMany: "✏️",
  version: "🏷️",
}

const ICON_BY_VERB: Record<string, string> = {
  BEGIN: "🔒",
  CANCEL: "🔒",
  COMMIT: "🔒",
  CREATE: "➕",
  DELETE: "🗑️",
  EXPLAIN: "🔎",
  INFO: "ℹ️",
  INSERT: "➕",
  KILL: "📡",
  LET: "⚡",
  LIVE: "📡",
  RELATE: "🔗",
  REMOVE: "🗑️",
  RETURN: "⚡",
  SELECT: "🔍",
  SHOW: "🔁",
  UPDATE: "✏️",
  UPSERT: "✏️",
}

const firstVerb = (sql: string): string | undefined =>
  /^\s*([A-Za-z]+)/u.exec(sql)?.[1]?.toUpperCase()

/** Read the `BETTER_SCHEMIC_LOG` env into a logger input (`undefined` = not set). */
function envInput(env: Record<string, string | undefined>): boolean | LogFormat | undefined {
  const raw = env.BETTER_SCHEMIC_LOG?.trim().toLowerCase()
  if (!raw) return undefined

  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false

  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true

  if (raw === "pretty" || raw === "json" || raw === "compact" || raw === "silent") return raw

  return true
}

/** Read the `BETTER_SCHEMIC_LOG_*` env into the option fields (the ones set). */
function envOptions(env: Record<string, string | undefined>): LoggerOptions | undefined {
  const options: Record<string, unknown> = {}
  const level = env.BETTER_SCHEMIC_LOG_LEVEL?.trim().toLowerCase()
  if (level === "debug" || level === "info" || level === "warn" || level === "silent")
    options.level = level

  const slow = Number(env.BETTER_SCHEMIC_LOG_SLOW_MS)
  if (env.BETTER_SCHEMIC_LOG_SLOW_MS !== undefined && Number.isFinite(slow) && slow >= 0)
    options.slowMs = slow

  return Object.keys(options).length > 0 ? options : undefined
}

/**
 * Build a {@link QueryLogger}. The engine reads neither the env nor the client — use
 * {@link resolveLogger} for the `logger` option resolution.
 */
export function createQueryLogger(options: LoggerOptions = {}): QueryLogger {
  const resolved = resolveLoggerOptions(options)
  const palette = createPalette(resolved.colors)
  const enabled = resolved.format !== "silent" && resolved.level !== "silent"
  let counter = 0

  const severity = (event: QueryLogEvent): "debug" | "error" | "warn" =>
    event.error === undefined ? (event.durationMs >= resolved.slowMs ? "warn" : "debug") : "error"

  const shouldLog = (event: QueryLogEvent): boolean => {
    if (event.phase === "explain") return true

    if (event.error !== undefined) return true

    if (resolved.level === "debug") return true

    if (resolved.level === "info") return event.durationMs >= resolved.slowMs

    return false
  }

  return {
    emit(event: QueryLogEvent): void {
      if (!enabled || !shouldLog(event)) return

      counter++
      let lines: readonly string[]
      if (resolved.format === "json") lines = [renderJson(event, severity(event), resolved)]
      else if (resolved.format === "compact")
        lines = [renderCompact(event, resolved, palette, counter)]
      else lines = renderPretty(event, resolved, palette, counter)

      lines.forEach((line) => {
        resolved.write(line)
      })
    },
    enabled,
    options: resolved,
    planStatement(sql: string, durationMs: number, phase): string | undefined {
      if (!enabled || phase === "explain" || resolved.explain === false) return undefined

      const body = sql.trim().replace(/;\s*$/u, "")
      if (body.includes(";") || firstVerb(body) !== "SELECT") return undefined

      const wanted =
        resolved.explain === "all" ||
        resolved.explain === "analyze" ||
        durationMs >= resolved.slowMs
      if (!wanted) return undefined

      const prefix =
        resolved.explain === "analyze" ? "EXPLAIN ANALYZE FORMAT JSON" : "EXPLAIN FORMAT JSON"
      return `${prefix} ${body};`
    },
  }
}

/** Is this option an already-built logger (as opposed to a rendering-options bag)? */
function isQueryLogger(value: unknown): value is QueryLogger {
  return (
    typeof value === "object" &&
    value !== null &&
    "emit" in value &&
    typeof value.emit === "function" &&
    "planStatement" in value &&
    typeof value.planStatement === "function"
  )
}

/**
 * Resolve the `logger` client option into a {@link QueryLogger} (or `undefined` when off). `false`
 * disables it explicitly; `undefined` falls back to `BETTER_SCHEMIC_LOG`; `true`/a preset/a config
 * enables it (`BETTER_SCHEMIC_LOG_LEVEL`/`_SLOW_MS` fill any field the input leaves unset). An
 * already-built {@link QueryLogger} uses it as-is (the env never rewrites it).
 */
export function resolveLogger(
  option: LoggerOption | undefined,
  env: Record<string, string | undefined> = process.env,
): QueryLogger | undefined {
  let input: LoggerOption | undefined = option
  if (input === undefined) {
    const fromEnv = envInput(env)
    if (fromEnv === undefined || fromEnv === false) return undefined

    input = fromEnv
  }
  if (input === false) return undefined

  if (isQueryLogger(input)) return input

  const base = envOptions(env)
  if (input === true) return createQueryLogger(base ?? {})

  if (typeof input === "string") return createQueryLogger({ ...base, format: input })

  return createQueryLogger({ ...base, ...input })
}

// --- rendering ---------------------------------------------------------------------------------

/** The emoji for an event (explain wins; then operation; then the statement verb). */
function iconOf(event: QueryLogEvent): string {
  if (event.phase === "explain") return "🔎"

  const byOperation = event.operation ? ICON_BY_OPERATION[event.operation] : undefined
  if (byOperation) return byOperation

  const verb = event.statements[0]?.sql ? firstVerb(event.statements[0].sql) : undefined
  return (verb && ICON_BY_VERB[verb]) ?? "▸"
}

/** The operation label (`findMany`, `EXPLAIN findMany`). */
function operationLabel(event: QueryLogEvent): string {
  const operation = event.operation ?? firstVerb(event.statements[0]?.sql ?? "") ?? "query"
  return event.phase === "explain" ? `EXPLAIN ${operation}` : operation
}

/** Format a duration in ms (`0.42ms`, `12.4ms`, `120ms`, `1.20s`). */
function formatMs(ms: number): string {
  if (ms >= MS_PER_SECOND) return `${(ms / MS_PER_SECOND).toFixed(DECIMALS_TWO)}s`

  if (ms >= MS_LONG) return `${Math.round(ms)}ms`

  if (ms >= MS_MID) return `${ms.toFixed(DECIMALS_ONE)}ms`

  return `${ms.toFixed(DECIMALS_TWO)}ms`
}

/** A compact `HH:MM:SS.mmm` (UTC) label for an event's timestamp. */
function clock(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(CLOCK_START, CLOCK_END)
}

/** The `N rows` / `count N` summary across the OK results, when any result reports one. */
function rowLabel(event: QueryLogEvent): string | undefined {
  const counted = event.results.filter((r) => r.status === "OK" && r.count !== undefined)
  if (counted.length > 0) {
    const total = counted.reduce((sum, r) => sum + (r.count ?? 0), 0)
    return `count ${total}`
  }
  const known = event.results.filter((r) => r.status === "OK" && r.rows !== undefined)
  if (known.length === 0) return undefined

  const rows = known.reduce((sum, r) => sum + (r.rows ?? 0), 0)
  return `${rows} ${rows === 1 ? "row" : "rows"}`
}

/** The statement text shown in a frame (the `EXPLAIN ` probe prefix is redundant under the title). */
function displaySql(sql: string, phase: QueryLogEvent["phase"]): string {
  return phase === "explain" ? sql.replace(/^\s*EXPLAIN\s+/iu, "") : sql
}

/** A JSON-safe rendering of one bound value (used by the `json` format). */

function jsonSafe(value: unknown, seen = new Set<Record<string, unknown>>()): unknown {
  if (value === null || value === undefined) return value

  if (value instanceof Date) return value.toISOString()

  if (typeof value === "bigint") return String(value)

  if (isStringly(value)) return stringCoerce(value)

  if (typeof value !== "object") return value

  if (seen.has(value as Record<string, unknown>)) return "[circular]"

  seen.add(value as Record<string, unknown>)
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen))

  const out: Record<string, unknown> = {}

  Object.entries(value).forEach(([k, v]) => {
    out[k] = jsonSafe(v, seen)
  })

  return out
}

/** A value that stringifies meaningfully (RecordId, Table, Uuid, Duration, Decimal, Geometry). */
function isStringly(value: unknown): boolean {
  return (
    value instanceof RecordId ||
    value instanceof Table ||
    value instanceof Uuid ||
    value instanceof Duration ||
    value instanceof Decimal ||
    value instanceof Geometry ||
    value instanceof BoundQuery
  )
}

/** Colour + truncate one bound value for the pretty/compact formats. */
function renderValue(value: unknown, palette: Palette, maxLen: number): string {
  const text = valueText(value)
  const clipped = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
  let code = "\u001B[35m"
  if (value === null || value === undefined) code = "\u001B[2m"
  else if (typeof value === "string") code = "\u001B[32m"
  else if (typeof value === "number" || typeof value === "bigint") code = "\u001B[36m"
  else if (typeof value === "boolean") code = "\u001B[33m"
  else if (value instanceof Date || isStringly(value)) code = "\u001B[96m"
  return palette.paint(code, clipped)
}

/** A readable string for one value (`null`, `"str"`, `42`, `table:id`, `{…}`, `[circular]`). */
function valueText(value: unknown): string {
  if (value === undefined) return "undefined"

  if (value === null) return "null"

  if (value instanceof Date) return value.toISOString()

  if (typeof value === "bigint") return `${value}n`

  if (typeof value === "string") return JSON.stringify(value)

  if (typeof value === "number" || typeof value === "boolean") return String(value)

  if (isStringly(value)) return stringCoerce(value)

  return stringifyJson(jsonSafe(value)) ?? stringifyOpaque(value)
}

/** `[redacted]` — the placeholder bound values mask them with when `redact` is on. */
const REDACTED = "[redacted]"

/** The `$p0 = 18  $p1 = "abc"` line of a statement's binds. */
function bindsLine(
  vars: Record<string, unknown>,
  palette: Palette,
  opts: ResolvedLoggerOptions,
): string | undefined {
  const keys = Object.keys(vars)
  if (keys.length === 0) return undefined

  const parts = keys.map(
    (key) =>
      `${palette.paint("\u001B[90m", `$${key} =`)} ${
        opts.redact
          ? palette.paint("\u001B[2m", REDACTED)
          : renderValue(vars[key], palette, opts.maxValueLength)
      }`,
  )
  return parts.join("  ")
}

/** The framed pretty output for one event. */
function renderPretty(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string[] {
  const icon = opts.icons ? `${iconOf(event)} ` : ""
  let title = `${icon}${operationLabel(event)}`
  if (event.table) title += ` · ${event.table}`

  const body: string[] = []
  event.statements.forEach((statement, index) => {
    if (index > 0) body.push("")

    body.push(...sqlLines(displaySql(statement.sql, event.phase), palette, opts.prettySql))
    const binds = bindsLine(statement.vars, palette, opts)
    if (binds) body.push(binds)
  })
  if (event.context) {
    body.push(
      palette.paint("\u001B[90m", `ns/${event.context.namespace} · db/${event.context.database}`),
    )
  }
  if (event.plans && event.plans.length > 0) {
    body.push(palette.paint("\u001B[2m", "plan"))

    event.plans.forEach((plan) => {
      body.push(...renderPlan(plan, palette))
    })
  }
  if (event.preview && event.preview.length > 0) {
    body.push(palette.paint("\u001B[2m", "rows"))

    event.preview.forEach((row) => {
      body.push(
        `${palette.paint("\u001B[90m", "↳")} ${renderValue(row, palette, opts.maxValueLength)}`,
      )
    })
  }
  if (event.error !== undefined) body.push(...errorLines(event.error, palette, opts.stack))

  return box(title, body, footer(event, opts, palette, counter))
}

/** The footer meta: `rows · duration [🐌 SLOW] · #n · time`. */
function footer(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string {
  const parts: string[] = []
  const rows = rowLabel(event)
  if (rows) parts.push(rows)

  const slow = event.durationMs >= opts.slowMs
  parts.push(palette.paint(slow ? "\u001B[31m" : "\u001B[32m", formatMs(event.durationMs)))
  if (slow) parts.push(palette.paint("\u001B[33m", "🐌 SLOW"))

  if (opts.counter) parts.push(`#${counter}`)

  if (opts.time) parts.push(clock(event.time))

  return parts.join(" · ")
}

/** Wrap `body` lines between box borders, padding each to the box width. */
function box(title: string, body: readonly string[], foot: string): string[] {
  const titleW = visibleWidth(title)
  const footW = visibleWidth(foot)
  const bodyW = body.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
  const width = Math.max(MIN_BOX_WIDTH, titleW + BOX_GUTTER, footW + BOX_GUTTER, bodyW)
  const lines = [`╭─ ${title} ${"─".repeat(Math.max(0, width - titleW - DECIMALS_ONE))}╮`]

  body.forEach((line) => {
    lines.push(`│ ${padEnd(line, width)} │`)
  })

  lines.push(`╰─ ${foot} ${"─".repeat(Math.max(0, width - footW - DECIMALS_ONE))}╯`)
  return lines
}

/** The `⛔ [CODE] message` block (plus the stack when `stack` is on). */
function errorLines(error: unknown, palette: Palette, stack: boolean): string[] {
  const record = (error ?? {}) as {
    code?: unknown
    message?: unknown
    name?: unknown
    stack?: unknown
  }
  const code = record.code ?? record.name ?? "Error"
  const message = record.message ?? String(error)
  const lines = [
    `${palette.paint("\u001B[1;31m", `⛔ [${stringCoerce(code)}]`)} ${palette.paint("\u001B[31m", stringCoerce(message))}`,
  ]
  if (stack && typeof record.stack === "string") {
    record.stack
      .split("\n")
      .slice(1, STACK_LINES)
      .forEach((line) => {
        lines.push(palette.paint("\u001B[2m", line.trim()))
      })
  }
  return lines
}

/** The one-line compact output. */
function renderCompact(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string {
  const icon = opts.icons ? `${iconOf(event)} ` : ""
  const parts: string[] = [`${icon}${operationLabel(event)}`]
  if (event.table) parts.push(event.table)

  const rows = rowLabel(event)
  if (rows) parts.push(rows)

  const slow = event.durationMs >= opts.slowMs
  parts.push(
    palette.paint(slow ? "\u001B[31m" : "\u001B[32m", formatMs(event.durationMs)) +
      (slow ? palette.paint("\u001B[33m", " 🐌") : ""),
  )
  if (opts.counter) parts.push(`#${counter}`)

  const sql = event.statements
    .map((s) => displaySql(s.sql, event.phase).replaceAll(/\s+/gu, " ").trim())
    .join(" ")
  let line = `${parts.join(" · ")}  ${palette.paint("\u001B[2m", sql)}`
  if (event.error !== undefined) {
    const record = event.error as { code?: unknown; message?: unknown }
    line += `  ${palette.paint(
      "\u001B[31m",

      `⛔ [${stringCoerce(record.code ?? "Error")}] ${stringCoerce(record.message ?? event.error)}`,
    )}`
  }
  return line
}

/** The JSON output (one line per event). */
function renderJson(event: QueryLogEvent, level: string, opts: ResolvedLoggerOptions): string {
  const rows = rowLabel(event)
  return JSON.stringify({
    durationMs: Math.round(event.durationMs * MS_PER_SECOND) / MS_PER_SECOND,
    inTransaction: event.inTransaction,
    level,
    operation: event.operation,
    phase: event.phase,
    table: event.table,
    time: new Date(event.time).toISOString(),
    transactional: event.transactional,
    ...(event.context
      ? {
          context: {
            database: event.context.database,
            namespace: event.context.namespace,
          },
        }
      : {}),
    results: event.results.map((r) => ({
      count: r.count,
      rows: r.rows,
      status: r.status,
      time: r.time,
    })),
    statements: event.statements.map((s) => ({
      sql: s.sql,
      vars: opts.redact
        ? Object.fromEntries(Object.keys(s.vars).map((k) => [k, REDACTED]))
        : jsonSafe(s.vars),
    })),
    ...(rows ? { rows } : {}),
    ...(event.plans && event.plans.length > 0 ? { plans: event.plans } : {}),
    ...(event.preview && event.preview.length > 0
      ? { preview: event.preview.map((row) => jsonSafe(row)) }
      : {}),
    ...(event.error === undefined
      ? {}
      : {
          error: {
            code: (event.error as { code?: unknown }).code,

            message: (event.error as { message?: unknown }).message ?? stringCoerce(event.error),
            name: (event.error as { name?: unknown }).name ?? "Error",
          },
        }),
  })
}
