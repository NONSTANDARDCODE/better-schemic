# Migrating to the single `better-schemic` package

Better-schemic used to ship **five** packages. It now ships **two**: the runtime
(`better-schemic`) and the scaffolder (`create-better-schemic`).

The split existed to keep a *pluggable driver* boundary. This project is SurrealDB-only, so the
boundary cost more than it bought: five manifests, five workspace pins, a five-package lockstep
release and a 20-line alias package — all to load a driver that was never going to be swapped.

Nothing about the **API** changed conceptually: the same authoring surface, the same CLI, the same
ORM. Only the **package names and import paths** moved.

## 1. Install

```bash
# before
bun add @better-schemic/cli @better-schemic/surrealdb zod

# after — ONE package. Zod and the SurrealDB SDK ship inside it.
bun add better-schemic
```

If you use the embedded engine for `better-schemic check`, keep the optional peer:

```bash
npm i -D @surrealdb/node
```

Zod is now a **dependency** of `better-schemic`, not a peer. `s.*` extends Zod's builders, so two
copies of Zod in one app break `instanceof` checks inside Zod. If your app also uses raw Zod,
import it from the package so you get the same copy:

```ts
import { z } from "better-schemic"; // the SAME zod instance the package uses
```

## 2. Rewrite the imports

| Before | After |
| --- | --- |
| `@better-schemic/surrealdb` | `better-schemic` |
| `@better-schemic/surrealdb/connection` | `better-schemic/connection` |
| `@better-schemic/surrealdb/query` | `better-schemic/query` |
| `@better-schemic/surrealdb/logger` | `better-schemic/logger` |
| `@better-schemic/surrealdb/orm` | `better-schemic/orm` |
| `@better-schemic/surrealdb/plugins/*` | `better-schemic/plugins/*` |
| `@better-schemic/surrealdb/driver` | `better-schemic/driver` |
| `@better-schemic/core/config` | `better-schemic/config` |
| `@better-schemic/core/authoring` | `better-schemic/authoring` |
| `@better-schemic/core/testing` | `better-schemic/testing` |
| `@better-schemic/core/driver` | `better-schemic/core/driver` |
| `@better-schemic/core` | `better-schemic/core` |
| `@better-schemic/cli` | `better-schemic` (the binary) |

A one-liner for the common case (the ordering matters — the longest specifier first):

```bash
# with ripgrep + sed:
rg -l '@better-schemic/surrealdb' -g '*.ts' . | xargs sed -i \
  -e 's#@better-schemic/surrealdb/plugins/#better-schemic/plugins/#g' \
  -e 's#@better-schemic/surrealdb/#better-schemic/#g' \
  -e 's#@better-schemic/surrealdb#better-schemic#g'
rg -l '@better-schemic/core' -g '*.ts' . | xargs sed -i \
  -e 's#@better-schemic/core/config#better-schemic/config#g' \
  -e 's#@better-schemic/core/authoring#better-schemic/authoring#g' \
  -e 's#@better-schemic/core/testing#better-schemic/testing#g' \
  -e 's#@better-schemic/core#better-schemic/core#g'
```

## 3. The CLI

`better-schemic` / `sc` still work exactly as before — the binary now lives in the runtime package
instead of the CLI package. Two flags are gone, because this build is SurrealDB-only:

- `sc init --driver <name>` — the driver is built in; `sc init` always scaffolds SurrealDB.
- `sc diff --driver <name>` — same.

`sc init` also no longer bootstraps a project through `create-better-schemic` when the driver is
missing: the driver is part of the package now, so it is always there.

## 4. The scaffolder

```bash
npm create better-schemic@latest
```

`--driver` is gone (there is only SurrealDB). The generated `package.json` now lists exactly one
dependency — `better-schemic` — instead of `@better-schemic/cli` + `@better-schemic/surrealdb` +
`zod` + `surrealdb`.

## 5. If you depended on the old packages directly

`@better-schemic/core`, `@better-schemic/cli` and `@better-schemic/surrealdb` are **deprecated** on
npm and point at `better-schemic`. They are not published anymore — migrate to the single package.

The engine that used to be `@better-schemic/core` is still there, as the `better-schemic/core`
subpath (the `Driver` contract, the portable schema IR, the diff/migration/snapshot engine). It is
an internal seam, not a supported public API — the supported surface is the authoring entry and the
purpose-based subpaths listed above.
