/**
 * The MC/DC AST **decision inventory** — enumerate every MC/DC-relevant decision in the in-scope
 * sources with the same Rust parser the coverage instrumenter uses (`oxc-parser`), so the Tier-2
 * reconcile can require each decision be either Tier-1 `auto` (truthiness/branch coverage) or an
 * explicit `table` (`describeMcdc`) proof.
 *
 * A "decision" here is:
 *   - a logical operator (`&&` / `||` / `??`) — the operands are its conditions;
 *   - a conditional expression (`cond ? a : b`);
 *   - an `if` guard (its truth table is the branch).
 *
 * Loop guards (`while`/`do`/`for`) and `switch`/`default-arg` are NOT enumerated: MC/DC independence
 * does not apply to a loop's termination condition, and the instrumenter does not emit a branch for
 * them, so they would be permanent false "unknowns". Decisions are keyed by their START location
 * (`line:column`, 1-based line, 0-based column) so they can be matched against the instrumenter's
 * branch locations — oxc's `node.start` is a UTF-16 offset, the same unit the instrumenter reports.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";

/** One MC/DC-relevant decision and where it lives. */
export interface Decision {
  /** Absolute file path. */
  readonly file: string;
  /** 1-based line of the decision start. */
  readonly line: number;
  /** 0-based column of the decision start. */
  readonly column: number;
  readonly kind: "logical" | "ternary" | "guard";
}

/** The subset of an oxc/ESTree node the inventory walks — children are reached structurally. */
interface Node {
  type: string;
  start: number;
  end: number;
  operator?: string;
  [key: string]: unknown;
}

const LOGICAL_OPERATORS = new Set(["&&", "||", "??"]);

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** UTF-16 index of the start of every line — the offset → `line:column` mapping. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line, 0-based UTF-16 column of an offset. */
function positionAt(
  starts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] };
}

/** Enumerate the decisions in one already-parsed source file. */
export function decisionsInSourceFile(
  source: string,
  file: string,
): Decision[] {
  const { program, errors } = parseSync(file, source, {
    lang: "ts",
    sourceType: "unambiguous",
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`${file}: ${first?.message ?? "parse error"}`);
  }

  const starts = lineStarts(source);
  const byKey = new Map<string, Decision>();

  const add = (node: Node, kind: Decision["kind"]): void => {
    const pos = positionAt(starts, node.start);
    const key = `${pos.line}:${pos.column}`;
    // `a && b && c` parses as `(a && b) && c`; both nodes share a start, so dedupe to ONE decision
    // (matching the instrumenter, which flattens the chain into a single branch).
    if (!byKey.has(key))
      byKey.set(key, { file, line: pos.line, column: pos.column, kind });
  };

  const visit = (node: Node, insideLogical: boolean): void => {
    let nestedInLogical = insideLogical;
    if (
      node.type === "LogicalExpression" &&
      LOGICAL_OPERATORS.has(node.operator ?? "")
    ) {
      // Only the OUTERMOST logical of a chain: `A && (B || C) && D` is flattened by the instrumenter
      // into one branch, so an inner `||`/`&&` has no branch of its own (a false "unknown").
      if (!insideLogical) add(node, "logical");
      nestedInLogical = true;
    } else if (node.type === "ConditionalExpression") {
      add(node, "ternary");
    } else if (node.type === "IfStatement") {
      add(node, "guard");
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === "parent" ||
        key === "type" ||
        key === "start" ||
        key === "end"
      )
        continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (isNode(child)) visit(child, nestedInLogical);
      } else if (isNode(value)) {
        visit(value, nestedInLogical);
      }
    }
  };

  visit(program as unknown as Node, false);
  return [...byKey.values()];
}

/** Enumerate the decisions in one file (parsed on demand). */
export function inventoryFile(file: string): Decision[] {
  return decisionsInSourceFile(readFileSync(file, "utf8"), file);
}

/** Every `.ts` file (not `.d.ts`) under the given roots, recursively. */
export function inScopeFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(abs);
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}
