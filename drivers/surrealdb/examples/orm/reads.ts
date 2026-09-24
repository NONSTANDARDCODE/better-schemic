/**
 * ORM cookbook — read operations. Each entry is a real delegate call over the sample schema; the golden
 * is the exact runtime SurrealQL it produces. See `../_kit.ts` (the reference test re-runs every `def`).
 */
import { group, ormExample } from "./_kit";

export const reads = group(
  "reads",
  "find* / projection / where / order / groups",
  [
    ormExample(import.meta.url, {
      title: "findMany — where + orderBy + limit",
      sql: "SELECT * FROM user WHERE active = $p0 ORDER BY age DESC LIMIT $p1;",
      vars: { p0: true, p1: 10 },
      def: (client) =>
        client.users.findMany({
          where: { active: true },
          orderBy: [{ age: "desc" }],
          limit: 10,
        }),
    }),
    ormExample(import.meta.url, {
      title: "findMany — select a projection",
      sql: "SELECT id, name FROM user;",
      def: (client) =>
        client.users.findMany({ select: { id: true, name: true } }),
    }),
    ormExample(import.meta.url, {
      title: "findMany — range targets the record range",
      sql: "SELECT * FROM user:1..100;",
      def: (client) =>
        client.users.findMany({ range: { start: "1", end: "100" } }),
    }),
    ormExample(import.meta.url, {
      title: "findFirst — LIMIT 1",
      sql: "SELECT * FROM user WHERE email = $p0 LIMIT $p1;",
      vars: { p0: "a@x", p1: 1 },
      def: (client) => client.users.findFirst({ where: { email: "a@x" } }),
    }),
    ormExample(import.meta.url, {
      title: "findUnique — id target uses FROM ONLY",
      sql: "SELECT * FROM ONLY user:aeon;",
      def: (client) => client.users.findUnique({ where: { id: "user:aeon" } }),
    }),
    ormExample(import.meta.url, {
      title: "count — GROUP ALL",
      sql: "SELECT count() FROM user WHERE active = $p0 GROUP ALL;",
      vars: { p0: true },
      def: (client) => client.users.count({ where: { active: true } }),
    }),
    ormExample(import.meta.url, {
      title: "exists — SELECT VALUE id LIMIT 1",
      sql: "SELECT VALUE id FROM user WHERE email = $p0 LIMIT $p1;",
      vars: { p0: "a@x", p1: 1 },
      def: (client) => client.users.exists({ where: { email: "a@x" } }),
    }),
    ormExample(import.meta.url, {
      title: "aggregate — groupBy + _count + avg",
      note: 'SurrealDB requires every groupBy key in the projection, so `active: "active"` is explicit.',
      sql: "SELECT active AS active, count() AS _count, math::mean(age) AS avgAge FROM user GROUP BY active;",
      def: (client) =>
        client.users.aggregate({
          select: { active: "active", _count: true, avgAge: { avg: "age" } },
          groupBy: ["active"],
        }),
    }),
    ormExample(import.meta.url, {
      title: "paginate — offset page with total",
      note: "Data and count ride ONE round-trip; the count is a second statement.",
      sql: "SELECT * FROM user WHERE active = $p0 LIMIT $p1;\nSELECT count() FROM user WHERE active = $p2 GROUP ALL;",
      vars: { p0: true, p1: 20, p2: true },
      def: (client) =>
        client.users.paginate({ where: { active: true }, limit: 20, start: 0 }),
    }),
    ormExample(import.meta.url, {
      title: "cursor — keyset after",
      note: "The probe fetches limit+1 rows so `hasNext` needs no extra query.",
      sql: "SELECT * FROM user WHERE (id > $c0) ORDER BY id ASC LIMIT $p0;",
      vars: { c0: "user:10", p0: 21 },
      def: (client) =>
        client.users.cursor({
          orderBy: [{ id: "asc" }],
          limit: 20,
          after: "user:10",
        }),
    }),
  ],
);
