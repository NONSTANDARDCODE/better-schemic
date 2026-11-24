/** Narrow a value that a fixture's own assertions already guarantee is present. */
export function required<T>(value: null | T | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture value")
  return value
}
