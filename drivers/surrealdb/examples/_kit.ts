/**
 * Shared kit for the @better-schemic/surrealdb REFERENCE example cookbook.
 *
 * Each example is a REAL, tsc-checked `.ts` file under its group folder: `example(import.meta.url, {
 * title, note?, ddl, def })`. `def` is the actual authoring expression (so `tsc` type-checks every
 * example); the helper reads the file's own source and extracts the verbatim `def:` snippet for `code`
 * (what the website gallery renders), and `defs` come straight from `def` — so `code`, `defs`, and the
 * golden `ddl` cannot drift. `test/examples/reference.test.ts` asserts `emit(defs) === ddl`. See the
 * per-driver cookbook convention (packages/core/docs/EXAMPLE-COOKBOOK-CONVENTION.md).
 *
 * Pure-emit catalog (no live database) — it documents authoring -> DDL. Round-trip fidelity
 * (apply -> introspect -> diff = 0, and `pull` regeneration) is proven separately by the live parity
 * suites in `test/parity/*` against SurrealDB 3.1.3.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitDefStatement, emitTable } from "../src/ddl";
import { type StandaloneDef, TableDef } from "../src/pure";

/** A top-level schema object: a table/relation/view (a `TableDef`) or a standalone `define*`. */
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous example schemas — the Shape varies per table.
export type Definable = TableDef<string, any> | StandaloneDef;

/** One catalog entry: the authoring snippet, the schema objects it produces, and the SurrealQL golden. */
export interface Example {
  /** The feature / syntax this entry demonstrates (also the test name). */
  title: string;
  /** Optional caveat — round-trip behavior, a known gap, or a `[~]`/`[ ]` note from COVERAGE.md. */
  note?: string;
  /** The verbatim `def` snippet, extracted from the example file's source (the website gallery renders this). */
  code: string;
  /** The schema objects — the real `def` value from the example file. */
  defs: Definable[];
  /** The exact SurrealQL `defs` emit. Asserted by the reference test. */
  ddl: string;
}

/** A named group of examples (one source file in this folder). */
export interface ExampleGroup {
  /** The file these examples live in (for the test's `describe` label / the manifest group slug). */
  file: string;
  /** What the file covers. */
  about: string;
  examples: Example[];
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
    // A `${…}` template expression can itself hold braces/quotes — skip it balanced.
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
 * Extract the verbatim source of the `def:` property in an `example(import.meta.url, { … def: <expr> })`
 * call — a balanced-delimiter scan from `def:` to its terminating `,`/closer at depth 0 (strings and
 * `…` templates skipped), so a multi-line / nested / array def round-trips as the displayed snippet.
 * `def` is authored LAST so the scan ends cleanly at the object's close.
 */
function extractDefSource(src: string): string {
  const m = /\bdef:\s*/.exec(src);
  if (!m)
    throw new Error("example file has no `def:` property to render as `code`");
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
      if (depth === 0) break; // the closing `}` of the options object
      depth--;
    } else if (c === "," && depth === 0) break; // trailing comma after the def
    i++;
  }
  // Drop `// biome-ignore …` lines — tooling suppressions, never part of the displayed snippet.
  return src
    .slice(start, i)
    .replace(/^[ \t]*\/\/ biome-ignore.*\r?\n/gm, "")
    .trim();
}

/**
 * Build an `Example` from a real, tsc-checked example FILE. Pass `import.meta.url` so the helper reads
 * the file's own source and extracts the verbatim `def:` snippet for `code` (the website gallery renders
 * it); `defs` come from the real `def` value, so `code`, `defs`, and `ddl` still cannot drift apart.
 */
export function example(
  metaUrl: string,
  e: {
    title: string;
    note?: string;
    ddl: string;
    def: Definable | Definable[];
  },
): Example {
  return {
    title: e.title,
    note: e.note,
    code: extractDefSource(readFileSync(fileURLToPath(metaUrl), "utf8")),
    ddl: e.ddl,
    defs: Array.isArray(e.def) ? e.def : [e.def],
  };
}

/** Assemble a group from its per-file examples (one real `.ts` module each). */
export function group(
  file: string,
  about: string,
  examples: Example[],
): ExampleGroup {
  return { file, about, examples };
}

/**
 * Emit a set of definables to SurrealQL — tables/relations/views via `emitTable`, standalone `define*`
 * via `emitDefStatement` — joined with a blank line between each top-level object. This is the exact
 * function the reference test asserts against, and a handy "what does this produce?" helper.
 */
export function emit(defs: Definable[]): string {
  return defs
    .map((d) =>
      d instanceof TableDef ? emitTable(d) : emitDefStatement(d).ddl,
    )
    .join("\n\n");
}
