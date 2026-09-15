import type { SeedContext } from "@better-schemic/core";
import type { Surreal } from "surrealdb";

/**
 * A seed function — receives the connected `Surreal` client and the {@link SeedContext} (a small
 * filesystem helper scoped to the seed's own directory).
 */
export type SeedFn = (db: Surreal, ctx: SeedContext) => void | Promise<void>;

/**
 * Type a `database/seed/*.ts` default export. An identity wrapper (like `defineConfig`): it returns the
 * callback unchanged but gives it full types — the SurrealDB client `db` and the seed `ctx` — with no
 * manual imports. The seed runner invokes it as `fn(db, ctx)`; `ctx.file("data.surql")` reads a file
 * next to the seed as a string (raw SurrealQL, JSON, …), `ctx.dir` is that directory.
 */
export function defineSeed(fn: SeedFn): SeedFn {
  return fn;
}
