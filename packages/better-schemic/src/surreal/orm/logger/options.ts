/**
 * The logger's option resolver — the ONE place the `LoggerOptions` defaults live. Kept apart from
 * the renderer so a non-rendering observer (e.g. `better-schemic/otel`) can honour the same
 * {@link QueryLogger} contract without pulling the pretty/json engines into its bundle.
 */
import type { LoggerOptions, ResolvedLoggerOptions } from "../types/logger"

import { detectColor } from "./detect-color"

const DEFAULT_MAX_ROWS = 3
const DEFAULT_MAX_VALUE_LENGTH = 160
const DEFAULT_SLOW_MS = 100

/** Resolve a defaulted options bag (env overrides merg them in by `resolveLogger`). */
export function resolveLoggerOptions(options: LoggerOptions = {}): ResolvedLoggerOptions {
  return {
    colors: detectColor(options.colors),
    counter: options.counter ?? true,
    explain: options.explain ?? false,
    format: options.format ?? "pretty",
    icons: options.icons ?? true,
    level: options.level ?? "debug",
    maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
    maxValueLength: options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH,
    prettySql: options.prettySql ?? true,
    redact: options.redact ?? false,
    slowMs: options.slowMs ?? DEFAULT_SLOW_MS,
    stack: options.stack ?? false,
    time: options.time ?? true,
    verbose: options.verbose ?? false,
    write:
      options.write ??
      ((line: string) => {
        console.log(line)
      }),
  }
}
