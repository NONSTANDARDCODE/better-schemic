/**
 * `better-schemic/config` — `defineConfig`, the project config entry point. A project declares
 * its named CONNECTIONS, each built by the `surrealConnection` factory:
 *
 * ```ts
 * import { defineConfig } from "./core/config";
 * import { surrealConnection } from "./surreal/connection";
 *
 * export const betterSchemic = defineConfig({
 *   connections: { default: surrealConnection({ schema: "./database/schema", url: "ws://localhost:8000" }) },
 * });
 * ```
 */
export * from "./core/config";
