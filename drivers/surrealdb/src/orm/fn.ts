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

  const surface: Record<string, unknown> = { call };
  for (const [key, meta] of ctx.index.functions) {
    // `call`/`expr` are the surface's own entry points; a schema entry with either key would be
    // shadowed (or would shadow) them.
    if (key === "call" || key === "expr")
      throw compileError(
        "SchemaInvalid",
        `fn: a schema function key "${key}" would shadow client.fn.${key} — rename the function entry.`,
        { operation: "fn.call" },
      );
    const names = [...meta.args.keys()];
    surface[key] = (args?: unknown): Promise<unknown> => {
      if (names.length > 0 && !isPlainObject(args))
        throw compileError(
          "ValidationError",
          `fn.${key}: pass the arguments as an object, e.g. { ${names.join(", ")} } (got ${describeValue(args)}).`,
          { operation: "fn.call" },
        );
      const positional = names.map(
        (name) => (args as Record<string, unknown> | undefined)?.[name],
      );
      return call(`fn::${meta.name}`, positional);
    };
  }

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
  const expr: Record<string, unknown> = { call: exprCall };
  for (const [key, meta] of ctx.index.functions) {
    const names = [...meta.args.keys()];
    expr[key] = (args?: unknown): Surql => {
      if (names.length > 0 && !isPlainObject(args))
        throw compileError(
          "ValidationError",
          `fn.expr.${key}: pass the arguments as an object, e.g. { ${names.join(", ")} } (got ${describeValue(args)}).`,
          { operation: "fn.expr" },
        );
      const positional = names.map(
        (name) => (args as Record<string, unknown> | undefined)?.[name],
      );
      return exprCall(`fn::${meta.name}`, positional);
    };
  }
  surface.expr = expr;

  return surface as unknown as FnSurface;
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
