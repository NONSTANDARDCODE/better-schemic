/**
 * The logger's option resolver — the ONE place the `LoggerOptions` defaults live. Kept apart from
 * the renderer so a non-rendering observer (e.g. `better-schemic/otel`) can honour the same
 * {@link QueryLogger} contract without pulling the pretty/json engines into its bundle.
 */
import type { LoggerOptions, ResolvedLoggerOptions } from "../types/logger";
import { detectColor } from "./detect-color";

/** Resolve a defaulted options bag (env overrides are merged in by `resolveLogger`). */
export function resolveLoggerOptions(
  options: LoggerOptions = {},
): ResolvedLoggerOptions {
  return {
    level: options.level ?? "debug",
    format: options.format ?? "pretty",
    colors: detectColor(options.colors),
    icons: options.icons ?? true,
    time: options.time ?? true,
    counter: options.counter ?? true,
    slowMs: options.slowMs ?? 100,
    verbose: options.verbose ?? false,
    maxRows: options.maxRows ?? 3,
    maxValueLength: options.maxValueLength ?? 160,
    prettySql: options.prettySql ?? true,
    explain: options.explain ?? false,
    stack: options.stack ?? false,
    redact: options.redact ?? false,
    write: options.write ?? ((line: string) => console.log(line)),
  };
}
