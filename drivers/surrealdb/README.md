# @better-schemic/surrealdb

The SurrealDB driver for [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) — author
your SurrealDB schema in TypeScript and generate SurrealQL DDL, types, and
migrations from that one definition.

- Define tables and relations with `s.*`, a drop-in for [Zod](https://zod.dev)'s `z.*`.
- Generate `DEFINE TABLE` / `DEFINE FIELD` DDL, run reviewable migrations, and introspect a live database back into TypeScript.
- Read and write rows as typed values via codecs (`datetime` ⇄ `Date`, `uuid`, record links, …).

## Install

```bash
bun add @better-schemic/cli @better-schemic/surrealdb zod
```

`zod` is a required peer. `@surrealdb/node` is an optional peer (the embedded
in-memory engine `better-schemic check` can replay into). The `surrealdb` SDK ships with
the driver — you only import it directly in seed or app query code.

## Quick start

Scaffold a project (`sc` is the short alias for `better-schemic`):

```bash
sc init
```

`init` writes a `better-schemic.config.ts`, a sample `user` schema, a seed stub, and
`.env.example`. The sample schema:

```ts
// database/schema/tables/user.ts
import { defineTable, s, surql } from "@better-schemic/surrealdb";

export const User = defineTable("user", {
  name: s.string().$assert(surql`string::len($value) > 0`),
  email: s.email().$unique(),
  createdAt: s.datetime().$default(surql`time::now()`).$readonly(),
}).schemafull();
```

…which generates this SurrealQL DDL (the `id` field is provided automatically):

```surql
DEFINE TABLE user TYPE NORMAL SCHEMAFULL;
DEFINE FIELD name ON TABLE user TYPE string ASSERT string::len($value) > 0;
DEFINE FIELD email ON TABLE user TYPE string ASSERT string::is_email($value);
DEFINE INDEX user_email_idx ON TABLE user FIELDS email UNIQUE;
DEFINE FIELD createdAt ON TABLE user TYPE datetime DEFAULT time::now() READONLY;
```

The connection lives in `better-schemic.config.ts` — a named connection from the
`surrealConnection` factory (no `driver:` string to keep in sync):

```ts
import { defineConfig } from "@better-schemic/core/config";
import { surrealConnection } from "@better-schemic/surrealdb/connection";

export default defineConfig({
  connections: {
    default: surrealConnection({
      schema: "./database/schema",
      url: process.env.SURREAL_URL ?? "ws://127.0.0.1:8000/rpc",
      namespace: process.env.SURREAL_NAMESPACE ?? "app",
      database: process.env.SURREAL_DATABASE ?? "app",
      username: process.env.SURREAL_USER,
      password: process.env.SURREAL_PASS,
      authLevel: "root", // "root" | "namespace" | "database"
    }),
  },
});
```

Then drive it from the CLI:

```bash
sc diff        # preview changes vs the last snapshot   (--ts for a TypeScript view)
sc gen         # write a migration for the pending change
sc migrate     # apply pending migrations
sc seed        # run database/seed.ts against a connection
sc status      # show applied vs pending migrations
sc pull        # introspect a live database back into TypeScript
```

## Reading & writing rows

A table definition carries codecs that bridge your app values and the database
wire format. `decode` turns a returned row into typed values (a `datetime`
becomes a `Date`, a `uuid` a string, record links resolve); `encode` and
`encodePartial` build the payloads you write back.

## The `/orm` client

The repository-style ORM lives at `@better-schemic/surrealdb/orm`. Declare the
schema once with `defineSchema` and wrap an existing (BYO) or managed connection:

```ts
import { defineTable, s } from "@better-schemic/surrealdb";
import { betterSchemic, createBetterSchemic, defineSchema } from "@better-schemic/surrealdb/orm";

const User = defineTable("user", {
  name: s.string(),
  email: s.string(),
  age: s.int(),
  tags: s.array(s.string()),
}).index("user_email", ["email"], { unique: true });

export const schema = defineSchema({ users: User, audit: "audit_log" });

const client = betterSchemic(existingSurreal, { schema });     // BYO: close() is a no-op
// or: const client = await createBetterSchemic({ url, namespace, database, auth, schema });

// Reads (M1) — one round-trip, decoded to app values (Date/RecordId/…):
const adults = await client.users.findMany({
  where: { age: { gte: 18 }, tags: { containsAny: ["db", "graph"] } },
  select: { id: true, name: true },
  orderBy: [{ age: "desc" }],
  limit: 20,
});

const user = await client.users.findUnique({ where: { email } }).throw();
const total = await client.users.count({ where: { age: { gte: 18 } } });
const byTag = await client.users.aggregate({
  select: { tags: "tags", _count: true, avgAge: { avg: "age" } },
  groupBy: ["tags"],
});
const page = await client.users.paginate({ orderBy: [{ id: "asc" }], limit: 20, start: 0 });
const next = await client.users.cursor({ limit: 20, after: "user:42" });

// Diagnostics without executing:
const plan = await client.users.findMany({ where: { age: 18 } }).explain();
```

`client.users.$model` is the delegate metadata; `client.repository("user")` looks
up by schema key OR physical name; `client.tables` lists the keys; `client.$sdk`
is the raw `surrealdb` connection (escape hatch).

**Status:** reads are complete (M1 — `findMany`/`findFirst`/`findOne`/`findUnique`/
`count`/`exists`/`aggregate`/`paginate`/`cursor`, `.throw()`, `.explain()`); writes,
relations, transactions, live queries and plugins land milestone by milestone — see
[`PLANO-QUERYS-TIPADAS.md`](../../PLANO-QUERYS-TIPADAS.md) and the live-verified
[`docs/orm-syntax-map.md`](docs/orm-syntax-map.md). Fragments & procedural SurrealQL
(`block()`) stay at `@better-schemic/surrealdb/query`.

## Docs

Full guides, concepts, and reference live at
[docs](https://github.com/NONSTANDARDCODE/better-schemic). For a
feature-by-feature map, see [docs/COVERAGE.md](docs/COVERAGE.md). This package is
part of the [Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) toolkit.

## License

[MIT](./LICENSE) © Vertio Solutions
