/**
 * The database-function runtime — `client.fn.call(name, args)` and one typed shortcut per
 * `defineFunction` entry.
 *
 * Calls compile them to SurrealQL (`RETURN fn::name($p0, …)`) instead of the SDK's `run()`, because
 * `run()` binds it to the connection SESSION while a compiled statement can scops it by a
 * `$withContext` clone (`USE NS … DB …;`) and rides an open transaction. Argument values lower them
 * by the shared compiler primitives, so a `surql` fragment composes and a plain value binds.
 */

import { normalizeFnName } from "../fn-name"
import { Surql } from "../frag"

import {
  compileError,
  createBinds,
  describeValue,
  isPlainObject,
  renderValue,
} from "./compiler/shared"
import { resolveContext } from "./context"
import type { DelegateContext } from "./delegate"
import { execute } from "./execute"
import type { FnSurface } from "./types/fn"

/** The EXPRESSION form: the same catalog lowered to a fragment instead of an executed call. */
function exprCall(name: string, args: readonly unknown[] = []): Surql {
  const local = createBinds()
  const sql = `${normalizeName(name)}(${args
    .map((arg) => renderValue(arg, local, local.ctx()))
    .join(", ")})`
  return new Surql<unknown[]>(sql, local.vars)
}

/** The `fn::<name>` a schema entry lowers to, plus its declared argument names. */
function shortcut(key: string, meta: { args: ReadonlyMap<string, unknown>; name: string }) {
  return {
    args: [...meta.args.keys()],
    key,
    name: `fn::${meta.name}`,
  }
}

/** Build `client.fn` over one client context (dynamic `call` + the schema shortcuts). */
export function createFnOperations(ctx: DelegateContext): FnSurface {
  const call = async (name: string, args: readonly unknown[] = []): Promise<unknown> => {
    const fn = normalizeName(name)
    if (!Array.isArray(args)) {
      throw compileError(
        "ValidationError",
        `fn.call("${name}"): args must be an array (got ${describeValue(args)}).`,
        { operation: "fn.call" },
      )
    }
    const binds = createBinds()
    const callArgs = args.map((arg) => renderValue(arg, binds, binds.ctx()))
    const sql = `RETURN ${fn}(${callArgs.join(", ")})`
    const context = resolveContext(ctx)
    const out = await execute(ctx.conn, {
      debug: ctx.debug,
      operation: "fn.call",
      statements: [{ sql, vars: binds.vars }],
      ...(ctx.inTransaction === true ? { inTransaction: true } : {}),
      logger: ctx.logger,
      ...(context ? { context } : {}),
    })
    return out.rows[0]
  }

  // ONE walk over the catalog builds BOTH surfaces. They differ in what a call resolves to — a
  // round-trip or a fragment — so the named-arg mapping, the object guard and the error text live
  // here once (`shortcut`), and adding a function cannot land on one surface but not the other.
  const surface: Record<string, unknown> = { call }
  const expr: Record<string, unknown> = { call: exprCall }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [key, meta] of ctx.index.functions) {
    // `call`/`expr` are the surface's own entry points; a schema entry with either key would be
    // shadowed (or would shadow) them.
    if (key === "call" || key === "expr") {
      throw compileError(
        "SchemaInvalid",
        `fn: a schema function key "${key}" would shadow client.fn.${key} — rename the function entry.`,
        { operation: "fn.call" },
      )
    }
    const entry = shortcut(key, meta)
    surface[key] = (args?: unknown): Promise<unknown> =>
      call(entry.name, positionalArgs(entry, args, `fn.${key}`))
    expr[key] = (args?: unknown): Surql =>
      exprCall(entry.name, positionalArgs(entry, args, `fn.expr.${key}`))
  }
  surface.expr = expr

  return surface as unknown as FnSurface
}

/** One schema entry, as the typed shortcut needs it. */
type Shortcut = {
  readonly args: readonly string[]
  readonly key: string
  readonly name: string
}

/**
 * A typed shortcut's arguments: NAMED (the schema declares them) in declaration order, so
 * `fn.customerTier({ total })` lowers to `fn::customer_tier($p0)`. `label` names the surface in the
 * error, so the call and expression forms point at the one the caller actually used.
 */
function positionalArgs(entry: Shortcut, args: unknown, label: string): unknown[] {
  if (entry.args.length === 0) return []

  if (!isPlainObject(args)) {
    throw compileError(
      "ValidationError",
      `${label}: pass the arguments as an object, e.g. { ${entry.args.join(", ")} } (got ${describeValue(args)}).`,
      { operation: label.startsWith("fn.expr") ? "fn.expr" : "fn.call" },
    )
  }
  return entry.args.map((name) => args[name])
}

/** `x` -> `fn::x`; `mod::x`/`fn::x` stay as written (validated against the segment grammar). */
function normalizeName(name: string): string {
  const normalized = normalizeFnName(name)
  if (normalized === undefined) {
    throw compileError(
      "ValidationError",
      `fn.call: "${name}" is not a valid function name — use fn::<name> or <name> (letters, digits, _ and :: segments).`,
      { operation: "fn.call" },
    )
  }
  return normalized
}
