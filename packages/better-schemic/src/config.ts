/**
 * `better-schemic/config` — the project config: `defineConfig` + the `surrealConnection` factory.
 *
 * ```ts
 * import { defineConfig, surrealConnection } from "better-schemic/config";
 *
 * export const betterSchemic = defineConfig({
 *   connections: {
 *     default: surrealConnection({
 *       schema: "./database/schema",
 *       url: process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc",
 *       namespace: "app",
 *       database: "app",
 *     }),
 *   },
 * });
 * ```
 *
 * `defineConfig` is the neutral engine's helper (it accepts any connection entry); `surrealConnection`
 * is the SurrealDB factory it pairs with. Both live here so a config file needs ONE import.
 */
export * from "./core/config"
export * from "./surreal/connection"
