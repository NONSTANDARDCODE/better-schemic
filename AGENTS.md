# better-schemic — repo guide for agents

better-schemic is a **schema-as-code** toolkit for **SurrealDB**: author your database schema in TypeScript,
generate SurrealQL DDL, and manage migrations. Monorepo (bun workspaces, `packages/*`).
A SurrealDB-only fork of [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) — see `CHANGELOG.md` for the
fork notice and `CHANGELOG_OLD.md` for the pre-fork history.

**ONE runtime package.** `better-schemic` (in `packages/better-schemic`) holds everything the app
and the CLI need:

```
packages/better-schemic/src/
  core/      the dialect-neutral engine (the `Driver` contract + the portable schema IR + the
             migration/diff/snapshot engine) — an INTERNAL seam, not a package boundary
  cli/       the `better-schemic`/`sc` bin
  surreal/   the SurrealDB half: authoring (`s.*`), DDL emit, introspection, the ORM
```

`create-better-schemic` is the second package — the scaffolder (`npm create better-schemic`). It
stays separate because npm resolves `create-*` by name and it must run BEFORE the project has
better-schemic installed.

**Package surface (purpose-based subpaths).** One package, so the boundaries are `exports` entries —
app code still bundles only what it imports:
- `better-schemic` — **authoring** (`s.*`, `define*`, the `surql` tag) — must be **side-effect-free**.
- `better-schemic/connection` — the `surrealConnection` factory.
- `better-schemic/query` — fragments & procedural SurrealQL (`block()`).
- `better-schemic/orm` — the repository-style ORM client (`betterSchemic`/`createBetterSchemic`,
  one delegate per schema entry, `repository`, `$sdk`).
- `better-schemic/config` — `defineConfig` (the project config).
- `better-schemic/logger` — the query logger (`createQueryLogger`, presets, env resolution).
- `better-schemic/otel` — OpenTelemetry tracing as a `QueryLogger` (`createOtelLogger`); the
  `@opentelemetry/api` peer is optional and an unattached logger costs nothing.
- `better-schemic/plugins/*` — the authoring plugins.
- `better-schemic/driver` — the `Driver` impl + `emit*`/`lower`/`introspect` + the **`registerDriver`
  side-effect** (CLI/engine-only; keep `emit*` etc. OUT of the authoring index).
- `better-schemic/core` — the neutral engine barrel (internal seam; the CLI + driver build on it).

The CLI imports `/driver` once to register the built-in driver, so importing `s.*` never drags the
diff/emit engine into an app bundle. There is NO dynamic driver loading: the driver is built in and
`config.driver` is only metadata (the snapshot's owner tag). Zod and the SurrealDB SDK are
**dependencies** of the package (not peers) — `s.*` extends Zod's builders, so a second copy would
break `instanceof`; import raw Zod from `better-schemic` (`import { z } from "better-schemic"`) if
you need it. The neutral query toolkit was retired with the fluent builder — the `/orm` layer is
driver-owned and consumes the core client foundation (`OrmClientBase`, `asyncDisposable`) instead.

## Developer experience IS the product — always analyze through a DevEx lens

better-schemic is a **developer-focused product**: the authoring surface (`s.*`/`define*`) and the CLI ARE the
product, so DX *is* the deliverable. **Analyze every API, change, and review (code + coverage) through a
developer-experience lens** — is it type-safe, autocompletable, refactor-safe, hard to misuse, and obvious
at the call site? Treat stringly-typed escape hatches, undeclared "magic" variables, and silent-failure
APIs as **DX debt**: surface them and propose the strongly-typed form *even when the current behavior
already "works"*. This analysis is mandatory in every review, not optional polish.

## Landing + releases

Land a branch with **`bun scripts/land.ts <branch>`**: rebase onto `main`, fast-forward-merge,
**gate it** (typecheck + test the workspace — a red gate rolls `main` back and ships nothing), push
`main`, then delete the branch. **Landing ACCUMULATES — it does NOT deploy.** Releases are
**cut explicitly**: review the accumulated changes, then run **`bun scripts/release.ts next`**
(lockstep all packages to npm, skipping versions already published) + commit/push the version bumps + stamp the CHANGELOG. So changes pile
up on `main` between releases; nothing publishes until a release is cut. (`land.ts --deploy` land+ships
in one step — only for an immediate release.)

## Docs are part of the change — update them in the SAME PR

Docs are the product surface for a DX-first repo, so they go stale the moment code lands without
them. Every milestone/PR must leave the docs it touches consistent **in the same change** — never
"later", never a follow-up issue. Concretely:

- `ROADMAP.md` — flip the milestone/sub-item status and list the deliverables.
- `packages/better-schemic/docs/orm-syntax-map.md` — every live-verified SurrealQL fact the compiler emits
  (add the probe to `test/surreal/live/orm-syntax.test.ts` at the same time).
- `packages/better-schemic/README.md` — the user-facing example must compile against the CURRENT surface.
- `CHANGELOG.md` — an **Unreleased** entry (Added/Changed/Removed) for anything user-visible.
- `packages/better-schemic/docs/ORM-COVERAGE.md` / `COVERAGE.md` — the feature matrix (author→emit→…).
- `packages/better-schemic/examples/*` (authoring → DDL) and `examples/orm/*` (delegate call → runtime
  SurrealQL) — the verified catalogs; regenerate `examples-manifest.json` (`bun run gen:examples`)
  and `examples-manifest-orm.json` (`bun run gen:examples:orm`) whenever a cookbook changes.
- `packages/better-schemic/docs/engine/*`, `MULTI-CONNECTION.md`, `AGENTS.md` — only when the surface they describe changes.

A change that alters behavior/API without the matching doc update is **incomplete**; call it out in
review the same way a missing test would be.

## Driver coverage docs

The package keeps a **`docs/COVERAGE.md`** tracking **all** of SurrealDB's schema/DDL syntax
and the implementation status of each (author → emit → introspect → diff). Keep it **exhaustive** —
list features even when not yet implemented, so gaps stay visible rather than guessed.
