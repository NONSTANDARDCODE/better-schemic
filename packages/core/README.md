# @better-schemic/core

The dialect-neutral engine behind [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) — schema-as-code
for SurrealDB. It defines the **driver contract**, the **portable schema IR**, and the
**diff / migration / snapshot** engine that the CLI runs over the SurrealDB driver.

`@better-schemic/core` has **no authoring surface of its own** — you don't write schemas with it directly.
The SurrealDB driver provides that:

- [`@better-schemic/surrealdb`](../../drivers/surrealdb#readme) gives you the `s.*` authoring API and emits SurrealQL DDL.
- [`@better-schemic/cli`](../cli#readme) gives you the `better-schemic` / `sc` commands.

The CLI loads the driver from `better-schemic.config.ts` and orchestrates this engine generically — author →
diff → generate → migrate.

## When you touch it directly

Most projects depend on `@better-schemic/core` only transitively, through the CLI and a driver. The one
piece you import from it is the config helper:

```ts
import { defineConfig } from "@better-schemic/core/config";
// pair it with a connection factory from the driver
// (e.g. surrealConnection from @better-schemic/surrealdb)
```

With bun, npm, or yarn, `@better-schemic/core` is pulled in transitively (it's a dependency of the CLI and
every driver) — you don't install it directly. Under pnpm's strict `node_modules` the transitive copy
isn't reachable from your `better-schemic.config.ts`, so add it explicitly: `pnpm add @better-schemic/core`.

See your driver's README for the full `defineConfig({ connections: { … } })` setup.

## Docs

Guides, concepts, and reference live at [docs](https://github.com/NONSTANDARDCODE/better-schemic). This package is part of
the [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) toolkit.

## License

[MIT](./LICENSE) © Vertio Solutions
