/**
 * Zod bridge for generated validator code.
 *
 * Re-export the SAME Zod instance from this package's own dependency, so a single copy loads and
 * application schemas share `instanceof` identity with generated validators. zod-compiler hardcodes
 * bare `"zod"` / `"zod/v4/core"` imports with no CLI flag to change them, so callers rewrite those to
 * `better-schemic/zod` (see `rewriteZodSpecifiers`); consumers then need no direct `zod` dependency.
 * This module has no side effects.
 */
export { config, z, ZodRealError } from "zod"
export * as core from "zod/v4/core"
