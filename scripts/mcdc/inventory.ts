/**
 * The MC/DC AST **decision inventory** — enumerate every MC/DC-relevant decision in the in-scope
 * sources using the TypeScript compiler API (already shipped as a devDependency), so the Tier-2
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
 * (`line:column`, 1-based line) so they can be matched against the instrumenter's branch locations.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

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

const LOGICAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

/** Enumerate the decisions in one already-parsed source file. */
export function decisionsInSourceFile(sf: ts.SourceFile): Decision[] {
  const byKey = new Map<string, Decision>();
  const isLogical = (node: ts.Node): boolean =>
    ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind);
  /** The outermost logical ancestor (the instrumenter flattens a whole logical chain into ONE branch). */
  const hasLogicalAncestor = (node: ts.Node): boolean => {
    for (let p = node.parent; p; p = p.parent) if (isLogical(p)) return true;
    return false;
  };
  const add = (node: ts.Node, kind: Decision["kind"]) => {
    const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const key = `${pos.line + 1}:${pos.character}`;
    // `a && b && c` parses as `(a && b) && c`; both nodes share a start, so dedupe to ONE decision
    // (matching the instrumenter, which flattens the chain into a single branch).
    if (!byKey.has(key))
      byKey.set(key, {
        file: sf.fileName,
        line: pos.line + 1,
        column: pos.character,
        kind,
      });
  };
  const visit = (node: ts.Node): void => {
    if (isLogical(node)) {
      // Only the OUTERMOST logical of a chain: `A && (B || C) && D` is flattened by the instrumenter
      // into one branch, so an inner `||`/`&&` has no branch of its own (a false "unknown").
      if (!hasLogicalAncestor(node)) add(node, "logical");
    } else if (ts.isConditionalExpression(node)) add(node, "ternary");
    else if (ts.isIfStatement(node)) add(node, "guard");
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return [...byKey.values()];
}

/** Enumerate the decisions in one file (parsed on demand). */
export function inventoryFile(file: string): Decision[] {
  const sf = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? "",
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  return decisionsInSourceFile(sf);
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
