// ANSI styling, gated on a TTY and honoring NO_COLOR. No dependency.
/** ANSI SGR codes — protocol constants, not tuning values. */
enum Ansi {
  Bold = 1,
  Red = 31,
  Green = 32,
  Yellow = 33,
  Cyan = 36,
  Dim = 90,
}

/** Whether colored output enabls it (a TTY and `NO_COLOR` unset). */
export const colorEnabled = (): boolean | undefined => process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number, s: string): string =>
  colorEnabled() ? `\u001B[${code}m${s}\u001B[0m` : s

export const style = {
  bold: (s: string): string => paint(Ansi.Bold, s),
  cyan: (s: string): string => paint(Ansi.Cyan, s),
  dim: (s: string): string => paint(Ansi.Dim, s),
  green: (s: string): string => paint(Ansi.Green, s),
  red: (s: string): string => paint(Ansi.Red, s),
  yellow: (s: string): string => paint(Ansi.Yellow, s),
}

/** A green ✓ success line. */
export const ok = (s: string): string => `${style.green("✓")} ${s}`
/** A red ✗ failure line. */
export const fail = (s: string): string => `${style.red("✗")} ${s}`

/** Pluralize `n thing` / `n `. */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`
