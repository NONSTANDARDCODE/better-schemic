/**
 * `better-schemic/plugin` — the zod-compiler Bun build plugin with better-schemic defaults.
 *
 * This compiles RAW Zod schemas found in the app (route contracts, DTOs, …) at build time, with no
 * `new Function` in the shipped bundle. `s.*` fields are wrappers around Zod schemas, so they are
 * compiled by `sc compile` instead — which knows how to unwrap `.schema` and preserves the
 * SurrealQL metadata. Use both: the plugin for plain Zod, `sc compile` for authored fields.
 *
 * ```ts
 * // bunfig.ts / build.ts
 * import { betterSchemic } from "better-schemic/plugin";
 * await Bun.build({ entrypoints: ["src/server.ts"], plugins: [betterSchemic()], compile: true });
 * ```
 */

import type { ZodCompilerPluginOptions } from "zod-compiler"
import zodCompilerBun from "zod-compiler/bun"

export type { ZodCompilerPluginOptions }

/** The raw `zod-compiler/bun` adapter, for when you need full control of its options. */
export { zodCompilerBun as bun }

/** Bun build plugin with the better-schemic defaults (`schemas: "auto"`, `output: "schema"`). */
export function betterSchemic(
  options: ZodCompilerPluginOptions = {},
): ReturnType<typeof zodCompilerBun> {
  return zodCompilerBun({
    schemas: "auto",
    output: "schema",
    ...options,
  })
}

export default betterSchemic
