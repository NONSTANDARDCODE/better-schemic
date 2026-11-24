/**
 * `better-schemic/aot` — the bridge to [zod-compiler](https://github.com/gajus/zod-compiler).
 *
 * `s.*` fields are NOT Zod instances: they are `SField` wrappers holding a Zod schema in
 * `.schema` plus the SurrealQL metadata (`.native`). zod-compiler compiles the UNDERLYING Zod
 * schema in place (identity-preserving), so the wrapper, the DDL metadata, `.shape`, `instanceof`
 * and the ORM all keep working —  validation gets the generated fast path.
 *
 * This module is the public, side-effect-free half. The build-time generation lives in
 * `sc compile` (`src/cli/compile.ts`) and the bundler adapters in `better-schemic/plugin`.
 */

import type { z } from "zod"
import { compile as zodCompile, isCompiledSchema } from "zod-compiler"

import { type AnyField, SField } from "./surreal"

export type { CompiledSchema } from "zod-compiler"
export { isCompiledSchema } from "zod-compiler"

/** Unwrap an authored field to the Zod schema that actually validates it. Raw Zod schemas are
 *  accepted too — `Shape` allows them alongside `s.*` fields. */
export function fieldSchemaOf(field: AnyField | z.ZodType): z.ZodType {
  return field instanceof SField ? field.schema : field
}

/**
 * Dev-time marker (no generated fast path yet): tags a field's Zod schema so zod-compiler's
 * `check` can see it, preserving identity. Run `sc compile` for the real AOT code.
 */
export function markFieldCompiled(field: AnyField | z.ZodType): z.ZodType {
  return zodCompile(fieldSchemaOf(field) as never) as z.ZodType
}

/** Whether a field's underlying Zod schema has gone through zod-compiler. */
export function isFieldCompiled(field: AnyField | z.ZodType): boolean {
  return isCompiledSchema(fieldSchemaOf(field))
}

/**
 * Compile a field's Zod schema IN PROCESS (dev/JIT fallback — identity-preserving).
 * Prefer `sc compile`, which emits static validators with no `new Function` at runtime.
 */
export function compileField(field: AnyField | z.ZodType): z.ZodType {
  return zodCompile(fieldSchemaOf(field) as never) as z.ZodType
}
