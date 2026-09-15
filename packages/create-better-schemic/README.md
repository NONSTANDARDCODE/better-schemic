# create-better-schemic

Scaffold a new [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) project — `package.json`, `tsconfig.json`, a database
driver, and the `database/` schema — in one command.

```bash
npm create better-schemic@latest        # or: bun create better-schemic, pnpm create better-schemic
```

Interactive by default (project directory, driver, and whether/how to install). Flags:

```
create-better-schemic [directory] [--driver surrealdb] [--pm bun|npm|pnpm|yarn]
               [--no-install] [--no-git] [-y]
```

It writes the TS project envelope, optionally installs your chosen driver, then runs `better-schemic init`
to scaffold the config + `database/` schema. To add Better-schemic to an EXISTING project, use `better-schemic init`
directly.
