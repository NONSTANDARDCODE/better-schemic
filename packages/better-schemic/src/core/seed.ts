/**
 * The context the seed runner hands to each seed as its second argument — a small filesystem helper
 * scoped to the seed's own directory, so a seed can load supporting files (raw `.surql`/`.sql`, JSON,
 * …) without an `import … with { type: "text" }` declaration or any `import.meta.url` path juggling.
 *
 * A driver types its `defineSeed(fn)` helper as `(db: Conn, ctx: SeedContext) => …`; the connection is
 * the driver's own type, this context is dialect-neutral.
 */
export interface SeedContext {
  /** Absolute path of the directory containing the running seed. */
  readonly dir: string;
  /** Read a supporting file (resolved relative to {@link SeedContext.dir}) as a UTF-8 string. */
  file(name: string): string;
}
