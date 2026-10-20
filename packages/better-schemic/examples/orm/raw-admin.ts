/**
 * ORM cookbook — raw escape hatches & admin/session. Each entry is a real delegate call over the sample
 * schema; the golden is the exact runtime SurrealQL it produces. See `./_kit.ts`.
 */
import { group, ormExample } from "./_kit";

export const rawAdmin = group(
  "raw-admin",
  "raw / query / unsafe / info / session",
  [
    ormExample(import.meta.url, {
      title: "raw — a tagged statement with a bound value",
      note: "The bound value becomes a parameter; the statement is the first (and only) one.",
      sql: "SELECT * FROM user WHERE age > $p0;",
      vars: { p0: 18 },
      def: (client) => client.$raw`SELECT * FROM user WHERE age > ${18}`,
    }),
    ormExample(import.meta.url, {
      title: "info — INFO FOR DB",
      sql: "INFO FOR DB;",
      vars: {},
      def: (client) => client.info("db"),
    }),
    ormExample(import.meta.url, {
      title: "ping — RETURN true round-trip",
      sql: "RETURN true;",
      vars: {},
      def: (client) => client.ping(),
    }),
  ],
);
