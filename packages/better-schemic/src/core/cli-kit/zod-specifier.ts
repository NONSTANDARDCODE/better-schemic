/**
 * Pure helpers for retargeting zod-compiler's generated header.
 *
 * zod-compiler@2 bakes `from "zod"` and `from "zod/v4/core"` into generated files with no option to
 * change them. Rewriting those two specifiers to this package's own bridges keeps a single Zod copy
 * (instanceof-safe) and lets consumer apps drop their direct `zod` dependency.
 */

const DEFAULT_SPECIFIER = "better-schemic/zod"
const ZOD_RUNTIME = "zod"
const ZOD_CORE = "zod/v4/core"

interface ZodSpecifiers {
  core: string
  runtime: string
}

/** Resolve the runtime/core specifiers a given option produces in generated code. */
export function zodSpecifierOf(specifier?: string): ZodSpecifiers {
  const isOptOut = specifier === "" || specifier === ZOD_RUNTIME
  const runtime = isOptOut ? ZOD_RUNTIME : (specifier ?? DEFAULT_SPECIFIER)
  const core = runtime === ZOD_RUNTIME ? ZOD_CORE : `${runtime}/core`
  return { core, runtime }
}

/** Replace a module specifier in an import/export/from clause, preserving quotes and the rest. */
const rewriteClause = (source: string, from: string, to: string): string => {
  const pattern = new RegExp(`(\\b(?:from|import|export)\\s*)(["'])${from}\\2`, "gu")
  return source.replaceAll(
    pattern,
    (_match: string, prefix: string, quote: string) => `${prefix}${quote}${to}${quote}`,
  )
}

/** Rewrite zod-compiler's hardcoded specifiers; opt out with `"zod"` or `""`. */
export function rewriteZodSpecifiers(source: string, specifier?: string): string {
  const { core, runtime } = zodSpecifierOf(specifier)
  return runtime === ZOD_RUNTIME
    ? source
    : rewriteClause(rewriteClause(source, ZOD_CORE, core), ZOD_RUNTIME, runtime)
}
