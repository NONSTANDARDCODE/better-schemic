# create-better-schemic

Scaffold a new [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) project — `package.json`, `tsconfig.json`, and
the `database/` schema — in one command.

```bash
npm create better-schemic@latest        # or: bun create better-schemic, pnpm create better-schemic
```

Interactive by default (project directory and whether/how to install). Flags:

```
create-better-schemic [directory] [--pm bun|npm|pnpm|yarn]
               [--no-install] [--no-git] [-y]
```

It writes the TS project envelope, installs `better-schemic` (the ONE package: the authoring
surface, the engine and the CLI — Zod and the SurrealDB SDK ship inside it), then runs
`better-schemic init` to scaffold the config + `database/` schema. To add Better-schemic to an
EXISTING project, use `better-schemic init` directly.
