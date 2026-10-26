/**
 * The ANSI palette behind the pretty renderer. A palette is a set of painter functions; when colors
 * are disabled every painter is the identity, so the renderer never branches on color and tests can
 * assert plain strings with `colors: false`.
 *
 * Color capability is resolved once (`"auto"` honours `NO_COLOR`/`FORCE_COLOR` and TTY detection).
 * Width helpers strip SGR sequences and approximate East-Asian/emoji width so the box borders line
 * up in a real terminal.
 */

/** A set of text painters (identity when disabled). */
export interface Palette {
  /** Whether the painters actually add ANSI codes. */
  readonly enabled: boolean
  readonly reset: string
  /** Paint `text` with a raw SGR sequence (no-op when disabled). */
  paint: (code: string, text: string) => string
}

/** Is a TTY/color-capable output present for the current process? */
export function detectColor(
  preference: boolean | "auto" | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (preference === true) return true
  if (preference === false) return false
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0")
    return true

  if (env.TERM === "dumb") return false
  const stream = process.stdout as { isTTY?: boolean } | undefined
  return stream?.isTTY === true
}

/** Build a palette; a disabled palette's `paint` returns its input unchanged. */
export function createPalette(enabled: boolean): Palette {
  return {
    enabled,
    reset: enabled ? "\u001B[0m" : "",
    paint: (code: string, text: string): string => (enabled ? `${code}${text}\u001B[0m` : text),
  }
}

const ANSI = /\u001B\[[0-9;]*m/g

/** Strip SGR sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/** Display width of one code point (approximate: combining → 0, emoji/CJK → 2, else 1). */
function codePointWidth(code: number): number {
  if (code === 0x20_0d) return 0
  // Zero-width joiner
  if (code >= 0xfe_00 && code <= 0xfe_0f) return 0
  // Variation selectors
  if (code >= 0x03_00 && code <= 0x03_6f) return 0
  // Combining diacritics
  if (code >= 0x1a_b0 && code <= 0x1a_ff) return 0
  // Combining extended
  if (code >= 0x1d_c0 && code <= 0x1d_ff) return 0
  // Combining supplement
  if (code >= 0x20_d0 && code <= 0x20_ff) return 0
  // Combining for symbols
  if (code >= 0xfe_20 && code <= 0xfe_2f) return 0
  // Combining half marks
  if (code < 0x20) return 0
  if (code >= 0x11_00 && code <= 0x11_5f) return 2
  // Hangul jamo
  if (code >= 0x2e_80 && code <= 0xa4_cf) return 2
  // CJK & friends
  if (code >= 0x26_00 && code <= 0x27_bf) return 2
  // Misc symbols / dingbats
  if (code >= 0x1_f0_00 && code <= 0x1_fa_ff) return 2
  // Emoji & symbols
  if (code >= 0x2b_00 && code <= 0x2b_ff) return 2
  // Arrows/stars
  return 1
}

/** Visible (rendered) width of a string, ignoring ANSI codes and accounting for wide glyphs. */
export function visibleWidth(text: string): number {
  let width = 0
  for (const ch of stripAnsi(text)) width += codePointWidth(ch.codePointAt(0)!)

  return width
}

/** Pad `text` with trailing spaces to `width` visible columns (never truncates). */
export function padEnd(text: string, width: number): string {
  const fill = width - visibleWidth(text)
  return fill > 0 ? text + " ".repeat(fill) : text
}
