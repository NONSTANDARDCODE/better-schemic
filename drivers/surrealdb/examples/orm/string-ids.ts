/**
 * ORM cookbook — string ids. The app speaks BARE id strings; the wire/DB gets `RecordId`s (the
 * emitted DDL is unchanged). See `./_kit.ts` (the reference test re-runs every `def`).
 */
import { group, ormExample } from "./_kit";

export const stringIds = group(
  "string-ids",
  "bare app strings <-> record<…> on the wire",
  [
    ormExample(import.meta.url, {
      title: "create — bare string refs encode to RecordId",
      sql: 'CREATE type::record(s"customer", rand::ulid()) CONTENT $p0;',
      vars: { p0: { name: "A", owner: "user:u1" } },
      def: (client) =>
        client.customers.create({ data: { name: "A", owner: "u1" } }),
    }),
    ormExample(import.meta.url, {
      title: "where — a bare string binds a RecordId",
      sql: "SELECT * FROM customer WHERE owner = $p0;",
      vars: { p0: "user:u1" },
      def: (client) => client.customers.findMany({ where: { owner: "u1" } }),
    }),
    ormExample(import.meta.url, {
      title: "cursor — a bare `after` binds a RecordId",
      sql: "SELECT * FROM customer WHERE (id > $c0) ORDER BY id ASC LIMIT $p0;",
      vars: { c0: "customer:c1", p0: 4 },
      def: (client) =>
        client.customers.cursor({
          after: "c1",
          orderBy: [{ id: "asc" }],
          limit: 3,
        }),
    }),
  ],
);
