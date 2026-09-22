/**
 * The database-function runtime — `client.fn.call(name, args)` and one typed shortcut per
 * `defineFunction` entry.
 *
 * Calls are compiled to SurrealQL (`RETURN fn::name($p0, …)`) instead of the SDK's `run()`, because
 * `run()` is bound to the connection SESSION while a compiled statement can be scoped by a
 * `$withContext` clone (`USE NS … DB …;`) and rides an open transaction. Argument values are lowered
 * by the shared compiler primitives, so a `surql` fragment composes and a plain value binds.
 */
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

/** A function name: `name` or `ns::name` segments (validated — it is spliced, not bound). */
const FN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*$/;

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
      ...(context ? { context } : {}),
    });
    return out.rows[0];
  };

  const surface: Record<string, unknown> = { call };
  for (const [key, meta] of ctx.index.functions) {
    if (key === "call")
      throw compileError(
        "SchemaInvalid",
        'fn: a schema function key "call" would shadow client.fn.call — rename the function entry.',
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
  return surface as unknown as FnSurface;
}

/** `x` -> `fn::x`; `mod::x`/`fn::x` stay as written (validated against the segment grammar). */
function normalizeName(name: string): string {
  if (typeof name !== "string" || !FN_NAME.test(name))
    throw compileError(
      "ValidationError",
      `fn.call: "${String(name)}" is not a valid function name — use fn::<name> or <name> (letters, digits, _ and :: segments).`,
      { operation: "fn.call" },
    );
  return name.includes("::") ? name : `fn::${name}`;
}
