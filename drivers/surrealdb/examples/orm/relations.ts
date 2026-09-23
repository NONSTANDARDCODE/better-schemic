/**
 * ORM cookbook — relations & graph. Each entry is a real delegate call over the sample schema; the golden
 * is the exact runtime SurrealQL it produces. See `./_kit.ts`.
 */
import { group, ormExample } from "./_kit";

export const relations = group(
  "relations",
  "include / edges / relational where / _count",
  [
    ormExample(import.meta.url, {
      title: "include — edge records via correlated subquery",
      sql: "SELECT *, (SELECT * FROM ->likes->post) AS likes FROM user;",
      vars: {},
      def: (client) => client.users.findMany({ include: { likes: true } }),
    }),
    ormExample(import.meta.url, {
      title: "include — same lowering for { target: true }",
      sql: "SELECT *, (SELECT * FROM ->likes->post) AS likes FROM user;",
      vars: {},
      def: (client) =>
        client.users.findMany({
          include: { likes: { target: true } },
        }),
    }),
    ormExample(import.meta.url, {
      title: "include — _count of adjacent links",
      sql: "SELECT *, count(->likes->post) AS _count_likes FROM user;",
      vars: {},
      def: (client) =>
        client.users.findMany({
          include: { _count: { select: { likes: true } } },
        }),
    }),
    ormExample(import.meta.url, {
      title: "relational where — some on an edge",
      sql: "SELECT * FROM user WHERE count(->(likes WHERE score > $p0)->post) > 0;",
      vars: { p0: 3 },
      def: (client) =>
        client.users.findMany({
          where: { likes: { some: { score: { gt: 3 } } } },
        }),
    }),
    ormExample(import.meta.url, {
      title: "relate — edge between two records",
      sql: "RELATE user:1->likes->post:1 SET score = $p0;",
      vars: { p0: 5 },
      def: (client) =>
        client.likes.relate({
          from: "user:1",
          to: "post:1",
          data: { score: 5 },
        }),
    }),
  ],
);
