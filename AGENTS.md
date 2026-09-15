# better-schemic — repo guide for agents

better-schemic is a **schema-as-code** toolkit for **SurrealDB**: author your database schema in TypeScript,
generate SurrealQL DDL, and manage migrations. Monorepo (bun workspaces, `packages/*` + `drivers/*`).
A SurrealDB-only fork of [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) — see `CHANGELOG.md` for the
fork notice and `CHANGELOG_OLD.md` for the pre-fork history.

Architecture: `@better-schemic/core` (dialect-neutral engine: the `Driver` contract + portable schema IR +
the migration/diff/snapshot engine) ← `@better-schemic/cli` (the `better-schemic`/`sc` bin, ZERO dialect code,
dynamic driver loading by `config.driver`) + the SurrealDB driver package (`@better-schemic/surrealdb`)
that owns connection + authoring (`s.*`) + DDL.

**Package surface (purpose-based subpaths).** Each driver splits its surface so app code only bundles
what it imports:
- `@better-schemic/<driver>` — **authoring** (`s.*`, `define*`, raw-body tag) — must be **side-effect-free**.
- `@better-schemic/<driver>/connection` — the connection factory.
- `@better-schemic/<driver>/query` — the opt-in query builder (composes `@better-schemic/core/query`).
- `@better-schemic/<driver>/driver` — the `Driver` impl + `emit*`/`lower`/`introspect` + the **`registerDriver`
  side-effect** (CLI/engine-only; keep `emit*` etc. OUT of the authoring index).

The CLI loader imports `/driver` to register (it **requires** the `/driver` entry — drivers >= alpha.21),
so importing `s.*` never drags the diff/emit engine into an app bundle. Core mirrors this:
`@better-schemic/core/query` is the neutral query toolkit (`Row`/`Project`/`decodeProjection`/`callFunction`).

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
(lockstep all packages to npm) + commit/push the version bumps + stamp the CHANGELOG. So changes pile
up on `main` between releases; nothing publishes until a release is cut. (`land.ts --deploy` land+ships
in one step — only for an immediate release.)

## Driver coverage docs

Each driver package keeps a **`docs/COVERAGE.md`** tracking **all** of its database's schema/DDL syntax
and the implementation status of each (author → emit → introspect → diff). Template + worked example:
**`packages/core/docs/DRIVER-COVERAGE.md`**. Keep it **exhaustive** — list features even when not yet
implemented, so gaps stay visible rather than guessed.
