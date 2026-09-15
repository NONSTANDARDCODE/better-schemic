# @better-schemic/cli

The command-line interface for [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) —
`better-schemic` (with the short alias `sc`) generates and runs schema migrations against
any database. It's **dialect-agnostic**: the CLI loads your database driver from
`better-schemic.config.ts`, so the same commands work whatever you're targeting.

## Install

Install the CLI alongside a driver:

```bash
bun add @better-schemic/cli @better-schemic/surrealdb
```

The CLI is dialect-neutral; the driver provides the authoring types and the DDL.
See [`@better-schemic/surrealdb`](../surrealdb#readme) for its exact peer deps and quickstart.

## Quick start

```bash
sc init                      # scaffold a SurrealDB project
```

`init` writes a `better-schemic.config.ts`, a sample schema, a seed stub, and
`.env.example`. From there:

```bash
sc gen add_users    # write a migration from your schema changes
sc migrate          # apply pending migrations
sc status           # show applied vs pending
```

## Commands

| Command | What it does |
| --- | --- |
| `init [--driver <name>]` | Scaffold a project — config, schema, seed, `.env.example`. |
| `gen [name]` | Write a migration from the schema diff. |
| `migrate [count]` | Apply pending migrations — all, the next N, or `--to <tag>` (alias: `up`). |
| `rollback [count]` | Revert applied migrations, newest first (alias: `down`). |
| `status` | Show applied vs pending migrations (`--json` for machine output). |
| `diff` | Preview pending changes without writing a migration (`--live` to compare against the database). |
| `push` | Apply the schema directly — no migration files (alias: `sync`). |
| `pull` | Introspect a live database back into your schema files. |
| `new <kind> <name>` | Scaffold a blank, hand-written migration. |
| `check` | Replay migrations in a throwaway engine to confirm they reproduce the schema. |
| `seed` | Run the project's seed script against a connection. |
| `doctor` | Print the resolved config and test the connection. |
| `snapshot reset` | Clear the migration snapshot. |
| `unlock` | Release a stale migration lock. |

Run `sc <command> --help` for flags. Support for some commands varies by driver
(e.g. `pull` and `diff --ts` are SurrealDB today) — see your driver's
`docs/COVERAGE.md`.

## Docs

Full guides, concepts, and reference live at
[docs](https://github.com/NONSTANDARDCODE/better-schemic). This package is part of the
[Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) toolkit.

## License

[MIT](./LICENSE) © Vertio Solutions
