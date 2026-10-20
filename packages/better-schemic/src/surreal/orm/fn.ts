/**
 * The database-function runtime — `client.fn.call(name, args)` and one typed shortcut per
 * `defineFunction` entry.
 *
 * Calls are compiled to SurrealQL (`RETURN fn::name($p0, …)`) instead of the SDK's `run()`, because
 * `run()` is bound to the connection SESSION while a compiled statement can be scoped by a
 * `$withContext` clone (`USE NS … DB …;`) and rides an open transaction. Argument values are lowered
 * by the shared compiler primitives, so a `surql` fragment composes and a plain value binds.
 */
import { Surql } from "../frag";
import { normalizeFnName } from "../fn-name";
import {
  compileError,
  createBinds,
  describeValue,
  isPlainObject,
  renderValue,
} from "./compiler/shared";
import { resolveContext } from "./context";
import type { DelegateContext } from "./delegate";
import { execute } from "./execute";
import type { FnSurface } from "./types/fn";

/** Build `client.fn` over one client context (dynamic `call` + the schema shortcuts). */
export function createFnOperations(ctx: DelegateContext): FnSurface {
  const call = async (
    name: string,
    args: readonly unknown[] = [],
  ): Promise<unknown> => {
    const fn = normalizeName(name);
    if (!Array.isArray(args))
      throw compileError(
        "ValidationError",
        `fn.call("${name}"): args must be an array (got ${describeValue(args)}).`,
        { operation: "fn.call" },
      );
    const binds = createBinds();
    const callArgs = args.map((arg) => renderValue(arg, binds, binds.ctx()));
    const sql = `RETURN ${fn}(${callArgs.join(", ")})`;
    const context = resolveContext(ctx);
    const out = await execute(ctx.conn, {
      statements: [{ sql, vars: binds.vars }],
      operation: "fn.call",
      debug: ctx.debug,
      ...(ctx.inTransaction === true ? { inTransaction: true } : {}),
      logger: ctx.logger,
      ...(context ? { context } : {}),
    });
    return out.rows[0];
  };

  // The EXPRESSION form: the same catalog, lowered to a fragment instead of executed — so a repo's
  // own `fn::…` (or anything `fn.call` can name) composes INSIDE a typed read, with no round-trip
  // and no hand-written `$query`: `where: { name: { equals: client.fn.expr.normalize({ name: "…" }) } }`.
  // Each fragment owns its binds; `renderValue` merges them into whatever statement composes it.
  const exprCall = (name: string, args: readonly unknown[] = []): Surql => {
    const local = createBinds();
    const sql = `${normalizeName(name)}(${args
      .map((arg) => renderValue(arg, local, local.ctx()))
      .join(", ")})`;
    return new Surql<unknown[]>(sql, local.vars);
  };

  // ONE walk over the catalog builds BOTH surfaces. They differ only in what a call resolves to — a
  // round-trip or a fragment — so the named-arg mapping, the object guard and the error text live
  // here once (`shortcut`), and adding a function cannot land on one surface but not the other.
  const surface: Record<string, unknown> = { call };
  const expr: Record<string, unknown> = { call: exprCall };
  /** The `fn::<name>` a schema entry lowers to, plus its declared argument names. */
  const shortcut = (
    key: string,
    meta: { name: string; args: ReadonlyMap<string, unknown> },
  ) => ({
    name: `fn::${meta.name}`,
    args: [...meta.args.keys()],
    key,
  });
  for (const [key, meta] of ctx.index.functions) {
    // `call`/`expr` are the surface's own entry points; a schema entry with either key would be
    // shadowed (or would shadow) them.
    if (key === "call" || key === "expr")
      throw compileError(
        "SchemaInvalid",
        `fn: a schema function key "${key}" would shadow client.fn.${key} — rename the function entry.`,
        { operation: "fn.call" },
      );
    const entry = shortcut(key, meta);
    surface[key] = (args?: unknown): Promise<unknown> =>
      call(entry.name, positionalArgs(entry, args, `fn.${key}`));
    expr[key] = (args?: unknown): Surql =>
      exprCall(entry.name, positionalArgs(entry, args, `fn.expr.${key}`));
  }
  surface.expr = expr;

  return surface as unknown as FnSurface;
}

/** One schema entry, as the typed shortcut needs it. */
interface Shortcut {
  readonly key: string;
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * A typed shortcut's arguments: NAMED (the schema declares them) in declaration order, so
 * `fn.customerTier({ total })` lowers to `fn::customer_tier($p0)`. `label` names the surface in the
 * error, so the call and expression forms point at the one the caller actually used.
 */
function positionalArgs(
  entry: Shortcut,
  args: unknown,
  label: string,
): unknown[] {
  if (entry.args.length === 0) return [];
  if (!isPlainObject(args))
    throw compileError(
      "ValidationError",
      `${label}: pass the arguments as an object, e.g. { ${entry.args.join(", ")} } (got ${describeValue(args)}).`,
      { operation: label.startsWith("fn.expr") ? "fn.expr" : "fn.call" },
    );
  return entry.args.map(
    (name) => (args as Record<string, unknown>)[name],
  );
}

/** `x` -> `fn::x`; `mod::x`/`fn::x` stay as written (validated against the segment grammar). */
function normalizeName(name: string): string {
  const normalized = normalizeFnName(name);
  if (normalized === undefined)
    throw compileError(
      "ValidationError",
      `fn.call: "${String(name)}" is not a valid function name — use fn::<name> or <name> (letters, digits, _ and :: segments).`,
      { operation: "fn.call" },
    );
  return normalized;
}
