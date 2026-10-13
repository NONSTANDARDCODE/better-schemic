<div align="center">

# better-schemic

### One TypeScript schema. Real validation, real types, real DDL, real migrations, a real ORM — and they can never drift apart.

[Docs](https://github.com/NONSTANDARDCODE/better-schemic) &nbsp;•&nbsp; [Drivers](#drivers--packages) &nbsp;•&nbsp; [GitHub](https://github.com/NONSTANDARDCODE/better-schemic)

[![npm](https://img.shields.io/npm/v/@better-schemic/cli)](https://www.npmjs.com/package/@better-schemic/cli) &nbsp; [![CI](https://github.com/NONSTANDARDCODE/better-schemic/actions/workflows/ci.yml/badge.svg)](https://github.com/NONSTANDARDCODE/better-schemic/actions/workflows/ci.yml) &nbsp; [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) &nbsp; [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/NONSTANDARDCODE/better-schemic)

</div>

---

> [!NOTE]
> **better-schemic is a [SurrealDB](https://surrealdb.com)-only fork of [Schemic](https://github.com/schemichq/schemic).**
> The engine and CLI are still dialect-neutral — SurrealDB is simply the only driver shipped here.
> Forked from `schemic@720ada2`; the pre-fork history is preserved frozen in
> [`CHANGELOG_OLD.md`](./CHANGELOG_OLD.md).

## The problem

A single table usually lives in **four** places that quietly disagree:

| | you write | and then… |
| --- | --- | --- |
| 🗃️ **Database** | `DEFINE FIELD email … ASSERT string::is_email($value)` | …by hand, in a console, at 2am |
| 📄 **Migrations** | `ALTER TABLE … ADD CONSTRAINT` | …that nobody remembers to write |
| 🧩 **ORM model** | `email: z.string().email()` | …that drifts on the next deploy |
| 🌐 **API contract** | `interface User { email: string }` | …that is wrong by sprint three |

Four copies. Four chances to be wrong. No compiler can help you, because the truth is a string in a
migration file.

**better-schemic collapses them into one.** You declare the table once, in TypeScript, with the
**[Zod](https://zod.dev) API you already know** — and that single declaration *is* your validator,
your type source, your DDL and your query layer.

```
                    ┌───────────────────────────────────────┐
                    │  database/schema/tables/user.ts       │
                    │  export const User = defineTable(…)   │
                    └───────────────────┬───────────────────┘
                                        │
        ┌───────────────┬───────────────┼───────────────┬────────────────┐
        ▼               ▼               ▼               ▼                ▼
   ✅ validate      ✅ types         ✅ DDL          ✅ migrate        ✅ query
   .parse()         App<typeof User> DEFINE FIELD…   .surql file     client.users
```

---

## Install

```bash
bun add @better-schemic/cli @better-schemic/surrealdb zod
bunx better-schemic init        # or `npx …`, or `sc init` — the short alias
```

That is the whole setup. `init` writes `better-schemic.config.ts`, a sample schema, a seed stub and
`.env.example`. Point it at a SurrealDB and you're live:

```ts
// better-schemic.config.ts
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

---

## One schema. Four outputs.

This is the **only** schema in this README. Everything below — the validator, the types, the DDL,
the migration and the ORM calls — comes out of these 9 lines:

```ts
// database/schema/tables/user.ts
import { defineTable, s, surql } from "@better-schemic/surrealdb";

export const User = defineTable("user", {
  name: s.string().$min(1).$max(80),
  email: s.email(),
  role: s.string().$default("member"),
  tags: s.array(s.string()),
  createdAt: s.datetime().$default(surql`time::now()`).$readonly(),
})
  .index("user_email", ["email"], { unique: true })
  .schemafull();
```

> `s.*` is a drop-in for `z.*` — same builders, same chaining, same mental model. The difference is
> that every one of them also knows how to become SurrealQL.

### ① It validates

Because `s.*` **is** a Zod schema, you get the whole Zod API for free — at the edge, in tests, in a
seed script, anywhere:

```ts
User.fields.name.parse("Aeon");                        // → "Aeon"
User.fields.email.safeParse("aeon@nonstandard.dev");   // → { success: true,  data: "aeon@nonstandard.dev" }
User.fields.email.safeParse("not-an-email");           // → { success: false, error: ZodError }
User.fields.name.safeParse("x".repeat(81));            // → { success: false, error: ZodError }
```

And the **database** validates too — `$min`/`$max` are not just app-side, they bake into a real
`ASSERT` the server enforces on every write, from every client, forever (see [③](#-it-becomes-ddl)).

```ts
// The ORM runs the same codec before the statement leaves the process — a bad payload
// never reaches the wire:
await client.users.create({ data: { name: "Aeon", email: "nope", tags: [] } });
// BetterSchemicError: Validation failed at "email": Invalid email address   (code: "ValidationError")
```

### ② It types

```ts
import type { App, Create, Update } from "@better-schemic/surrealdb";
```

```ts
// A row coming back from the database — codecs already applied.
type Row = App<typeof User>;
//   { id: RecordId<"user", string>; name: string; email: string;
//     role: string; tags: string[]; createdAt: Date }        ← Date, not a string

// What you're allowed to send on create.
type NewUser = Create<typeof User>;
//   { id?: RecordId<"user", string>; name: string; email: string;
//     role?: string; tags: string[]; createdAt?: Date }
//                    ↑ required          ↑ DB-defaulted, so optional

// What you're allowed to send on update — `createdAt` is gone (READONLY), `id` is gone (immutable).
type UserPatch = Update<typeof User>;
//   { name?: string; email?: string; role?: string; tags?: string[] }
```

`App<>` is not a cast — it's the codec's own output type. `s.datetime()` gives you a `Date`;
`s.recordId(User)` gives you a `RecordId<"user">`; `s.uuid()` gives you a `string`. Refactor the
schema and the whole app follows, with no codegen step and nothing to remember.

### ③ It becomes DDL

Run `sc diff` and you get back real, reviewable SurrealQL — not a framework's idea of it:

```surql
DEFINE TABLE user TYPE NORMAL SCHEMAFULL;
DEFINE FIELD name ON TABLE user TYPE string ASSERT string::len($value) >= 1 AND string::len($value) <= 80;
DEFINE FIELD email ON TABLE user TYPE string ASSERT string::is_email($value);
DEFINE FIELD role ON TABLE user TYPE string DEFAULT "member";
DEFINE FIELD tags ON TABLE user TYPE array<string>;
DEFINE FIELD createdAt ON TABLE user TYPE datetime DEFAULT time::now() READONLY;
DEFINE INDEX user_email ON TABLE user FIELDS email UNIQUE;
```

`sc gen` writes it to `database/migrations/`, forward **and** reversible:

```surql
-- 20261013043706_add_users
-- Generated by @better-schemic/core. Review before applying.

IF $direction = "up" {
    DEFINE TABLE OVERWRITE user TYPE NORMAL SCHEMAFULL;
    DEFINE FIELD OVERWRITE name ON TABLE user TYPE string ASSERT string::len($value) >= 1 AND string::len($value) <= 80;
    DEFINE FIELD OVERWRITE email ON TABLE user TYPE string ASSERT string::is_email($value);
    DEFINE FIELD OVERWRITE role ON TABLE user TYPE string DEFAULT "member";
    DEFINE FIELD OVERWRITE tags ON TABLE user TYPE array<string>;
    DEFINE FIELD OVERWRITE createdAt ON TABLE user TYPE datetime DEFAULT time::now() READONLY;
    DEFINE INDEX OVERWRITE user_email ON TABLE user FIELDS email UNIQUE;
} ELSE {
    REMOVE INDEX IF EXISTS user_email ON TABLE user;
    REMOVE TABLE IF EXISTS user;
};
```

And when somebody hand-writes a `DEFINE` in a console at 2am, `sc pull` walks the live database back
into TypeScript — so the source of truth can always be restored.

```bash
sc diff      # what's changed vs the last snapshot   (--ts to see it as TypeScript)
sc gen       # write a reviewable, reversible .surql migration
sc migrate   # apply it
sc rollback  # revert it
sc check     # replay every migration in a throwaway engine — prove they reproduce the schema
sc pull      # introspect the live database back into TypeScript
```

### ④ It queries

Wrap the same schema in an ORM client and you get a delegate per table, typed from the schema,
compiling to **one parameterized statement** — no N+1, no stringly-typed query builder.

```ts
import { betterSchemic, createBetterSchemic, defineSchema } from "@better-schemic/surrealdb/orm";

const schema = defineSchema({ users: User });

const client = betterSchemic(existingSurreal, { schema });        // bring your own connection
// or:  const client = await createBetterSchemic({ url, namespace, database, schema });
```

```ts
await client.users.create({
  data: { name: "Aeon", email: "aeon@nonstandard.dev", tags: ["graph"] },
});
// CREATE type::record(s"user", rand::ulid()) CONTENT $p0;

await client.users.findMany({
  where: { role: "member" },
  select: { id: true, name: true },
  orderBy: [{ createdAt: "desc" }],
  limit: 20,
});
// SELECT id, name FROM user WHERE role = $p0 ORDER BY createdAt DESC LIMIT $p1;

await client.users.update({
  where: { email: "aeon@nonstandard.dev" },   // ← resolved through the UNIQUE index from ③
  data: { tags: ["graph", "db"] },
});
// UPDATE user MERGE $p1 WHERE email = $p0;
```

Every call is typed from the schema: `select` projects the result type, `where` only accepts real
columns and real operators, and a typo is a red squiggle, not a 500 at runtime.

> **Heads-up:** the inline `s.email().$unique()` shorthand emits the same DDL index, but the ORM's
> unique-target resolver only reads **table-level** `.index(…, { unique: true })` declarations — so
> `upsert`/`update` can target `email` here, and not with `$unique()`. Prefer the table-level form
> whenever the index is also a write target.

---

## And the good part: it's SurrealDB

A schema-as-code layer that only speaks tables would be a waste of this database. Everything below
is the *same* authoring API — no extra config, no plugin, no escape hatch.

### The graph is a type, not a traversal

```ts
import { defineRelation, defineTable, s } from "@better-schemic/surrealdb";

const Post = defineTable("post", {
  title: s.string(),
  author: s.recordId(User).$reference({ onDelete: "cascade" }),  // → record<user> REFERENCE ON DELETE CASCADE
});

const Likes = defineRelation("likes", { score: s.int().$min(0).$max(5) }).from(User).to(Post);

// The same declaration, two more delegates.
const schema = defineSchema({ users: User, posts: Post, likes: Likes });
```

```ts
// Edges have their own delegate — typed endpoints in, typed edges out.
await client.likes.relate({ from: "user:1", to: "post:1", data: { score: 5 } });
// RELATE user:1->likes->post:1 SET score = $p0;

await client.users.findMany({
  include: { likes: { where: { score: { gte: 4 } }, select: { title: true } } },
  where: { likes: { some: { score: { gte: 4 } } } },
});
// ONE round-trip:
//   SELECT *, (SELECT title FROM ->(likes WHERE score >= $p0)->post) AS likes FROM user
//     WHERE count(->(likes WHERE score >= $p1)->post) > 0;
```

### Vector search and full text, defined next to the field

```ts
import { defineAnalyzer, defineTable, s } from "@better-schemic/surrealdb";

export const english = defineAnalyzer("english")
  .tokenizers("blank")
  .filters("lowercase", "snowball(english)");

export const Doc = defineTable("doc", {
  content: s.string(),
  embedding: s.array(s.float()),
})
  .index("ft", ["content"], { fulltext: { analyzer: "english", highlights: true } })
  .index("vec", ["embedding"], { hnsw: { dimension: 1536, dist: "cosine" } });
```

```surql
DEFINE ANALYZER english TOKENIZERS BLANK FILTERS LOWERCASE, SNOWBALL(ENGLISH);
DEFINE INDEX ft ON TABLE doc FIELDS content FULLTEXT ANALYZER english HIGHLIGHTS;
DEFINE INDEX vec ON TABLE doc FIELDS embedding HNSW DIMENSION 1536 DIST COSINE;
```

The analyzer is emitted first — dependency order is handled for you.

### Permissions, views and access are part of the schema

```ts
defineTable("doc", { id: s.string() }).permissions({
  select: surql`true`,
  create: surql`$auth.id != NONE`,
  update: surql`$auth.id = id.owner`,
  delete: surql`$auth.admin = true`,
});
// DEFINE TABLE doc TYPE NORMAL SCHEMAFULL PERMISSIONS FOR select WHERE true FOR create …

defineView("adults", { name: s.string(), age: s.number() })
  .as(surql`SELECT name, age FROM user WHERE age >= 18`);
// DEFINE TABLE adults TYPE ANY SCHEMALESS AS SELECT name, age FROM user WHERE age >= 18;
// (typed rows in the app, zero DEFINE FIELD in the DB — SurrealDB keeps it in sync)

defineAccess("api").onDatabase().record().authenticate(surql`RETURN $auth`).duration({ session: "1d" });
// DEFINE ACCESS api ON DATABASE TYPE RECORD AUTHENTICATE { RETURN $auth } DURATION FOR SESSION 1d;
```

### Guardrails that ship as plugins, not tribal knowledge

```ts
import { recommended } from "@better-schemic/surrealdb/plugins/rules";
import { zod } from "@better-schemic/surrealdb/plugins/zod";
import { timestamps } from "@better-schemic/surrealdb/plugins/timestamps";
import { softDelete } from "@better-schemic/surrealdb/plugins/soft-delete";
import { tenantRls } from "@better-schemic/surrealdb/plugins/tenant";

const client = betterSchemic(db, {
  schema,
  plugins: [
    recommended({ maxLimit: 100 }),                       // no raw-unsafe, no unfiltered writes
    zod({ schemas: { user: z.object({ email: z.email() }) } }),
    timestamps(), softDelete({ deletedBy: "deletedBy" }), // audited, reversible soft delete
    tenantRls({ tenant: () => ctx.tenantId }),           // fail-closed multi-tenant scope
  ],
});
```

```ts
await client.customers.findMany({});                        // ✗ TenantRequired — no scope
await client.customers.$forTenant("user:abc").findMany({}); // ✓ scoped, tenant injected on write
```

### Transactions, live queries and changefeeds

```ts
const renamed = await client.transaction(async (tx) => {
  const user = await tx.users
    .update({
      where: { id: "user:1" },
      mode: "set",
      data: { name: surql`string::concat($value, "!")` },
      return: "after",
    })
    .throw();
  // UPDATE user:1 SET name = (string::concat($value, "!")) RETURN AFTER
  tx.afterCommit(() => mailer.send(user.email));   // outside effects, only after the commit
  return user;
});

const sub = await client.users.live({ where: { role: "member" }, diff: true }, (change) => {
  if (change.action === "UPDATE") cache.set(change.recordId, change.diff);
});
// LIVE SELECT DIFF FROM user WHERE role = $p0;
for await (const change of sub) { /* … */ }
await sub.kill();
```

### A query log you'd actually keep on

```ts
const client = betterSchemic(db, { schema, logger: true });   // or BETTER_SCHEMIC_LOG=1
```

```text
╭─ 🔍 findMany · user ─────────────────────────────╮
│ SELECT * FROM user                               │
│   WHERE role = $p0                               │
│ $p0 = "member"                                   │
╰─ 2 rows · 12.4ms · #1 · 14:03:22.881 ────────────╯
```

`explain: "slow"` renders the server's plan tree instead — full-scan warnings included.

---

## Drivers & Packages

| Package | What it is |
| --- | --- |
| [`@better-schemic/surrealdb`](drivers/surrealdb#readme) | **The driver.** `s.*` authoring, SurrealQL DDL, introspection, connection, the `/orm` client. |
| [`@better-schemic/core`](packages/core#readme) | The dialect-neutral engine: the `Driver` contract, the portable schema IR, and the diff / migration / snapshot engine. Zero dialect code. |
| [`@better-schemic/cli`](packages/cli#readme) | The `better-schemic` / `sc` binary — dialect-neutral; loads the SurrealDB driver from your config. |
| [`better-schemic`](packages/better-schemic#readme) | Alias package so `bunx better-schemic` / `npx better-schemic` just work. |
| [`create-better-schemic`](packages/create-better-schemic#readme) | The scaffolder behind `sc init`. |

The engine is driver-neutral by construction: a driver is just an implementation of the `Driver`
contract plus an authoring surface. The CLI contains **zero** dialect code — it loads whatever your
config points at.

---

## Status

**Alpha (`0.x`).** APIs may still change.

- [x] **SurrealDB** driver — [coverage](drivers/surrealdb/docs/COVERAGE.md) · [ORM coverage](drivers/surrealdb/docs/ORM-COVERAGE.md) · [verified examples](drivers/surrealdb/examples)
- [ ] More drivers (the contract is there; nobody has needed one yet)

## Development

A [Bun](https://bun.com) workspaces monorepo (`packages/*` + `drivers/*`).

```bash
bun install
bun --filter '@better-schemic/*' test        # run every package's tests
bun --filter '@better-schemic/*' typecheck
```

## License

[MIT](LICENSE) © NONSTANDARDCODE