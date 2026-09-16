<div align="center">

[Docs](https://github.com/NONSTANDARDCODE/better-schemic) &nbsp;•&nbsp; [Drivers](#drivers) &nbsp;•&nbsp; [GitHub](https://github.com/NONSTANDARDCODE/better-schemic)

[![npm](https://img.shields.io/npm/v/@better-schemic/cli)](https://www.npmjs.com/package/@better-schemic/cli) &nbsp; [![CI](https://github.com/NONSTANDARDCODE/better-schemic/actions/workflows/ci.yml/badge.svg)](https://github.com/NONSTANDARDCODE/better-schemic/actions/workflows/ci.yml) &nbsp; [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Better-schemic lets you define your database schema once in TypeScript — with the
**[Zod](https://zod.dev) API you already know** — and turns that single definition
into your database's native DDL, end-to-end types, and reviewable migrations.

The engine and CLI are **dialect-neutral**; **SurrealDB** is the supported
database driver. One source of truth — no separate ORM model, no code
generation, no drift.

## Drivers

- [`@better-schemic/surrealdb`](drivers/surrealdb#readme) — **SurrealDB**

## Packages

| Package | What it is |
| --- | --- |
| [`@better-schemic/core`](packages/core#readme) | The dialect-neutral engine: the `Driver` contract, the portable schema IR, and the migration / diff / snapshot engine. Zero dialect code. |
| [`@better-schemic/cli`](packages/cli#readme) | The `better-schemic` / `sc` binary — also dialect-neutral; loads the SurrealDB driver from `config.driver`. |
| [`@better-schemic/surrealdb`](drivers/surrealdb#readme) | The SurrealDB driver: connection, authoring, and SurrealQL DDL. |

## The workflow

Author your schema, then drive it from the dialect-neutral CLI (`sc` is the
short alias):

```bash
sc init        # scaffold a project: better-schemic.config.ts + schema + .env.example
sc diff        # preview changes vs the last snapshot   (--ts for a TypeScript view)
sc gen         # write a migration for the pending change
sc migrate     # apply pending migrations
sc status      # show applied vs pending migrations
sc pull        # introspect a live database back into TypeScript
```

The authoring API and the DDL it generates are documented in the
[SurrealDB driver's README](drivers/surrealdb#readme).

## Status

**Alpha (`0.x`).** APIs may still change.

- [x] **SurrealDB** driver — [coverage](drivers/surrealdb/docs/COVERAGE.md)

## Development

A [Bun](https://bun.com) workspaces monorepo (`packages/*`).

```bash
bun install
bun --filter '@better-schemic/*' test       # run every package's tests
bun --filter '@better-schemic/*' typecheck
```

## License

[MIT](LICENSE) © Vertio Solutions
