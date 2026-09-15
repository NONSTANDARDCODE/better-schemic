<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner.png" />
  <img alt="Schemic — schema-as-code for SurrealDB, in the Zod you already know" src=".github/assets/banner-light.png" />
</picture>

<br />

[Docs](https://schemic.dev) &nbsp;•&nbsp; [Drivers](#drivers) &nbsp;•&nbsp; [GitHub](https://github.com/schemichq/schemic)

[![npm](https://img.shields.io/npm/v/@schemic/cli)](https://www.npmjs.com/package/@schemic/cli) &nbsp; [![CI](https://github.com/schemichq/schemic/actions/workflows/ci.yml/badge.svg)](https://github.com/schemichq/schemic/actions/workflows/ci.yml) &nbsp; [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Schemic lets you define your database schema once in TypeScript — with the
**[Zod](https://zod.dev) API you already know** — and turns that single definition
into your database's native DDL, end-to-end types, and reviewable migrations.

The engine and CLI are **dialect-neutral**; **SurrealDB** is the supported
database driver. One source of truth — no separate ORM model, no code
generation, no drift.

## Drivers

- [`@schemic/surrealdb`](drivers/surrealdb#readme) — **SurrealDB**

## Packages

| Package | What it is |
| --- | --- |
| [`@schemic/core`](packages/core#readme) | The dialect-neutral engine: the `Driver` contract, the portable schema IR, and the migration / diff / snapshot engine. Zero dialect code. |
| [`@schemic/cli`](packages/cli#readme) | The `schemic` / `sc` binary — also dialect-neutral; loads the SurrealDB driver from `config.driver`. |
| [`@schemic/surrealdb`](drivers/surrealdb#readme) | The SurrealDB driver: connection, authoring, and SurrealQL DDL. |

## The workflow

Author your schema, then drive it from the dialect-neutral CLI (`sc` is the
short alias):

```bash
sc init        # scaffold a project: schemic.config.ts + schema + .env.example
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
bun --filter '@schemic/*' test       # run every package's tests
bun --filter '@schemic/*' typecheck
```

## License

[MIT](LICENSE) © Vertio Solutions
