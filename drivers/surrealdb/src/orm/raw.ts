/**
 * The raw escape hatches runtime — `$raw` (one statement), `$query` (many) and `$unsafe`.
 *
 * Every value is lowered by the SAME compiler primitives as the typed surface: a `${…}` in the
 * tagged template goes through `renderValue` (so a `BoundQuery`/`surql` fragment composes and a
 * plain value binds as `$p<n>`), and the executor merges the binds of every statement. Nothing is
 * ever concatenated into the statement text.
 *
 * `raw.timeoutMs` is applied ONLY to a single statement whose verb accepts `TIMEOUT`
 * (SELECT/UPDATE/CREATE/DELETE/INSERT/UPSERT/RELATE — live-probed on 3.2.0); anything else is left
 * untouched rather than risking a parse error. `raw.requireComment` demands `meta.comment` for a
 * WRITE script (a read-only script is exempt). `$unsafe` needs `raw.unsafe: true`.
 *
 * Raw is context-aware (`$withContext` prefixes `USE NS … DB …;`) and transaction-aware (inside
 * `client.transaction` the batch rides the open transaction).
 */
import type { BoundQuery } from "surrealdb";
import {
  type Binds,
  compileError,
  createBinds,
  describeValue,
  durationLiteral,
  isPlainObject,
  renderValue,
} from "./compiler/shared";
import { contextOption } from "./context";
import type { DelegateContext } from "./delegate";
import { runScript, terminate } from "./execute";
import { type StatementResult, statementResult } from "./results";
import type {
  RawDefaults,
  RawMeta,
  RawOptions,
  RawSource,
  RawStatements,
} from "./types/raw";

/** A tag bound to pre-set options: `$raw({ meta: { comment } })\`…\``. */
export type RawTag = <T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

/** A `$query` tag bound to pre-set options. */
export interface RawQueryTag {
  <T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly unknown[]>;
}

/** The `$raw`/`$query`/`$unsafe` methods a client exposes. */
export interface RawOperations {
  $raw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $raw<T>(source: RawSource, options?: RawOptions): Promise<T>;
  /** Curried form: pre-set the options and get the tag back (`$raw({ timeout })\`…\``). */
  $raw(options: RawOptions): RawTag;
  $query<T extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  $query<T extends readonly unknown[]>(
    source: RawSource,
    options?: RawOptions & { throwOnError?: true },
  ): Promise<T>;
  $query(
    source: RawSource,
    options: RawOptions & { throwOnError: false },
  ): Promise<RawStatements>;
  $query(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<readonly unknown[]>;
  $query(
    options: RawOptions & { throwOnError: false },
  ): (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<RawStatements>;
  /** Curried form: pre-set the options and get the tag back. */
  $query(options?: RawOptions & { throwOnError?: true }): RawQueryTag;
  $unsafe<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: RawOptions,
  ): Promise<T>;
}

/** Verbs whose statement accepts a trailing `TIMEOUT` (live-probed on SurrealDB 3.2.0). */
const TIMEOUT_VERBS = new Set([
  "SELECT",
  "UPDATE",
  "CREATE",
  "DELETE",
  "INSERT",
  "UPSERT",
  "RELATE",
]);

/** Verbs that make a script a WRITE (non-trivial) script for `raw.requireComment`. */
const WRITE_VERBS = new Set([
  "CREATE",
  "INSERT",
  "UPDATE",
  "UPSERT",
  "DELETE",
  "RELATE",
  "DEFINE",
  "REMOVE",
  "ALTER",
  "REBUILD",
  "KILL",
  "BEGIN",
  "COMMIT",
  "CANCEL",
]);

/** Build the raw operations over one client context. */
export function createRawOperations(
  ctx: DelegateContext,
  defaults: RawDefaults | undefined,
): RawOperations {
  /** Run a raw script: prefix the scope, keep every user response (a script may hold N statements). */
  const run = async (
    script: string,
    vars: Record<string, unknown>,
    operation: string,
    options: RawOptions | undefined,
    throwOnError: boolean,
  ): Promise<{
    results: readonly unknown[];
    responses: readonly StatementResult<unknown>[];
  }> => {
    const sql = terminate(
      applyTimeout(script, options?.timeout ?? defaults?.timeoutMs),
    );
    assertComment(sql, options?.meta, defaults, operation);
    const raw = await runScript(ctx.conn, sql, {
      vars,
      ...contextOption(ctx),
      operation,
      debug: ctx.debug,
    });
    const responses = raw.map((response, index) =>
      statementResult<unknown>(response, {
        operation,
        statementIndex: index,
        surql: sql,
        vars: ctx.debug ? vars : undefined,
      }),
    );
    if (throwOnError) {
      const failure = responses.find((r) => r.status === "ERR");
      if (failure?.error) throw failure.error;
    }
    return {
      responses,
      results: responses.map((r) => (r.status === "OK" ? r.result : undefined)),
    };
  };

  /** Build the tag for the curried form (`$raw({ meta })\`…\``), running with `options` bound. */
  const runTag = (
    options: RawOptions & { throwOnError?: boolean },
    operation: "$raw" | "$query",
  ) => {
    return (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
      const { sql, vars } = compileSource(strings, values, operation);
      if (operation === "$raw")
        return run(sql, vars, operation, options, true).then(
          (out) => out.results[0],
        );
      const throwOnError = options.throwOnError !== false;
      return run(sql, vars, operation, options, throwOnError).then((out) =>
        throwOnError ? out.results : out.responses,
      );
    };
  };

  const $raw = (
    first: RawSource | TemplateStringsArray | RawOptions,
    ...rest: unknown[]
  ): unknown => {
    if (isOptions(first)) return runTag(first, "$raw");
    const options = isTemplate(first)
      ? undefined
      : (rest.pop() as RawOptions | undefined);
    const { sql, vars } = compileSource(first, rest, "$raw");
    return run(sql, vars, "$raw", options, true).then((out) => out.results[0]);
  };

  const $query = (
    first:
      | RawSource
      | TemplateStringsArray
      | (RawOptions & { throwOnError?: boolean }),
    ...rest: unknown[]
  ): unknown => {
    if (isOptions(first)) return runTag(first, "$query");
    // The last argument of the call form is the options object; a template has none.
    const options = isTemplate(first)
      ? undefined
      : (rest.pop() as (RawOptions & { throwOnError?: boolean }) | undefined);
    const { sql, vars } = compileSource(first, rest, "$query");
    const throwOnError = options?.throwOnError !== false;
    return run(sql, vars, "$query", options, throwOnError).then((out) =>
      throwOnError ? out.results : out.responses,
    );
  };

  const $unsafe = (
    sql: string,
    params?: Record<string, unknown>,
    options?: RawOptions,
  ): Promise<unknown> => {
    if (defaults?.unsafe !== true)
      throw compileError(
        "UnsafeDisabled",
        `$unsafe is disabled — enable it with betterSchemic(conn, { schema, raw: { unsafe: true } }). Prefer $raw/$query, which parameterize every value.`,
        { operation: "$unsafe" },
      );
    if (typeof sql !== "string" || sql.trim().length === 0)
      throw compileError(
        "ValidationError",
        "$unsafe needs a non-empty SurrealQL string.",
        { operation: "$unsafe" },
      );
    return run(sql, params ?? {}, "$unsafe", options, true).then(
      (out) => out.results[0],
    );
  };

  return { $raw, $query, $unsafe } as RawOperations;
}

/** Lower a template tag or a `string`/`BoundQuery` source into `{ sql, vars }`. */
function compileSource(
  first: RawSource | TemplateStringsArray,
  rest: readonly unknown[],
  operation: string,
): { sql: string; vars: Record<string, unknown> } {
  const binds = createBinds();
  if (isTemplate(first)) return template(first, rest, binds, operation);
  if (typeof first === "string") {
    if (first.trim().length === 0)
      throw compileError(
        "ValidationError",
        `${operation} needs a non-empty SurrealQL string.`,
        { operation },
      );
    return { sql: first, vars: {} };
  }
  if (isBoundQuery(first)) {
    const vars = { ...first.bindings };
    return { sql: first.query, vars };
  }
  throw compileError(
    "ValidationError",
    `${operation} accepts a tagged template, a SurrealQL string, or a BoundQuery (surql\`…\`) — got ${describeValue(first)}.`,
    { operation },
  );
}

const isTemplate = (v: unknown): v is TemplateStringsArray =>
  Array.isArray(v) && "raw" in (v as object);

const isBoundQuery = (v: unknown): v is BoundQuery =>
  typeof v === "object" && v !== null && "query" in v && "bindings" in v;

/** A raw-options object — the curried-tag form (not a template, string or `BoundQuery`). */
const isOptions = (v: unknown): v is RawOptions =>
  isPlainObject(v) && !isBoundQuery(v);

/** Interpolate a tagged template: each value lowers (fragment splices, plain value binds). */
function template(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  binds: Binds,
  operation: string,
): { sql: string; vars: Record<string, unknown> } {
  let sql = strings[0] ?? "";
  for (const [i, value] of values.entries()) {
    sql += renderValue(value, binds, binds.ctx()) + (strings[i + 1] ?? "");
  }
  if (sql.trim().length === 0)
    throw compileError(
      "ValidationError",
      `${operation} needs a non-empty SurrealQL string.`,
      { operation },
    );
  return { sql, vars: binds.vars };
}

/** Append `TIMEOUT <duration>` when the script is a single statement with a capable verb. */
function applyTimeout(
  sql: string,
  timeout: number | string | undefined,
): string {
  if (timeout === undefined) return sql;
  const body = sql.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return sql;
  const verb = /^\s*([A-Za-z]+)/.exec(body)?.[1]?.toUpperCase();
  if (!verb || !TIMEOUT_VERBS.has(verb)) return sql;
  if (/\bTIMEOUT\b/i.test(body)) return sql;
  return `${body} TIMEOUT ${durationLiteral(timeout, "$raw")}`;
}

/** Enforce `raw.requireComment`: a raw WRITE script needs `meta.comment`. */
function assertComment(
  sql: string,
  meta: RawMeta | undefined,
  defaults: RawDefaults | undefined,
  operation: string,
): void {
  if (defaults?.requireComment !== true) return;
  const comment = meta?.comment;
  if (typeof comment === "string" && comment.trim().length > 0) return;
  if (!isWriteScript(sql)) return;
  throw compileError(
    "ValidationError",
    `${operation}: this is a write script and raw.requireComment is on — pass a reason as options.meta.comment.`,
    { operation, surql: sql },
  );
}

/** Does the script contain a statement whose verb is a write/DDL verb? */
function isWriteScript(sql: string): boolean {
  for (const raw of sql.split(";")) {
    const statement = stripLeadingComments(raw).trim();
    if (!statement) continue;
    const verb = /^([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();
    if (verb && WRITE_VERBS.has(verb)) return true;
  }
  return false;
}

/** Drop leading `--`/`//` comment lines so the first keyword is the verb. */
function stripLeadingComments(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("--") && !trimmed.startsWith("//");
    })
    .join("\n");
}
