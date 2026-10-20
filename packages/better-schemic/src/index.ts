/**
 * `better-schemic` — the authoring surface. Define tables/relations with `s.*` (a drop-in for
 * `z.*`) and map JS <-> DB across Zod's two channels via codecs (`decode`/`encode`).
 *
 * This entry is **side-effect-free**: importing it registers no driver and pulls in neither the
 * DDL emit engine nor the diff/migration engine, so `s.*` is safe in app bundles. The engine
 * surfaces live in subpaths:
 *   - `better-schemic/driver`     — the `Driver` impl + `emit*` + the `registerDriver` side-effect.
 *   - `better-schemic/connection` — the `surrealConnection` factory + connection config types.
 *   - `better-schemic/query`      — the opt-in typed query builder.
 *   - `better-schemic/orm`        — the repository-style ORM client.
 *   - `better-schemic/config`     — `defineConfig` (the project config).
 *
 * Zod is a DEPENDENCY of this package, not a peer: `s.*` extends Zod's builders, so a second
 * copy of Zod in the app would break `instanceof` checks inside Zod. If you need raw Zod, import
 * it from HERE (`import { z } from "./surreal"`) so there is exactly one copy.
 */
export * from "./surreal";
export * as z from "zod";
