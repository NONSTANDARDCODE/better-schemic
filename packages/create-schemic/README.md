# create-schemic

Scaffold a new [Schemic](https://schemic.dev) project — `package.json`, `tsconfig.json`, a database
driver, and the `database/` schema — in one command.

```bash
npm create schemic@latest        # or: bun create schemic, pnpm create schemic
```

Interactive by default (project directory, driver, and whether/how to install). Flags:

```
create-schemic [directory] [--driver surrealdb] [--pm bun|npm|pnpm|yarn]
               [--no-install] [--no-git] [-y]
```

It writes the TS project envelope, optionally installs your chosen driver, then runs `schemic init`
to scaffold the config + `database/` schema. To add Schemic to an EXISTING project, use `schemic init`
directly.
