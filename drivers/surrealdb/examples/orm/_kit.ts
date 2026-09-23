/**
 * Shared kit for the @better-schemic/surrealdb ORM REFERENCE cookbook (`examples/orm/*`).
 *
 * The schema-layer cookbook (`examples/*`) pairs authoring with the exact DDL it emits. The ORM has no
 * DDL — it emits **runtime SurrealQL** — so this folder is a SEPARATE catalog: each entry pairs the
 * delegate call with the exact `{ sql, vars }` it produces.
 *
 * Each entry declares its `def` (a REAL expression over a recording fake connection, so `tsc`
 * type-checks it) plus the golden `sql`/`vars`. The helper reads the file's own source to extract the
 * verbatim `def:` snippet for `code`, and `capture()` re-runs `def` against the fake connection — the
 * reference test asserts `capture(def) === { sql, vars }`, so `code`, the run, and the golden cannot
 * drift (the same honesty invariant the schema cookbook uses, with a runtime statement instead of DDL).
 *
 * Pure compile+run against a fake connection (NO live database). Round-trip behavior (decoded rows,
 * server semantics) is proven separately by `test/live/orm-*.test.ts`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { QueryResponse } from "surrealdb";
import { RecordId, Uuid } from "surrealdb";
import type { Client } from "../../src/orm/client";
import { betterSchemic } from "../../src/orm/client";
import type { Queryable } from "../../src/orm/execute";
import { schema } from "./_schema";

export type OrmClient = Client<typeof schema>;

/** The exact runtime SurrealQL a delegate call produces. */
export interface OrmStatement {
  /** The statement text (control statements separated by `\n`). */
  sql: string;
  /** The bound values (`$p0`, `$p1`, …), JSON-stable (`RecordId` → `table:id`). */
  vars: Record<string, unknown>;
}

/** One catalog entry: the delegate-call snippet, the golden statement, and a note. */
export interface OrmExample {
  /** The operation this entry demonstrates (also the test name). */
  title: string;
  /** Optional caveat — a divergence, a guard, or a `[~]`/`[ ]` note from ORM-COVERAGE.md. */
  note?: string;
  /** The verbatim `def` snippet, extracted from the example file's source (the website gallery renders this). */
  code: string;
  /** The delegate call, re-run by `capture` at test/generation time. */
  def: (client: OrmClient) => unknown;
  /** The exact SurrealQL the call emits (golden). */
  sql: string;
  /** The exact bindings the call emits (golden). */
  vars: Record<string, unknown>;
}

/** A named group of ORM examples (one source file in this folder). */
export interface OrmGroup {
  /** The file these examples live in (the test's `describe` label / the manifest group slug). */
  file: string;
  /** What the file covers. */
  about: string;
  examples: OrmExample[];
}

/** Advance `i` past a string/template literal starting at `src[i]` (the opening quote). */
function skipString(src: string, i: number, quote: string): number {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
      i += 2;
      let d = 1;
      while (i < src.length && d > 0) {
        if (src[i] === "{") d++;
        else if (src[i] === "}") d--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Extract the verbatim source of the `def:` property in an `ormExample(import.meta.url, { … def: <expr> })`
 * call — a balanced-delimiter scan from `def:` to its terminating `,`/closer at depth 0 (strings and
 * `${…}` templates skipped). `def` is authored LAST so the scan ends cleanly at the object's close.
 */
function extractDefSource(src: string): string {
  const m = /\bdef:\s*/.exec(src);
  if (!m)
    throw new Error(
      "orm example file has no `def:` property to render as `code`",
    );
  const start = m.index + m[0].length;
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, c);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
    i++;
  }
  return src
    .slice(start, i)
    .replace(/^[ \t]*\/\/ biome-ignore.*\r?\n/gm, "")
    .trim();
}

/**
 * Build an `OrmExample` from a real, tsc-checked example FILE. Pass `import.meta.url` so the helper
 * reads the file's own source and extracts the verbatim `def:` snippet; `def` is re-run by
 * {@link capture} at test/generation time, so `code`, the emitted statement, and the golden agree.
 */
export function ormExample(
  metaUrl: string,
  e: {
    title: string;
    note?: string;
    def: (client: OrmClient) => unknown;
    sql: string;
    vars?: Record<string, unknown>;
  },
): OrmExample {
  return {
    title: e.title,
    note: e.note,
    code: extractDefSource(readFileSync(fileURLToPath(metaUrl), "utf8")),
    def: e.def,
    sql: e.sql,
    vars: e.vars ?? {},
  };
}

/** Assemble a group from its per-file examples (one real `.ts` module each). */
export function group(
  file: string,
  about: string,
  examples: OrmExample[],
): OrmGroup {
  return { file, about, examples };
}

// --- capture --------------------------------------------------------------------------------------

const ok = (result: unknown): QueryResponse<unknown> => ({
  success: true,
  result,
  type: "other",
});

/** A recording fake connection — answers every statement, records the last `query()` call. */
function recordingConn(): {
  conn: Queryable;
  last: () => { sql: string; vars: Record<string, unknown> };
} {
  let last: { sql: string; vars: Record<string, unknown> } = {
    sql: "",
    vars: {},
  };
  const conn: Queryable = {
    query(sql: string, vars?: Record<string, unknown>) {
      last = { sql, vars: vars ?? {} };
      const responses = sql.split("\n").map((line) =>
        // A LIVE statement needs a live-query id back; every other statement is answered empty
        // (the capture only reads the compiled statement, never the rows).
        line.trimStart().startsWith("LIVE SELECT") ? ok([Uuid.v4()]) : ok([]),
      );
      return { responses: async () => responses };
    },
  } as unknown as Queryable;
  return { conn, last: () => last };
}

/** JSON-stable rendering of a bound value: `RecordId` → `table:id`, `Date` → ISO, plain recursively. */
export function renderBound(value: unknown): unknown {
  if (value instanceof RecordId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(renderBound);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderBound(v);
    return out;
  }
  return value;
}

/**
 * Re-run an example's `def` against the recording fake connection and return the normalized
 * `{ sql, vars }`. Reads are lazy, so `def`'s result is awaited (writes run eagerly; awaiting a write
 * result is a no-op). Nothing is mocked above the connection, so the captured SurrealQL is exactly
 * what ships.
 */
export async function capture(ex: OrmExample): Promise<OrmStatement> {
  const { conn, last } = recordingConn();
  const client = betterSchemic(conn, { schema }) as OrmClient;
  try {
    await ex.def(client);
  } catch {
    // A guarded operation may throw eagerly (a teaching error) — the statement is still recorded for
    // the ops that compile a plan before the guard fires. Swallow here; the reference test asserts on
    // `{ sql, vars }` for examples that capture cleanly, and on the code for guard examples.
  }
  const { sql, vars } = last();
  const rendered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) rendered[k] = renderBound(v);
  return { sql, vars: rendered };
}
