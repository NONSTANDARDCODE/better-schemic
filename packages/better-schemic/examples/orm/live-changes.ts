/**
 * ORM cookbook — live queries & changefeeds. Each entry is a real delegate call over the sample schema;
 * the golden is the exact runtime SurrealQL it produces. See `./_kit.ts`.
 */
import { group, ormExample } from "./_kit";

export const liveChanges = group("live-changes", "live / DIFF / SHOW CHANGES", [
  ormExample(import.meta.url, {
    title: "live — filtered subscription",
    sql: "LIVE SELECT * FROM user WHERE active = $p0;",
    vars: { p0: true },
    def: (client) => client.users.live({ where: { active: true } }),
  }),
  ormExample(import.meta.url, {
    title: "live — DIFF has no projection",
    sql: "LIVE SELECT DIFF FROM user;",
    vars: {},
    def: (client) => client.users.live({ diff: true }),
  }),
  ormExample(import.meta.url, {
    title: "changes — SHOW CHANGES for a table since a version",
    sql: "SHOW CHANGES FOR TABLE user SINCE 0;",
    vars: {},
    def: (client) => client.changes({ table: "users", since: 0 }),
  }),
]);
