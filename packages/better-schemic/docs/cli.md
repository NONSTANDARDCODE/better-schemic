# The CLI (`better-schemic` / `sc`)

The command-line interface for [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) —
`better-schemic` (with the short alias `sc`) generates and runs schema migrations against
SurrealDB. It ships **inside the `better-schemic` package**: the driver is built in, so there is
nothing to install separately and nothing to load at runtime.

## Install

```bash
bun add better-schemic
```

The binary comes with the package (`bunx better-schemic`, `npx better-schemic`, or the `db` script
the scaffolder writes).

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
| `init` | Scaffold a project — config, schema, seed, `.env.example`. |
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

Run `sc <command> --help` for flags.

## Docs

- The feature maps live in [`COVERAGE.md`](../COVERAGE.md) (schema/DDL) and
  [`ORM-COVERAGE.md`](../ORM-COVERAGE.md) (runtime ORM surface).
- Full guides live at [docs](https://github.com/NONSTANDARDCODE/better-schemic).
