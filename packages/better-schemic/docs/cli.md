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

| Command             | What it does                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `init`              | Scaffold a project — config, schema, seed, `.env.example`.                                      |
| `gen [name]`        | Write a migration from the schema diff.                                                         |
| `migrate [count]`   | Apply pending migrations — all, the next N, or `--to <tag>` (alias: `up`).                      |
| `rollback [count]`  | Revert applied migrations, newest first (alias: `down`).                                        |
| `status`            | Show applied vs pending migrations (`--json` for machine output).                               |
| `diff`              | Preview pending changes without writing a migration (`--live` to compare against the database). |
| `push`              | Apply the schema directly — no migration files (alias: `sync`).                                 |
| `pull`              | Introspect a live database back into your schema files.                                         |
| `new <kind> <name>` | Scaffold a blank, hand-written migration.                                                       |
| `check`             | Replay migrations in a throwaway engine to confirm they reproduce the schema.                   |
| `seed`              | Run the project's seed script against a connection.                                             |
| `doctor`            | Print the resolved config and test the connection.                                              |
| `snapshot reset`    | Clear the migration snapshot.                                                                   |
| `unlock`            | Release a stale migration lock.                                                                 |
| `generate`          | Run every generator declared in the config (`--only orm\|aot`, `--watch`).                      |
| `compile`           | AOT-compile `s.*` field schemas via zod-compiler (identity-preserving validators).               |
| `generate:orm`      | Generate a static-getter ORM facade from the schema (`bun build --compile --aot`).               |

Run `sc <command> --help` for flags.

### `generate` — declarative codegen

Put paths, aliases and tool conventions in `better-schemic.config.ts`; `sc generate` resolves the
project once and runs both generators. `sc generate:orm` and `sc compile` stay as single-generator
aliases (and keep accepting their flags). The old hidden `generate [name]` alias of `gen` was
removed — use `gen` to write migrations.

```ts
export default defineConfig({
  connections: { /* … */ },
  resolve: { alias: { "@": "./src", "@test": "./test" } },
  generators: {
    orm: {
      out: "src/db/generated/orm.generated.ts",
      schema: "./src/db/orm-schema.ts",
      schemaExport: "schema",
      provider: "./src/db/orm-provider.ts",
      client: "getOrmClient",
      surface: "orm",
    },
    aot: {
      out: ".better-schemic/schema.aot.ts",
      dir: ".better-schemic/aot",
      importIn: ["src/index.ts", "test/vitest.setup.ts"],
      installVia: "orm",
    },
  },
  generated: {
    tsNocheck: true,
    eslintDisable: true,
    knip: "ignore",
    knipAutoWrite: true,
    zodSpecifier: "better-schemic/zod",
  },
});
```

- Every path is relative to the project root; `--config` is still accepted.
- `resolve.alias` is applied to the CLI's jiti loader, so a schema importing `@/env` loads without a
  `node_modules/@` symlink. zod-compiler resolves imports with the app's tsconfig, so the same
  aliases must exist in `compilerOptions.paths`.
- `generated.tsNocheck`/`eslintDisable` prepend `// @ts-nocheck — generated` and
  `/* eslint-disable */` to every artifact (idempotent via the marker). Because entry points import
  the generated modules, `tsconfig.exclude` alone cannot hide them — the directive from inside the
  file is required.
- `generated.knipAutoWrite` merges `.better-schemic/**` + the artifact paths into an existing
  `knip.json` `ignore[]`, `tsconfig.json` `exclude[]`, `bunfig.toml` `[lint].ignorePatterns` and
  `.gitignore`. Leave it off to get the suggested patterns on stdout instead.
- `aot.installVia: "orm"` imports the AOT bootstrap from the generated facade, covering entry,
  tests and any other path that imports the ORM. `importIn` additionally inserts an idempotent
  side-effect import into the listed files.

### `generate:orm` — AOT-friendly ORM facade

The runtime client installs one delegate getter per schema key with `Object.defineProperty` in a
loop. Bun's AOT needs the getters **written in the source** to give them a fixed layout, so this
command reads the authored schema (the single source of truth) and emits the equivalent static
getters:

```sh
sc generate:orm \
  --out src/db/orm.generated.ts \
  --schema src/db/schema.ts \
  --provider-from ./orm-provider --client getOrmClient
```

The generated file imports `OrmSurface` from `better-schemic/orm` and ends with
`satisfies OrmSurface<typeof schema>`, so adding a model without regenerating fails `bun check`.
Options: `--schema-export <name>` (default `schema`), `--name <name>` (generated const, default
`orm`). Regenerate whenever the schema changes.

### `compile` — AOT validation via zod-compiler

`s.*` fields wrap Zod schemas, but zod-compiler's auto-discovery cannot see a Zod schema hidden
inside an exported `TableDef`. `sc compile` bridges that gap: it walks every authored field,
generates a synthetic module of raw Zod schemas, runs `zod-compiler generate`, and writes a
bootstrap module.

```sh
sc compile
# .better-schemic/aot/schemas.ts           synthetic exports of field.schema
# .better-schemic/aot/schemas.compiled.ts  static validators (generated by zod-compiler)
# .better-schemic/schema.aot.ts            import THIS instead of your schema module
```

The compiled module mutates the original schema objects in place (zod-compiler's
identity-preserving strategy), so emitted DDL, `.shape`, `instanceof`, `z.toJSONSchema()` and the
ORM are unchanged — only validation uses the generated fast path. The generated header is rewritten
from zod-compiler's hardcoded `from "zod"` / `from "zod/v4/core"` to `better-schemic/zod` /
`better-schemic/zod/core`, so the app does not need `zod` directly; opt out with
`generated.zodSpecifier: "zod"`. Options: `--out <file>`, `--dir <dir>`, `--sources-only` (write the
synthetic source without invoking zod-compiler).

For plain Zod schemas in the app (route contracts, DTOs), use `better-schemic/plugin`: a thin
wrapper around `zod-compiler/bun` for `Bun.build({ plugins: [betterSchemic()] })`, including
`--compile --aot` builds. The two are complementary: the plugin covers raw Zod, `sc compile`
covers authored fields.

## Docs

- The feature maps live in [`COVERAGE.md`](../COVERAGE.md) (schema/DDL) and
  [`ORM-COVERAGE.md`](../ORM-COVERAGE.md) (runtime ORM surface).
- Full guides live at [docs](https://github.com/NONSTANDARDCODE/better-schemic).
