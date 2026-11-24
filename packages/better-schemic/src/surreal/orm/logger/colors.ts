/* eslint-disable @typescript-eslint/no-magic-numbers -- limites de intervalos Unicode são pontos de código documentados na tabela abaixo */
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

// eslint-disable-next-line no-control-regex -- ESC (\u001B) é a âncora intencional das sequências SGR ANSI
const ANSI = /\u001B\[[0-9;]*m/gu

/** Strip SGR sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "")
}

/** Display width of one code point (approximate: combining → 0, emoji/CJK → 2, else 1). */
function codePointWidth(code: number): number {
  if (code === 8205) return 0
  // zero-width joiner
  if (code >= 65_024 && code <= 65_039) return 0
  // variation selectors
  if (code >= 768 && code <= 879) return 0
  // combining diacritics
  if (code >= 6832 && code <= 6911) return 0
  // combining extended
  if (code >= 7616 && code <= 7679) return 0
  // combining supplement
  if (code >= 8400 && code <= 8447) return 0
  // combining for symbols
  if (code >= 65_056 && code <= 65_071) return 0
  // combining half marks
  if (code < 32) return 0

  if (code >= 4352 && code <= 4447) return 2
  // hangul jamo
  if (code >= 11_904 && code <= 42_191) return 2
  // CJK & friends
  if (code >= 9728 && code <= 10_175) return 2
  // misc symbols / dingbats
  if (code >= 126_976 && code <= 129_791) return 2
  // emoji & symbols
  if (code >= 11_008 && code <= 11_263) return 2
  // arrows/stars
  return 1
}

/** Visible (rendered) width of a string, ignoring ANSI codes and accounting for wide glyphs. */
export function visibleWidth(text: string): number {
  let width = 0
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const ch of stripAnsi(text)) width += codePointWidth(ch.codePointAt(0) ?? 0)

  return width
}

/** Pad `text` with trailing spaces to `width` visible columns (never truncates). */
export function padEnd(text: string, width: number): string {
  const fill = width - visibleWidth(text)
  return fill > 0 ? text + " ".repeat(fill) : text
}
