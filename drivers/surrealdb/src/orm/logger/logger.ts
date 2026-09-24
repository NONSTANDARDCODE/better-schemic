/**
 * The query logger runtime — the engine behind the `logger` client option and
 * `@better-schemic/surrealdb/logger`.
 *
 * It renders the round-trip events the executor emits (`src/orm/execute.ts`) into a framed terminal
 * box (`pretty`), a one-line summary (`compact`) or a JSON object (`json`), colours SurrealQL and
 * bound values, humanizes timing and draws `EXPLAIN` plans as an operator tree.
 *
 * The engine is pure and synchronous (rendering never awaits); the executor decides whether to build
 * an event, so a disabled logger costs nothing. Auto-explain is the ONE async decision: the executor
 * asks {@link QueryLogger.planStatement} for an `EXPLAIN …` and runs it without a logger (no recursion).
 */

import type {
  LogFormat,
  LoggerOption,
  LoggerOptions,
  QueryLogEvent,
  QueryLogger,
  ResolvedLoggerOptions,
} from "../types/logger";
import {
  createPalette,
  detectColor,
  type Palette,
  padEnd,
  visibleWidth,
} from "./colors";
import { sqlLines } from "./highlight";
import { renderPlan } from "./plan";

/** The default minimum inner width of a pretty box. */
const MIN_BOX_WIDTH = 48;

/** The operation → emoji map (falling back to the statement verb; overridable off via `icons:false`). */
const ICON_BY_OPERATION: Record<string, string> = {
  findMany: "🔍",
  findFirst: "🔍",
  findOne: "🔍",
  findUnique: "🔍",
  count: "🔢",
  exists: "🔍",
  aggregate: "📊",
  paginate: "📄",
  cursor: "📄",
  create: "➕",
  createMany: "➕",
  insert: "➕",
  insertMany: "➕",
  update: "✏️",
  updateMany: "✏️",
  updateEach: "✏️",
  upsert: "✏️",
  upsertMany: "✏️",
  patch: "🩹",
  delete: "🗑️",
  deleteMany: "🗑️",
  relate: "🔗",
  relateMany: "🔗",
  unrelate: "🔗",
  unrelateMany: "🔗",
  live: "📡",
  kill: "📡",
  changes: "🔁",
  info: "ℹ️",
  import: "📥",
  export: "📤",
  ping: "🏓",
  version: "🏷️",
  "fn.call": "ƒ",
  transaction: "🔒",
  $raw: "⚡",
  $query: "⚡",
  $unsafe: "⚡",
};

const ICON_BY_VERB: Record<string, string> = {
  SELECT: "🔍",
  CREATE: "➕",
  INSERT: "➕",
  UPDATE: "✏️",
  UPSERT: "✏️",
  DELETE: "🗑️",
  REMOVE: "🗑️",
  RELATE: "🔗",
  LIVE: "📡",
  KILL: "📡",
  EXPLAIN: "🔎",
  BEGIN: "🔒",
  COMMIT: "🔒",
  CANCEL: "🔒",
  INFO: "ℹ️",
  SHOW: "🔁",
  RETURN: "⚡",
  LET: "⚡",
};

const firstVerb = (sql: string): string | undefined =>
  /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();

/** Read the `BETTER_SCHEMIC_LOG` env into a logger input (`undefined` = not set). */
function envInput(
  env: Record<string, string | undefined>,
): boolean | LogFormat | undefined {
  const raw = env.BETTER_SCHEMIC_LOG?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no")
    return false;
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes")
    return true;
  if (
    raw === "pretty" ||
    raw === "json" ||
    raw === "compact" ||
    raw === "silent"
  )
    return raw;
  return true;
}

/** Read the `BETTER_SCHEMIC_LOG_*` env into the option fields (only the ones set). */
function envOptions(
  env: Record<string, string | undefined>,
): LoggerOptions | undefined {
  const options: Record<string, unknown> = {};
  const level = env.BETTER_SCHEMIC_LOG_LEVEL?.trim().toLowerCase();
  if (
    level === "debug" ||
    level === "info" ||
    level === "warn" ||
    level === "silent"
  )
    options.level = level;
  const slow = Number(env.BETTER_SCHEMIC_LOG_SLOW_MS);
  if (
    env.BETTER_SCHEMIC_LOG_SLOW_MS !== undefined &&
    Number.isFinite(slow) &&
    slow >= 0
  )
    options.slowMs = slow;
  return Object.keys(options).length > 0
    ? (options as LoggerOptions)
    : undefined;
}

/** Resolve a defaulted options bag (env overrides are merged in by {@link resolveLogger}). */
function resolveOptions(options: LoggerOptions = {}): ResolvedLoggerOptions {
  return {
    level: options.level ?? "debug",
    format: options.format ?? "pretty",
    colors: detectColor(options.colors),
    icons: options.icons ?? true,
    time: options.time ?? true,
    counter: options.counter ?? true,
    slowMs: options.slowMs ?? 100,
    verbose: options.verbose ?? false,
    maxRows: options.maxRows ?? 3,
    maxValueLength: options.maxValueLength ?? 160,
    prettySql: options.prettySql ?? true,
    explain: options.explain ?? false,
    stack: options.stack ?? false,
    write: options.write ?? ((line: string) => console.log(line)),
  };
}

/**
 * Build a {@link QueryLogger}. The engine reads neither the env nor the client — use
 * {@link resolveLogger} for the `logger` option resolution.
 */
export function createQueryLogger(options: LoggerOptions = {}): QueryLogger {
  const resolved = resolveOptions(options);
  const palette = createPalette(resolved.colors);
  const enabled = resolved.format !== "silent" && resolved.level !== "silent";
  let counter = 0;

  const severity = (event: QueryLogEvent): "error" | "warn" | "debug" =>
    event.error !== undefined
      ? "error"
      : event.durationMs >= resolved.slowMs
        ? "warn"
        : "debug";

  const shouldLog = (event: QueryLogEvent): boolean => {
    if (event.phase === "explain") return true;
    if (event.error !== undefined) return true;
    if (resolved.level === "debug") return true;
    if (resolved.level === "info") return event.durationMs >= resolved.slowMs;
    return false;
  };

  return {
    enabled,
    options: resolved,
    emit(event: QueryLogEvent): void {
      if (!enabled || !shouldLog(event)) return;
      counter++;
      const lines =
        resolved.format === "json"
          ? [renderJson(event, severity(event))]
          : resolved.format === "compact"
            ? [renderCompact(event, resolved, palette, counter)]
            : renderPretty(event, resolved, palette, counter);
      for (const line of lines) resolved.write(line);
    },
    planStatement(sql: string, durationMs: number, phase): string | undefined {
      if (!enabled || phase === "explain" || resolved.explain === false)
        return undefined;
      const body = sql.trim().replace(/;\s*$/, "");
      if (body.includes(";") || firstVerb(body) !== "SELECT") return undefined;
      const wanted =
        resolved.explain === "all" ||
        resolved.explain === "analyze" ||
        durationMs >= resolved.slowMs;
      if (!wanted) return undefined;
      const prefix =
        resolved.explain === "analyze"
          ? "EXPLAIN ANALYZE FORMAT JSON"
          : "EXPLAIN FORMAT JSON";
      return `${prefix} ${body};`;
    },
  };
}

/**
 * Resolve the `logger` client option into a {@link QueryLogger} (or `undefined` when off). `false`
 * disables it explicitly; `undefined` falls back to `BETTER_SCHEMIC_LOG`; `true`/a preset/a config
 * enables it (`BETTER_SCHEMIC_LOG_LEVEL`/`_SLOW_MS` fill any field the input leaves unset).
 */
export function resolveLogger(
  option: LoggerOption | undefined,
  env: Record<string, string | undefined> = process.env,
): QueryLogger | undefined {
  let input: LoggerOption | undefined = option;
  if (input === undefined) {
    const fromEnv = envInput(env);
    if (fromEnv === undefined || fromEnv === false) return undefined;
    input = fromEnv;
  }
  if (input === false) return undefined;
  const base = envOptions(env);
  if (input === true) return createQueryLogger(base ?? {});
  if (typeof input === "string")
    return createQueryLogger({ ...(base ?? {}), format: input });
  return createQueryLogger({ ...(base ?? {}), ...input });
}

// --- rendering ---------------------------------------------------------------------------------

/** The emoji for an event (explain wins; then operation; then the statement verb). */
function iconOf(event: QueryLogEvent): string {
  if (event.phase === "explain") return "🔎";
  const byOperation = event.operation
    ? ICON_BY_OPERATION[event.operation]
    : undefined;
  if (byOperation) return byOperation;
  const verb = event.statements[0]?.sql
    ? firstVerb(event.statements[0].sql)
    : undefined;
  return (verb && ICON_BY_VERB[verb]) || "▸";
}

/** The operation label (`findMany`, `EXPLAIN findMany`). */
function operationLabel(event: QueryLogEvent): string {
  const operation =
    event.operation ?? firstVerb(event.statements[0]?.sql ?? "") ?? "query";
  return event.phase === "explain" ? `EXPLAIN ${operation}` : operation;
}

/** Format a duration in ms (`0.42ms`, `12.4ms`, `120ms`, `1.20s`). */
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  if (ms >= 10) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(2)}ms`;
}

/** A compact `HH:MM:SS.mmm` (UTC) label for an event's timestamp. */
function clock(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 23);
}

/** The `N rows` / `count N` summary across the OK results, when any result reports one. */
function rowLabel(event: QueryLogEvent): string | undefined {
  const counted = event.results.filter(
    (r) => r.status === "OK" && r.count !== undefined,
  );
  if (counted.length > 0) {
    const total = counted.reduce((sum, r) => sum + (r.count ?? 0), 0);
    return `count ${total}`;
  }
  const known = event.results.filter(
    (r) => r.status === "OK" && r.rows !== undefined,
  );
  if (known.length === 0) return undefined;
  const rows = known.reduce((sum, r) => sum + (r.rows ?? 0), 0);
  return `${rows} ${rows === 1 ? "row" : "rows"}`;
}

/** The statement text shown in a frame (the `EXPLAIN ` probe prefix is redundant under the title). */
function displaySql(sql: string, phase: QueryLogEvent["phase"]): string {
  return phase === "explain" ? sql.replace(/^\s*EXPLAIN\s+/i, "") : sql;
}

/** A JSON-safe rendering of one bound value (used by the `json` format). */
function jsonSafe(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (isRecordId(value) || isStringly(value)) return String(value);
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v, seen);
  return out;
}

/** A value that stringifies meaningfully (RecordId, Table, Uuid, Duration, Decimal, Geometry). */
function isStringly(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return (
    name === "RecordId" ||
    name === "Table" ||
    name === "Uuid" ||
    name === "Duration" ||
    name === "Decimal" ||
    name === "Geometry" ||
    name === "BoundQuery"
  );
}

const isRecordId = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "tb" in value && "id" in value;

/** Colour + truncate one bound value for the pretty/compact formats. */
function renderValue(value: unknown, palette: Palette, maxLen: number): string {
  const text = valueText(value);
  const clipped = text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  const code =
    value === null || value === undefined
      ? "\x1b[2m"
      : typeof value === "string"
        ? "\x1b[32m"
        : typeof value === "number" || typeof value === "bigint"
          ? "\x1b[36m"
          : typeof value === "boolean"
            ? "\x1b[33m"
            : value instanceof Date || isStringly(value)
              ? "\x1b[96m"
              : "\x1b[35m";
  return palette.paint(code, clipped);
}

/** A readable string for one value (`null`, `"str"`, `42`, `table:id`, `{…}`, `[circular]`). */
function valueText(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (isRecordId(value) || isStringly(value)) return String(value);
  return JSON.stringify(jsonSafe(value)) ?? String(value);
}

/** The `$p0 = 18  $p1 = "abc"` line of a statement's binds. */
function bindsLine(
  vars: Record<string, unknown>,
  palette: Palette,
  maxLen: number,
): string | undefined {
  const keys = Object.keys(vars);
  if (keys.length === 0) return undefined;
  const parts = keys.map(
    (key) =>
      `${palette.paint("\x1b[90m", `$${key} =`)} ${renderValue(vars[key], palette, maxLen)}`,
  );
  return parts.join("  ");
}

/** The framed pretty output for one event. */
function renderPretty(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string[] {
  const icon = opts.icons ? `${iconOf(event)} ` : "";
  let title = `${icon}${operationLabel(event)}`;
  if (event.table) title += ` · ${event.table}`;

  const body: string[] = [];
  event.statements.forEach((statement, index) => {
    if (index > 0) body.push("");
    body.push(
      ...sqlLines(
        displaySql(statement.sql, event.phase),
        palette,
        opts.prettySql,
      ),
    );
    const binds = bindsLine(statement.vars, palette, opts.maxValueLength);
    if (binds) body.push(binds);
  });
  if (event.context)
    body.push(
      palette.paint(
        "\x1b[90m",
        `ns/${event.context.namespace} · db/${event.context.database}`,
      ),
    );
  if (event.plans && event.plans.length > 0) {
    body.push(palette.paint("\x1b[2m", "plan"));
    for (const plan of event.plans) body.push(...renderPlan(plan, palette));
  }
  if (event.preview && event.preview.length > 0) {
    body.push(palette.paint("\x1b[2m", "rows"));
    for (const row of event.preview)
      body.push(
        `${palette.paint("\x1b[90m", "↳")} ${renderValue(row, palette, opts.maxValueLength)}`,
      );
  }
  if (event.error !== undefined)
    body.push(...errorLines(event.error, palette, opts.stack));

  return box(title, body, footer(event, opts, palette, counter));
}

/** The footer meta: `rows · duration [🐌 SLOW] · #n · time`. */
function footer(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string {
  const parts: string[] = [];
  const rows = rowLabel(event);
  if (rows) parts.push(rows);
  const slow = event.durationMs >= opts.slowMs;
  parts.push(
    palette.paint(slow ? "\x1b[31m" : "\x1b[32m", formatMs(event.durationMs)),
  );
  if (slow) parts.push(palette.paint("\x1b[33m", "🐌 SLOW"));
  if (opts.counter) parts.push(`#${counter}`);
  if (opts.time) parts.push(clock(event.time));
  return parts.join(" · ");
}

/** Wrap `body` lines between box borders, padding each to the box width. */
function box(title: string, body: readonly string[], foot: string): string[] {
  const titleW = visibleWidth(title);
  const footW = visibleWidth(foot);
  const bodyW = body.reduce(
    (max, line) => Math.max(max, visibleWidth(line)),
    0,
  );
  const width = Math.max(MIN_BOX_WIDTH, titleW + 2, footW + 2, bodyW);
  const lines = [`╭─ ${title} ${"─".repeat(Math.max(0, width - titleW - 1))}╮`];
  for (const line of body) lines.push(`│ ${padEnd(line, width)} │`);
  lines.push(`╰─ ${foot} ${"─".repeat(Math.max(0, width - footW - 1))}╯`);
  return lines;
}

/** The `⛔ [CODE] message` block (plus the stack when `stack` is on). */
function errorLines(
  error: unknown,
  palette: Palette,
  stack: boolean,
): string[] {
  const record = (error ?? {}) as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  const code = record.code ?? record.name ?? "Error";
  const message = record.message ?? String(error);
  const lines = [
    `${palette.paint("\x1b[1;31m", `⛔ [${String(code)}]`)} ${palette.paint("\x1b[31m", String(message))}`,
  ];
  if (stack && typeof record.stack === "string")
    for (const line of record.stack.split("\n").slice(1, 6))
      lines.push(palette.paint("\x1b[2m", line.trim()));
  return lines;
}

/** The one-line compact output. */
function renderCompact(
  event: QueryLogEvent,
  opts: ResolvedLoggerOptions,
  palette: Palette,
  counter: number,
): string {
  const icon = opts.icons ? `${iconOf(event)} ` : "";
  const parts: string[] = [`${icon}${operationLabel(event)}`];
  if (event.table) parts.push(event.table);
  const rows = rowLabel(event);
  if (rows) parts.push(rows);
  const slow = event.durationMs >= opts.slowMs;
  parts.push(
    palette.paint(slow ? "\x1b[31m" : "\x1b[32m", formatMs(event.durationMs)) +
      (slow ? palette.paint("\x1b[33m", " 🐌") : ""),
  );
  if (opts.counter) parts.push(`#${counter}`);
  const sql = event.statements
    .map((s) => displaySql(s.sql, event.phase).replace(/\s+/g, " ").trim())
    .join(" ");
  let line = `${parts.join(" · ")}  ${palette.paint("\x1b[2m", sql)}`;
  if (event.error !== undefined) {
    const record = event.error as { code?: unknown; message?: unknown };
    line += `  ${palette.paint(
      "\x1b[31m",
      `⛔ [${String(record.code ?? "Error")}] ${String(record.message ?? event.error)}`,
    )}`;
  }
  return line;
}

/** The JSON output (one line per event). */
function renderJson(event: QueryLogEvent, level: string): string {
  const rows = rowLabel(event);
  return JSON.stringify({
    level,
    time: new Date(event.time).toISOString(),
    phase: event.phase,
    operation: event.operation,
    table: event.table,
    durationMs: Math.round(event.durationMs * 1000) / 1000,
    transactional: event.transactional,
    inTransaction: event.inTransaction,
    ...(event.context
      ? {
          context: {
            namespace: event.context.namespace,
            database: event.context.database,
          },
        }
      : {}),
    statements: event.statements.map((s) => ({
      sql: s.sql,
      vars: jsonSafe(s.vars),
    })),
    results: event.results.map((r) => ({
      status: r.status,
      rows: r.rows,
      count: r.count,
      time: r.time,
    })),
    ...(rows ? { rows } : {}),
    ...(event.plans && event.plans.length > 0 ? { plans: event.plans } : {}),
    ...(event.preview && event.preview.length > 0
      ? { preview: event.preview.map((row) => jsonSafe(row)) }
      : {}),
    ...(event.error !== undefined
      ? {
          error: {
            name: (event.error as { name?: unknown }).name ?? "Error",
            code: (event.error as { code?: unknown }).code,
            message:
              (event.error as { message?: unknown }).message ??
              String(event.error),
          },
        }
      : {}),
  });
}
