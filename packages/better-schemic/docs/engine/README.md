# The engine (`src/core`)

The dialect-neutral engine inside [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) —
schema-as-code for SurrealDB. It defines the **driver contract**, the **portable schema IR**, and the
**diff / migration / snapshot** engine the CLI runs over the SurrealDB driver.

The engine has **no authoring surface of its own** — you don't write schemas with it directly. The
SurrealDB half of the package provides that:

- [`better-schemic`](../../README.md) — the `s.*` authoring API, the SurrealQL DDL emitter and the
  `better-schemic` / `sc` commands.
- [`better-schemic/config`](../cli.md) — `defineConfig`, the project config.

The CLI orchestrates this engine generically — author → diff → generate → migrate.

## Is it public API?

**No.** The engine is an **internal seam** inside the `better-schemic` package (it used to be the
a separate package). It is still exported as `better-schemic/core` so the CLI, the
driver and the tests can share it, but it is **not** a supported surface: a change to it is not a
breaking change to the product. The supported surface is the authoring entry plus the
purpose-based subpaths (`/connection`, `/config`, `/orm`, `/query`, `/plugins/*`, `/logger`).

The one piece a project legitimately imports from the engine side is the config helper:

```ts
import { defineConfig, surrealConnection } from "better-schemic/config";
```

Both live in the same package as everything else — no extra install, no pnpm strict-`node_modules`
workaround.

## Docs

- [`MULTI-CONNECTION.md`](MULTI-CONNECTION.md) — how connections are declared and resolved.
- [`STRUCT-IR.md`](STRUCT-IR.md) — the portable schema IR.
- [`kind-registry.md`](kind-registry.md) — the kind registry the driver builds against.
- [`archive/`](archive/) — historical multi-driver design docs (not a guide).
