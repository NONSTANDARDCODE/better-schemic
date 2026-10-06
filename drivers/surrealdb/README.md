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

`$value` computes/coerces on write and is **create-optional by default** (`time::now()`, a total
derived from other fields). An expression that reads `$value` declares its intent — `{ optional:
false }` for a transform that requires client input, `{ optional: true }` when the DB may compute
it without input. A parent mapping can mark the nested keys it fills as optional PER ITEM:

```ts
export const Order = defineTable("order", {
  products: s
    .array(
      s.object({
        product: s.string(),
        quantity: s.int(),
        sellingPriceAtOrder: s.number(),
      }),
    )
    .$value(
      surql`$value.map(|$p| { RETURN { product: $p.product, quantity: $p.quantity, sellingPriceAtOrder: 1 } })`,
      { optional: true, computes: ["sellingPriceAtOrder"] },
    ),
});
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
const next = await client.users.cursor({
  select: { name: true },                      // keyset fields ride reserved `_keyset_<n>` aliases
  orderBy: [{ age: "desc" }, { id: "asc" }],   // ...read for the cursors and stripped from `data`
  limit: 20,
  after: { age: 30, id: "user:42" },
});
// Cursor values carry the STORED value (`s.datetime()` round-trips a `DateTime` with nanoseconds;
// `id` a `RecordId`) — never the codec-decoded app value, so `after`/`before` never lose precision.

// Writes (M2) — validated by the codec, one round-trip, decoded rows back:
const created = await client.users.create({
  data: { name: "Aeon", email: "aeon@x.dev", age: 30, tags: ["db"] },
});
const inserted = await client.users.insertMany({
  data: externalUsers,                          // ids in the payload
  onDuplicate: "update",                        // INSERT … ON DUPLICATE KEY UPDATE
});
const updated = await client.users
  .update({ where: { id: created.id }, data: { age: 31 } })   // never creates
  .throw();
const patched = await client.users.patch({
  where: { id: created.id },
  patches: [{ op: "replace", path: "/age", value: 32 }],
});
const upserted = await client.users.upsert({
  where: { email: "aeon@x.dev" },               // id or a single-field UNIQUE index
  data: { email: "aeon@x.dev", age: 33 },
  onMissing: "create",                          // STRICT by default: a miss rejects ResultNotFound
});
const { record, created, before, delta, changed } = await client.users.upsertDelta({
  where: { id: created.id },                    // or a UNIQUE field, or `data.id`, or omitted to create
  data: { age: 34 },
  onMissing: "create",                          // strict by default here too
});
// ONE statement, `RETURN VALUE { before, after }` — no read-then-write race. On a create
// `created: true` and `before`/`delta` are null; on an update `delta.old`/`delta.new` carry ONLY
// the changed fields as DECODED app values (server-computed for surql expressions), and
// `changed` names them. Both upserts are STRICT by default — a targeted miss rejects
// `ResultNotFound`; `onMissing: "create"` (above) restores create-or-update:
const strict = await client.users.upsert({
  where: { id: created.id },
  data: { age: 35 },                            // UPDATE ONLY — never creates, never resolves null
});
void before;
void delta;
void changed;
void strict;
const removed = await client.users.delete({ where: { id: created.id } });

// Created ids: every ORM create without an explicit `id` generates a ULID by default
// (`rand::ulid()` — 26 chars, time-sortable). Pick another strategy per table in authoring:
//   defineTable("user", { … }).idStrategy("uuid")   // rand::uuid() — UUID v7
//   defineTable("legacy", { … }).idStrategy("rand") // rand::id() — the server default (20 chars)
// An explicit `id` always wins and singleton tables keep their fixed id. The strategy is
// ORM-only: it emits NO DDL (migrations never diff), raw SQL keeps the server default, and
// `sc pull` cannot recover it. A pinned uuid v4/v6 `id` field is explicit-only: creates without
// an `id` fail at compile time (no strategy can generate that format).

// Edges live on the relation delegate (`defineRelation`):
// const like = await client.likes.relate({ from: "user:1", to: "post:1", data: { score: 5 } });
// await client.likes.unrelate({ from: "user:1", to: "post:1" });

// Relations & graphs (M3) — links (FETCH), edge traversal and `_count`, still ONE round-trip.
// Both examples need a `Post`/`Likes` pair in the schema; uncomment when you have one:
// const posts = await client.posts.findMany({
//   include: {
//     author: { select: { id: true, name: true } },          // FETCH or flat remount
//     likes: { where: { score: { gte: 4 } }, select: { title: true } }, // per-parent subquery
//     _count: { select: { likes: true } },                    // correlated count -> _count.likes
//   },
//   where: { likes: { some: { score: { gte: 4 } } } },        // relational filter
// });

// Transactions (M4) — `tx` is a full client bound to the managed transaction:
const from = await client.transaction(async (tx) => {
  const user = await tx.users
    .update({ where: { id: "user:1" }, mode: "set", data: { age: surql`age + 1` }, return: "after" })
    .throw();
  tx.afterCommit(() => mailer.send(user.email));   // outside effects only after the commit
  return user;
});

// Live queries (M4) — the ORM compiles the LIVE SELECT (typed where/select/fetch):
const sub = await client.users.live(
  { where: { active: true }, diff: true },
  (change) => {
    if (change.action === "UPDATE") cache.set(change.recordId, change.diff);
  },
);
// for await (const change of sub) { … }
await sub.kill();                                  // or: await client.kill(sub.uuid)

// Changefeeds (M4) — DEFINE TABLE t CHANGEFEED 1d (INCLUDE ORIGINAL for before/diff):
const sets = await client.changes({ table: "users", since: 0, limit: 100 });
for (const { versionstamp, changes } of sets) {
  for (const change of changes) {
    if (change.action === "DELETE") cache.delete(change.recordId);
  }
  void versionstamp;                               // paginate with `versionstamp + 1`
}

// Escape hatches & admin (M5) — parameterized by default:
const rows = await client.$raw<User[]>`SELECT * FROM users WHERE email = ${email}`;
const [users, posts] = await client.$query<[User[], Post[]]>`
  SELECT * FROM users LIMIT 10; SELECT * FROM posts LIMIT 10;
`;
// A curried tag carries options into the template form (e.g. under `raw.requireComment`):
// const seeded = await client.$raw({ meta: { comment: "seed" } })`CREATE …`;
const tier = await client.fn.call<string>("fn::customer_tier", [15000]);
// Typed shortcut per `defineFunction` (named args -> positional):
// const tier = await client.fn.customerTier({ total: 15000 });
const articles = await client.api.get<Article[]>("/articles", { query: { limit: 10 } });
const info = await client.info("db");              // INFO FOR DB
const dump = await client.export();
await client.import(dump);

// Multi-tenant scope (M5.3) — `USE NS … DB …;` per operation, no global state:
const tenantA = client.$withContext({ namespace: "tenant_a", database: "app" });
await tenantA.invoices.findMany({ where: { status: "open" } });
await tenantA.invoices.findMany({ context: { database: "analytics" } }); // per-call override
// `api`/`auth`/`export`/`live` are session-bound; fork a scoped session when you need them:
const scoped = await client.$withContext({ namespace: "tenant_a", database: "app", auth: token });

// Diagnostics without executing:
const plan = await client.users.findMany({ where: { age: 18 } }).explain();

// Observation hooks (M6) — logging/tracing around every operation, never mutating it:
const logged = betterSchemic(db, {
  schema,
  hooks: {
    beforeQuery: ({ table, operation, surql }) => logger.debug({ table, operation, surql }),
    afterQuery: ({ durationMs }) => metrics.timing("db.query", durationMs),
    onError: ({ error }) => logger.error({ err: error }),
  },
});

// Plugins (M6) — mutate operations, add typed args, extend the client/delegates:
import { definePlugin, surql } from "@better-schemic/surrealdb/orm";
const softDelete = definePlugin({
  id: "soft-delete",
  config: { column: "deletedAt" },
  operationArgs: { findMany: { deleted: "without" as "with" | "without" | "only" } },
  transform(op) {
    if (op.kind === "delete") { op.kind = "update"; op.data[this.config.column] = surql`time::now()`; }
    else if (op.kind.startsWith("find") && op.args.deleted !== "with") op.where[this.config.column] = { isNone: true };
  },
  extendModel({ model }) {
    return { restore: (args) => model.update({ where: args.where, mode: "set", data: { [this.config.column]: null } }) };
  },
});
// await client.users.findMany({ deleted: "with" });
// await client.users.delete({ where: { id } });   // soft delete
// await client.users.restore({ where: { id } });
```

Official F1 guardrail/validation plugins (M6.3) ship as subpaths:

```ts
import { recommended } from "@better-schemic/surrealdb/plugins/rules";
import { zod } from "@better-schemic/surrealdb/plugins/zod";
const client = betterSchemic(db, {
  schema,
  plugins: [
    recommended({ maxLimit: 100 }),            // noRawUnsafe + no unfiltered writes + required/max limit
    zod({ schemas: { user: z.object({ email: z.email() }) } }),
  ],
});
```

Official F2 plugins (M6.4) — timestamps + a reversible soft delete:

```ts
import { timestamps } from "@better-schemic/surrealdb/plugins/timestamps";
import { softDelete } from "@better-schemic/surrealdb/plugins/soft-delete";

const client = betterSchemic(db, {
  schema,
  plugins: [timestamps(), softDelete({ deletedBy: "deletedBy" })],
});
// create/update get `time::now()` stamped automatically (mode "app");
// delete becomes a soft delete and reads hide deleted rows unless `deleted: "with" | "only"`:
await client.users.delete({ where: { id }, meta: { actor: currentUserId } });
const live = await client.users.findMany({});                 // deleted rows hidden
const all  = await client.users.findMany({ deleted: "with" }); // include them
await client.users.restoreById(id);                            // clear deletedAt
```

Official F3 plugin (M10) — multi-tenant RLS: a schema PRESET (`tenant()`) plus a runtime plugin
(`tenantRls()`) for privileged sessions, where `$auth`/DDL permissions do not filter:

```ts
import { tenant, tenantRls } from "@better-schemic/surrealdb/plugins/tenant";

// Schema: one `.use(tenant(principal, options?))` per table — tenant column + per-op permissions +
// `{table}_protect_<column>` guard event + indexes (zero-diff with the hand-written recipe).
const User = defineTable("user", { name: s.string() });
const Customer = defineTable("customer", {
  name: s.string(),
  deletedAt: s.datetime().optional(),          // app-declared tombstone (softDelete: true)
}).use(tenant(User, { softDelete: true }));
const Order = defineTable("order", { total: s.number() })
  .use(tenant(User, { createOnly: true }));    // append-only: update = NONE

// Runtime: every tenant-tagged table requires a scope BEFORE compiling (fail-closed).
const client = betterSchemic(db, {
  schema: defineSchema({ users: User, customers: Customer, orders: Order }),
  plugins: [tenantRls({ tenant: () => ctx.tenantId })],
});
await client.customers.findMany({});                          // ✗ TenantRequired (no scope)
await client.customers.$forTenant("user:abc").findMany({});   // ✓ scoped to user:abc
await client.customers.$forTenant("user:abc").create({ data: { name: "A" } }); // tenant injected
await client.customers.$forTenant("user:abc").findUnique({ where: { id: "customer:1" } });
// ✓ reads are scoped too (id and single-field UNIQUE targets) — a cross-tenant id resolves null
await client.customers.$withoutPlugins().findMany({});        // explicit admin escape (audited)
```

### Beautiful query logging (M9)

Enable the built-in logger with one flag — a framed, syntax-highlighted box for every round-trip,
with timing, row counts and (optionally) the `EXPLAIN` plan tree:

```ts
const client = betterSchemic(db, { schema, logger: true });
// presets: "pretty" (default) | "compact" | "json" (log shippers) | "silent"
// await client.users.findMany({ where: { age: { gte: 18 } } });
// ╭─ 🔍 findMany · user ─────────────────────────────╮
// │ SELECT * FROM user                               │
// │   WHERE age >= $p0                               │
// │ $p0 = 18                                         │
// ╰─ 2 rows · 12.4ms · #1 · 14:03:22.881 ────────────╯
```

It observes the **executor** (reads, writes, `$raw`, `fn`, admin, changes, live — and `.explain()`
plans), never changing the operation:

```ts
const client = betterSchemic(db, {
  schema,
  logger: {
    slowMs: 50,          // mark slow queries (also gates `level: "info"`)
    explain: "slow",     // auto-EXPLAIN reads >= slowMs ("all" | "analyze" available)
    verbose: true,       // preview the first rows
    colors: "auto",      // honours NO_COLOR / FORCE_COLOR / TTY
  },
});

// .explain() / explain: true render the server plan as an operator tree:
// ╭─ 🔎 EXPLAIN findMany · user ─────────────────────────────────╮
// │ SELECT * FROM user WHERE age >= $p0                          │
// │ plan                                                         │
// │ SelectProject [ctx: Db, projections: *]                      │
// │ └─ TableScan [ctx: Db, table: user, direction: Forward] ⚠ full scan
// ╰─ 0.11ms · #2 ───────────────────────────────────────────────╯
```

Construct one explicitly (or use another preset) via the dedicated subpath, and enable it without
code with `BETTER_SCHEMIC_LOG=1|pretty|json` (`BETTER_SCHEMIC_LOG_LEVEL`, `BETTER_SCHEMIC_LOG_SLOW_MS`):

```ts
import { createQueryLogger } from "@better-schemic/surrealdb/logger";
const client = betterSchemic(db, { schema, logger: createQueryLogger({ format: "json" }) });
```


`client.users.$model` is the delegate metadata; `client.repository("user")` looks
up by schema key OR physical name; `client.tables` lists the keys; `client.$sdk`
is the raw `surrealdb` connection (escape hatch).

**Status:** the typed-query arc (M0–M7) is **complete** — reads (M1), writes (M2 —
`create`/`insert`/`update`/`patch`/`upsert`/`delete`/`updateEach` plus `relate`/`unrelate` on edge
delegates), relations/graphs (M3 — `include` links/edges/`_count`, relational `where`
`is`/`isNot`/`some`/`every`/`none`), transactions/live/changefeeds (M4 — `client.transaction` with
retries and `afterCommit`/`afterRollback`, `live()` + `LiveSubscription` with reconnect, `changes()`),
escape hatches/admin/context (M5 — `$raw`/`$query`/`$unsafe`, `fn`/`api`/`auth`/`info`/`version`/
`ping`/`export`/`import`, `$withContext` multi-tenant scoping with per-call `context`) and
plugins/hooks (M6 — observation `hooks`, `definePlugin` with transforms/typed `operationArgs`/
`extendClient`/`extendModel`, plus the official plugins `plugins/rules`, `plugins/zod`,
`plugins/timestamps`, `plugins/soft-delete` and `plugins/tenant`). M9 adds the built-in query logger
(`logger: true` / `@better-schemic/surrealdb/logger`) with `EXPLAIN` plan rendering.

The runtime surface is mapped exhaustively in [`docs/ORM-COVERAGE.md`](docs/ORM-COVERAGE.md), the
live-verified SurrealQL facts live in [`docs/orm-syntax-map.md`](docs/orm-syntax-map.md), the
milestone plan is in [`ROADMAP.md`](../../ROADMAP.md), and the verified examples are in
[`examples/`](examples) (authoring → DDL) and [`examples/orm/`](examples/orm) (delegate call →
runtime SurrealQL). Fragments & procedural SurrealQL (`block()`) stay at
`@better-schemic/surrealdb/query`.

## Docs

Full guides, concepts, and reference live at
[docs](https://github.com/NONSTANDARDCODE/better-schemic). Feature maps:
[docs/COVERAGE.md](docs/COVERAGE.md) (schema/DDL) and
[docs/ORM-COVERAGE.md](docs/ORM-COVERAGE.md) (runtime ORM surface); the live-verified SurrealQL the
ORM emits is [docs/orm-syntax-map.md](docs/orm-syntax-map.md), and the milestone plan is
[ROADMAP.md](../../ROADMAP.md). This package is part of the
[Better-schemic](https://github.com/NONSTANDARDCODE/better-schemic) toolkit.

## License

[MIT](./LICENSE) © Vertio Solutions
