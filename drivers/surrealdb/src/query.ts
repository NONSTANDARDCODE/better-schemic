/**
 * `@better-schemic/surrealdb/query` subpath entry — FRAGMENTS & procedural SurrealQL: `block()`,
 * the typed statement-block builder used by event `THEN`s, function bodies and `surql`
 * interpolation.
 *
 * The fluent table builder (`select`/`create`/`update`/`upsert`/`remove`/`relate`, the graph
 * traversal and the schemaless adapter) was retired in M0.5 in favor of the repository-style ORM
 * at `@better-schemic/surrealdb/orm` — `client.users.findMany({ where, select, include })` etc.
 * See `PLANO-QUERYS-TIPADAS.md`.
 */
export * from "./surql/block";
