/**
 * ORM cookbook — write operations. Each entry is a real delegate call over the sample schema; the golden
 * is the exact runtime SurrealQL it produces. See `./_kit.ts` (the reference test re-runs every `def`).
 */
import { group, ormExample } from "./_kit";

export const writes = group(
  "writes",
  "create / insert / update / upsert / delete",
  [
    ormExample(import.meta.url, {
      title: "create — CONTENT payload (default ULID id, generated server-side)",
      sql: 'CREATE type::record(s"user", rand::ulid()) CONTENT $p0;',
      vars: {
        p0: {
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
      },
      def: (client) =>
        client.users.create({
          data: {
            name: "A",
            email: "a@x",
            age: 30,
            active: true,
            tags: [],
            address: { city: "SP" },
          },
        }),
    }),
    ormExample(import.meta.url, {
      title: "create — string id targets CREATE ONLY t:id",
      sql: "CREATE ONLY user:aeon CONTENT $p0;",
      vars: {
        p0: {
          id: "user:aeon",
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
      },
      def: (client) =>
        client.users.create({
          data: {
            id: "user:aeon",
            name: "A",
            email: "a@x",
            age: 30,
            active: true,
            tags: [],
            address: { city: "SP" },
          },
          only: true,
        }),
    }),
    ormExample(import.meta.url, {
      title: "createMany — batched creates",
      sql: 'BEGIN TRANSACTION;\nCREATE type::record(s"user", rand::ulid()) CONTENT $p0;\nCREATE type::record(s"user", rand::ulid()) CONTENT $p1;\nCOMMIT TRANSACTION;',
      vars: {
        p0: {
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
        p1: {
          name: "B",
          email: "b@x",
          age: 31,
          active: false,
          tags: [],
          address: { city: "SP" },
        },
      },
      def: (client) =>
        client.users.createMany({
          data: [
            {
              name: "A",
              email: "a@x",
              age: 30,
              active: true,
              tags: [],
              address: { city: "SP" },
            },
            {
              name: "B",
              email: "b@x",
              age: 31,
              active: false,
              tags: [],
              address: { city: "SP" },
            },
          ],
        }),
    }),
    ormExample(import.meta.url, {
      title: "create — idStrategy('uuid') generates a UUID v7 server-side",
      note: "`.idStrategy('uuid')` — no DDL, ORM-only; raw SQL keeps the server default.",
      sql: 'CREATE type::record(s"uuid_user", rand::uuid()) CONTENT $p0;',
      vars: { p0: { name: "A", email: "a@x" } },
      def: (client) =>
        client.uuidUsers.create({ data: { name: "A", email: "a@x" } }),
    }),
    ormExample(import.meta.url, {
      title: "create — idStrategy('rand') keeps the server default (rand::id())",
      sql: "CREATE rand_user CONTENT $p0;",
      vars: { p0: { name: "A" } },
      def: (client) => client.randUsers.create({ data: { name: "A" } }),
    }),
    ormExample(import.meta.url, {
      title: "upsert — generated id resolves the unique row, else creates (onMissing create)",
      note: "One statement: the subquery finds the existing row by UNIQUE, `??` falls back to the generated target.",
      sql: 'UPSERT ((SELECT VALUE id FROM uuid_user WHERE email = $p0 LIMIT 1)[0] ?? type::record(s"uuid_user", rand::uuid())) MERGE $p1;',
      vars: { p0: "a@x", p1: { email: "a@x", name: "A" } },
      def: (client) =>
        client.uuidUsers.upsert({
          where: { email: "a@x" },
          data: { email: "a@x", name: "A" },
          onMissing: "create",
        }),
    }),
    ormExample(import.meta.url, {
      title: "insert — onDuplicate ignore",
      sql: "INSERT IGNORE INTO user $p0;",
      vars: {
        p0: {
          id: "user:aeon",
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
      },
      def: (client) =>
        client.users.insert({
          data: {
            id: "user:aeon",
            name: "A",
            email: "a@x",
            age: 30,
            active: true,
            tags: [],
            address: { city: "SP" },
          },
          onDuplicate: "ignore",
        }),
    }),
    ormExample(import.meta.url, {
      title: "update — merge mode",
      sql: "UPDATE user:aeon MERGE $p0;",
      vars: { p0: { age: 31 } },
      def: (client) =>
        client.users.update({ where: { id: "user:aeon" }, data: { age: 31 } }),
    }),
    ormExample(import.meta.url, {
      title: "update — set mode with an expression",
      sql: "UPDATE user:aeon SET age = $p0;",
      vars: { p0: 31 },
      def: (client) =>
        client.users.update({
          where: { id: "user:aeon" },
          mode: "set",
          data: { age: 31 },
        }),
    }),
    ormExample(import.meta.url, {
      title: "updateMany — whole-table merge",
      sql: "UPDATE user MERGE $p0;",
      vars: { p0: { active: false } },
      def: (client) => client.users.updateMany({ data: { active: false } }),
    }),
    ormExample(import.meta.url, {
      title: "upsert — STRICT update over id (the default; a miss rejects ResultNotFound)",
      sql: "UPDATE ONLY user:aeon MERGE $p0;",
      vars: { p0: { age: 32 } },
      def: (client) =>
        client.users.upsert({ where: { id: "user:aeon" }, data: { age: 32 } }),
    }),
    ormExample(import.meta.url, {
      title: "upsert — insert-or-update over id (onMissing create)",
      sql: "UPSERT user:aeon MERGE $p0;",
      vars: { p0: { age: 32 } },
      def: (client) =>
        client.users.upsert({
          where: { id: "user:aeon" },
          data: { age: 32 },
          onMissing: "create",
        }),
    }),
    ormExample(import.meta.url, {
      title: "upsert — no target is a plain CREATE (idStrategy id)",
      note: "With neither `where` nor `data.id` the call is a plain create — the id comes from the table's `idStrategy`.",
      sql: 'CREATE type::record(s"user", rand::ulid()) CONTENT $p0;',
      vars: {
        p0: {
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
      },
      def: (client) =>
        client.users.upsert({
          data: {
            name: "A",
            email: "a@x",
            age: 30,
            active: true,
            tags: [],
            address: { city: "SP" },
          },
        }),
    }),
    ormExample(import.meta.url, {
      title: "upsert — data.id infers the STRICT id target",
      note: "`where` omitted: the payload `id` names the record and matches the MERGE target; a miss still rejects `ResultNotFound`.",
      sql: "UPDATE ONLY user:aeon MERGE $p0;",
      vars: { p0: { id: "user:aeon", age: 32 } },
      def: (client) =>
        client.users.upsert({ data: { id: "user:aeon", age: 32 } }),
    }),
    ormExample(import.meta.url, {
      title: "upsertDelta — create-or-update with the before/after envelope (onMissing create)",
      note: "ONE statement: `$before`/`$after` come from the same UPSERT, decoded into `record`/`before`/`delta`.",
      sql: "UPSERT user:aeon MERGE $p0 RETURN VALUE { before: $before, after: $after };",
      vars: { p0: { age: 32 } },
      def: (client) =>
        client.users.upsertDelta({
          where: { id: "user:aeon" },
          data: { age: 32 },
          onMissing: "create",
        }),
    }),
    ormExample(import.meta.url, {
      title: "upsertDelta — STRICT update never creates (the default)",
      note: "`onMissing: 'throw'` (the default) compiles `UPDATE ONLY`; a miss rejects `ResultNotFound`.",
      sql: "UPDATE ONLY user:aeon MERGE $p0 RETURN VALUE { before: $before, after: $after };",
      vars: { p0: { age: 33 } },
      def: (client) =>
        client.users.upsertDelta({
          where: { id: "user:aeon" },
          data: { age: 33 },
        }),
    }),
    ormExample(import.meta.url, {
      title: "upsertDelta — distinct create/update payloads (onMissing create)",
      note: "Distinct branches branch first (LET/IF) and envelope EACH branch in one transactional round-trip.",
      sql: "BEGIN TRANSACTION;\nLET $__existing = (SELECT VALUE id FROM user WHERE id = $p0 LIMIT 1);\nIF array::len($__existing) = 0 THEN CREATE user:aeon CONTENT $p1 RETURN VALUE { before: $before, after: $after } ELSE UPDATE $__existing[0] MERGE $p2 RETURN VALUE { before: $before, after: $after } END;\nCOMMIT TRANSACTION;",
      vars: {
        p0: "user:aeon",
        p1: {
          id: "user:aeon",
          name: "A",
          email: "a@x",
          age: 30,
          active: true,
          tags: [],
          address: { city: "SP" },
        },
        p2: { age: 31 },
      },
      def: (client) =>
        client.users.upsertDelta({
          where: { id: "user:aeon" },
          create: {
            id: "user:aeon",
            name: "A",
            email: "a@x",
            age: 30,
            active: true,
            tags: [],
            address: { city: "SP" },
          },
          update: { age: 31 },
          onMissing: "create",
        }),
    }),
    ormExample(import.meta.url, {
      title: "delete — RETURN BEFORE",
      sql: "DELETE user:aeon RETURN BEFORE;",
      vars: {},
      def: (client) => client.users.delete({ where: { id: "user:aeon" } }),
    }),
    ormExample(import.meta.url, {
      title: "deleteMany — explicit all:true",
      sql: "DELETE FROM user WHERE active = $p0 RETURN BEFORE;",
      vars: { p0: false },
      def: (client) => client.users.deleteMany({ where: { active: false } }),
    }),
  ],
);
