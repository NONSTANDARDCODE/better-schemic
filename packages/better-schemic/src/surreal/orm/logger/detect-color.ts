/**
 * Color-capability detection — the tiny, dependency-free half of the logger's palette. Kept in its
 * own module so a non-rendering observer (e.g. `better-schemic/otel`) can resolve the shared logger
 * defaults without pulling the ANSI palette / width helpers into its bundle.
 */

/**
 * Is a TTY/color-capable output present for the current process? `isTTY` is injectable so the
 * decision is deterministic in tests (a piped test runner and a real terminal differ).
 */
export function detectColor(
  preference: boolean | "auto" | undefined,
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = (process.stdout as { isTTY?: boolean }).isTTY === true,
): boolean {
  if (preference === true) return true;
  if (preference === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (
    env.FORCE_COLOR !== undefined &&
    env.FORCE_COLOR !== "" &&
    env.FORCE_COLOR !== "0"
  )
    return true;
  if (env.TERM === "dumb") return false;
  return isTTY;
}
