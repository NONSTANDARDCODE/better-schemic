# @schemic/core

The dialect-neutral engine behind [Schemic](https://github.com/schemichq/schemic) — schema-as-code
for SurrealDB. It defines the **driver contract**, the **portable schema IR**, and the
**diff / migration / snapshot** engine that the CLI runs over the SurrealDB driver.

`@schemic/core` has **no authoring surface of its own** — you don't write schemas with it directly.
The SurrealDB driver provides that:

- [`@schemic/surrealdb`](../../drivers/surrealdb#readme) gives you the `s.*` authoring API and emits SurrealQL DDL.
- [`@schemic/cli`](../cli#readme) gives you the `schemic` / `sc` commands.

The CLI loads the driver from `schemic.config.ts` and orchestrates this engine generically — author →
diff → generate → migrate.

## When you touch it directly

Most projects depend on `@schemic/core` only transitively, through the CLI and a driver. The one
piece you import from it is the config helper:

```ts
import { defineConfig } from "@schemic/core/config";
// pair it with a connection factory from the driver
// (e.g. surrealConnection from @schemic/surrealdb)
```

With bun, npm, or yarn, `@schemic/core` is pulled in transitively (it's a dependency of the CLI and
every driver) — you don't install it directly. Under pnpm's strict `node_modules` the transitive copy
isn't reachable from your `schemic.config.ts`, so add it explicitly: `pnpm add @schemic/core`.

See your driver's README for the full `defineConfig({ connections: { … } })` setup.

## Docs

Guides, concepts, and reference live at [schemic.dev](https://schemic.dev). This package is part of
the [Schemic](https://github.com/schemichq/schemic) toolkit.

## License

[MIT](./LICENSE) © Vertio Solutions
