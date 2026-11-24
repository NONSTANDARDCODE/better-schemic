/**
 * The ANSI palette behind the pretty renderer. A palette is a set of painter functions; when colors
 * disabl them every painter is the identity, so the renderer never branches on color and tests can
 * assert plain strings with `colors: false`.
 *
 * Color capability resolves it once (`"auto"` honours `NO_COLOR`/`FORCE_COLOR` and TTY detection).
 * Width helpers strip SGR sequences and approximate East-Asian/emoji width so the box borders line
 * up in a real terminal.
 */

/** A set of text painters (identity when disabled). */
export type Palette = {
  /** Whether the painters actually add ANSI codes. */
  readonly enabled: boolean
  /** Paint `text` with a raw SGR sequence (no-op when disabled). */
  paint(code: string, text: string): string
  readonly reset: string
}

// Re-exported here for the renderer's existing imports; the implementation lives in its own module
// non-rendering observers never bundle the palette (see `detect-color.ts`).
export { detectColor } from "./detect-color"

/** Build a palette; a disabled palette's `paint` returns its input unchanged. */
export function createPalette(enabled: boolean): Palette {
  return {
    enabled,
    paint: (code: string, text: string): string => (enabled ? `${code}${text}\u001B[0m` : text),
    reset: enabled ? "\u001B[0m" : "",
  }
}

const ESCAPE_CODE = 27
const ANSI = new RegExp(`${String.fromCodePoint(ESCAPE_CODE)}\\[[0-9;]*m`, "gu")

/** Strip SGR sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

// Unicode ranges the width heuristic looks at. Named so the table stays readable and lint-clean.
const ZERO_WIDTH_JOINER = 8205
const VARIATION_SELECTOR_START = 65_024
const VARIATION_SELECTOR_END = 65_039
const COMBINING_DIACRITICS_START = 768
const COMBINING_DIACRITICS_END = 879
const COMBINING_EXTENDED_START = 6832
const COMBINING_EXTENDED_END = 6911
const COMBINING_SUPPLEMENT_START = 7616
const COMBINING_SUPPLEMENT_END = 7679
const COMBINING_SYMBOLS_START = 8400
const COMBINING_SYMBOLS_END = 8447
const COMBINING_FOR_SYMBOLS_START = 65_056
const COMBINING_FOR_SYMBOLS_END = 65_071
const CONTROL_END = 32
const HANGUL_JAMO_START = 4352
const HANGUL_JAMO_END = 4447
const CJK_START = 11_904
const CJK_END = 42_191
const MISC_SYMBOLS_START = 9728
const MISC_SYMBOLS_END = 10_175
const EMOJI_START = 126_976
const EMOJI_END = 129_791
const ARROWS_STARS_START = 11_008
const ARROWS_STARS_END = 11_263
const ZERO_WIDTH = 0
const DOUBLE_WIDTH = 2
const SINGLE_WIDTH = 1

/** Display width of one code point (approximate: combining → 0, emoji/CJK → 2, else 1). */
function codePointWidth(code: number): number {
  if (code === ZERO_WIDTH_JOINER) return ZERO_WIDTH
  // zero-width joiner
  if (code >= VARIATION_SELECTOR_START && code <= VARIATION_SELECTOR_END) return ZERO_WIDTH
  // variation selectors
  if (code >= COMBINING_DIACRITICS_START && code <= COMBINING_DIACRITICS_END) return ZERO_WIDTH
  // combining diacritics
  if (code >= COMBINING_EXTENDED_START && code <= COMBINING_EXTENDED_END) return ZERO_WIDTH
  // combining extended
  if (code >= COMBINING_SUPPLEMENT_START && code <= COMBINING_SUPPLEMENT_END) return ZERO_WIDTH
  // combining supplement
  if (code >= COMBINING_SYMBOLS_START && code <= COMBINING_SYMBOLS_END) return ZERO_WIDTH
  // combining for symbols
  if (code >= COMBINING_FOR_SYMBOLS_START && code <= COMBINING_FOR_SYMBOLS_END) return ZERO_WIDTH
  // combining half marks
  if (code < CONTROL_END) return ZERO_WIDTH

  if (code >= HANGUL_JAMO_START && code <= HANGUL_JAMO_END) return DOUBLE_WIDTH
  // hangul jamo
  if (code >= CJK_START && code <= CJK_END) return DOUBLE_WIDTH
  // CJK & friends
  if (code >= MISC_SYMBOLS_START && code <= MISC_SYMBOLS_END) return DOUBLE_WIDTH
  // misc symbols / dingbats
  if (code >= EMOJI_START && code <= EMOJI_END) return DOUBLE_WIDTH
  // emoji & symbols
  if (code >= ARROWS_STARS_START && code <= ARROWS_STARS_END) return DOUBLE_WIDTH
  // arrows/stars
  return SINGLE_WIDTH
}

/** Visible (rendered) width of a string, ignoring ANSI codes and accounting for wide glyphs. */
export function visibleWidth(text: string): number {
  // `u`-flag matching keeps surrogate pairs together, matching the original code-point iteration.
  return [...stripAnsi(text).matchAll(/[\s\S]/gu)].reduce(
    (width, match) => width + codePointWidth(match[0].codePointAt(0) ?? 0),
    0,
  )
}

/** Pad `text` with trailing spaces to `width` visible columns (never truncates). */
export function padEnd(text: string, width: number): string {
  const fill = width - visibleWidth(text)
  return fill > 0 ? text + " ".repeat(fill) : text
}
