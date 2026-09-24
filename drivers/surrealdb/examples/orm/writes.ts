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
      title: "create — CONTENT payload",
      sql: "CREATE user CONTENT $p0;",
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
      sql: "BEGIN TRANSACTION;\nCREATE user CONTENT $p0;\nCREATE user CONTENT $p1;\nCOMMIT TRANSACTION;",
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
      title: "upsert — insert-or-update over id",
      sql: "UPSERT user:aeon MERGE $p0;",
      vars: { p0: { age: 32 } },
      def: (client) =>
        client.users.upsert({ where: { id: "user:aeon" }, data: { age: 32 } }),
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
